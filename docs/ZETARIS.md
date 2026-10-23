# How the desk uses Zetaris

Zetaris is the only way the application reads data. The review agents never open a data file or connect to the bank database or the payments service: they send one SQL statement at a time to the Zetaris REST API, and Zetaris answers from the semantic layer.

## What is set up

| Source                                                                                         | Kind in Zetaris                                             | What it holds                                                                                    |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Public sanctions lists (OFAC and UN sample, 366 entries) and the approved business definitions | File-store tables over JSON files in the Zetaris file store | `list_entry`, `list_alias`, `list_dob`, `list_country`, `list_identifier`, `business_definition` |
| Synthetic bank database (Postgres container `bankdb`)                                          | JDBC data source with a **read-only** login                 | customers, identifiers, aliases, accounts, ownership register, alerts, earlier decisions         |
| Synthetic payments service (container `payments-api`)                                          | REST table, cached after creation                           | payments                                                                                         |

All three are joined into one **Unified Semantic Layer**, `lightning.metastore.sanctions.screening_usl`: 14 tables with keys, foreign keys, a description for every table and column, and data-quality rules. The agents read only those tables. The Evidence step reads the model's own description at the start of every run (`LOAD USL`) and builds one read-only tool per table from it; no table or column name is hard-coded in the tools.

## Data quality

Seven rules are registered on top of the rules that the foreign keys generate:

| Rule                          | Table            | Finds                                                |
| ----------------------------- | ---------------- | ---------------------------------------------------- |
| `dob_present_for_individuals` | customer         | individuals with no date of birth                    |
| `nationality_is_iso2`         | customer         | a nationality that is not an ISO 3166-1 country code |
| `ownership_pct_in_range`      | beneficial_owner | a percentage outside 0 to 100                        |
| `ownership_pct_present`       | beneficial_owner | a missing percentage                                 |
| `payment_amount_positive`     | payment          | an amount of zero or less                            |
| `counterparty_country_valid`  | payment          | a counterparty with no usable country                |
| `match_score_in_range`        | alert            | a score outside 0 to 1                               |

The Evidence step asks Zetaris which records fail these rules (`SHOW DQ INVALID RECORD ...`). A failing record can never support a close: the policy guard turns it into "need more information".

## Roles, identities and tokens

The application uses three **non-admin** identities, never the admin account, each with its own API token and its own table-level grants:

| Role                  | Identity used by        | Sees                                         |
| --------------------- | ----------------------- | -------------------------------------------- |
| `role_evidence_agent` | the review agents       | every model table; identifier numbers masked |
| `role_reviewer`       | people reviewing a case | every model table in full                    |
| `role_eval`           | evaluation runs         | read-only                                    |

`npm run zetaris:rebuild` creates the roles and the grants (and assigns the three users to them). The users are created through the REST endpoint `POST /users` (header `X-Org-ID`; there is no SQL to create a user):

```bash
npm run zetaris:agents -- --apply --passwords     # create agent_evidence, agent_reviewer, agent_eval at the GENERAL level
npm run zetaris:sql -- zetaris/sql/09_agents_create.sql --apply --skip-exists   # ASSIGN USER ... TO ROLE ...
```

The passwords are random, are never printed, and are written only to `.local/zetaris-agent-passwords.txt` (git-ignored, owner-only). The REST API issues an API token only to the signed-in user, so each token is created once in the interface:
1. Open the Zetaris interface (http://localhost:3000) and sign in as `agent_evidence@sanctions-desk.local` with its password from that file.
2. Open the API keys page of the profile menu, create a key, copy it into `.env` as `ZETARIS_TOKEN_EVIDENCE`. Sign out.
3. Repeat for `agent_reviewer@sanctions-desk.local` (`ZETARIS_TOKEN_REVIEWER`) and `agent_eval@sanctions-desk.local` (`ZETARIS_TOKEN_EVAL`).
4. Optionally, in the access-control screens, add a column policy that masks `customer_identifier.id_number` for `role_evidence_agent`.

Until a role has its own token, the adapter uses `ZETARIS_API_KEY` as a **labelled fallback**: every query record says `token_source: fallback`, and the decision trace shows it. The identifier numbers are masked by the adapter as well as by Zetaris (defence in depth), and a customer identifier is compared with a listed one by a join **inside Zetaris**, so the number is never read into the application.

## The SQL guard

A second layer in front of Zetaris, in our code, runs before every request: exactly one `SELECT` (or a `SHOW`/`LOAD USL`/`LIST DQ` for this model), no semicolon, no comments, no write or session keywords, no dangerous functions, and only the model's own activated tables. Zetaris itself rejects `SELECT 1; SELECT 2` with a parse error; the guard blocks it before sending, whatever Zetaris would do.

## Audit trail and query plans

- Every query carries its own id. Zetaris keeps a history of statements; `GET /cases/:alertId/trace?audit=true` matches each query of a recommendation with that history (same id, same statement, success). In a live run all of a case's queries matched.
- `docs/QUERY_PLANS.md` holds the `EXPLAIN` plans of the key queries (`npm run explain`).
- Our own append-only trace (`logs/trace-<run>.jsonl`) records the same ids, statements' hashes, row counts and latencies independently.

## Setup scripts

The scripts in `zetaris/sql/` are generated from one model specification (`packages/zetaris/src/usl-spec.ts`) and a test checks that they match it and that every table and column matches the data files one to one.

```bash
npm run zetaris:rebuild                     # place files, reset our objects, create everything in order
npm run zetaris:rebuild -- --files          # bank tables from the file-store copy instead of the database
npm run zetaris:sql -- zetaris/sql/07_dq_select.sql --apply --show    # run any script; without --apply it only lists
```

Only objects with our own names are touched (`sanctions_*`, `lightning.metastore.sanctions`). The bank database password and the payments key are filled in from the environment when a script runs and are not stored in it or in its log.

## Behaviour worth knowing

- A column named `precision` breaks a Zetaris model (it is stored with its quotes), so the date-of-birth precision column is called `dob_precision`.
- A cached REST table outlives the database it was created in; the reset script releases it first.
- Values come back as strings, with SQL NULL as null; the code casts explicitly.

## What this build does not offer

- **Column and row policies by SQL or REST**: not found (the API specification needs an administrator login and was not available to read). Table-level grants are SQL; masking, hiding and row filters are therefore described as interface steps above, and masking is also done in the adapter.
- **Automated PII classification**: no SQL statement or endpoint for it exists in this build.
- **MCP endpoint**: none is exposed, so the adapter uses REST only.
- **Lineage**: this application does not read Zetaris lineage; evidence is linked through query ids and the platform's statement history instead.
