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

`npm run zetaris:rebuild` creates the roles and the grants and puts the three users in their roles. The users and their tokens are made by one command, which needs only the admin key:

```bash
npm run zetaris:agents                 # lists what it would do
npm run zetaris:agents -- --apply      # creates agent_evidence, agent_reviewer and agent_eval, assigns the roles, issues a token each
```

For each user it creates the account at the GENERAL level through `POST /users` (there is no SQL to create a user) with a random password that exists only in memory, assigns the role, signs in once through the web interface's own sign-in call, asks for an API key (`POST /auth/api-key`, valid 90 days) and writes it to `.env` as `ZETARIS_TOKEN_EVIDENCE`, `ZETARIS_TOKEN_REVIEWER` or `ZETARIS_TOKEN_EVAL`. Passwords and keys are never printed or logged. A password cannot be changed over REST (`PATCH /users/{email}` accepts the call and leaves the account unable to sign in), so a user whose password is unknown is dropped and created again.

Masking `customer_identifier.id_number` for `role_evidence_agent` is a setting in the Zetaris interface (access-control screens); there is no SQL or REST call for it.

Until a role has its own token, the adapter uses `ZETARIS_API_KEY` as a **labelled fallback**: every query record says `token_source: fallback`, and the decision trace shows it. The identifier numbers are masked by the adapter as well as by Zetaris (defence in depth), and a customer identifier is compared with a listed one by a join **inside Zetaris**, so the number is never read into the application.

## Unified Semantic Layer: build and reflection

What was built, what it measured, and what would have helped. Everything below comes from the live setup and the scripts in `zetaris/sql/`; counts were read with the read-only script `06_activate_select.sql` and the data-quality script `07_dq_select.sql` (`npm run zetaris:sql -- <script> --apply --show`).

### 1. Sources onboarded

| Source                                                           | How it was onboarded                                                                                                        | Tables in the model                                                                                        | Rows read through the model   |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Sanctions lists (OFAC, UN subset), approved business definitions | Files placed in the Zetaris file store (`sanctions/` folder) and registered as a Lightning database (`01_lists_create.sql`) | `list_entry`, `list_alias`, `list_dob`, `list_country`, `list_identifier`, `business_definition`           | 365, 1,334, 188, 759, 492, 5  |
| Synthetic bank database (Postgres, read-only login)              | JDBC data source (`03_bankdb_create.sql`)                                                                                   | `customer`, `customer_identifier`, `customer_alias`, `account`, `beneficial_owner`, `alert`, `disposition` | 305, 263, 47, 346, 21, 77, 13 |
| Synthetic payments service                                       | REST data source, then `CACHE TABLE` so repeated reads do not call the service again (`04_payments_create.sql`)             | `payment`                                                                                                  | 360                           |

Fourteen tables are compiled into one model, `lightning.metastore.sanctions.screening_usl`, in a single `COMPILE USL` statement (`05_usl_create.sql`) with primary keys, ten foreign-key groups, and a description for every table and column. The bank tables can also be built from file copies instead of the database (`npm run zetaris:rebuild -- --files`); the model and the agents are the same either way.

### 2. Real queries and the agent that uses each

The agents never write SQL: each reads the model's own description (`LOAD USL`) and gets one read-only tool per table. The plans for these are in [QUERY_PLANS.md](QUERY_PLANS.md).

| Query (shortened)                                                                                                                    | Used by                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SELECT alert_id, customer_id, entry_id, match_score FROM ...screening_usl.alert WHERE alert_id = 'ALR-0001'`                        | Evidence: reads the alert, then the customer, list entry, aliases, dates, countries and identifiers it points to                                                      |
| `SELECT ... FROM ...customer_identifier ci JOIN ...list_identifier li ON <normalised id numbers equal> ...`                          | Evidence and Matching: whether a customer identifier equals a listed one. The join runs inside Zetaris, so the identifier numbers are never read into the application |
| `SELECT ownership_id, owned_party_id, owner_party_id, ownership_pct FROM ...beneficial_owner WHERE owned_party_id IN (...)`          | Ownership: reads the register one level at a time; the ownership engine adds up the percentages                                                                       |
| `SELECT p.customer_id, COUNT(*), SUM(p.amount) FROM ...payment p WHERE p.status = 'pending' AND p.customer_id IN (...) GROUP BY ...` | List-change replay: how many pending payments the affected customers have                                                                                             |

### 3. Data quality

Eight rules are registered on top of the generated foreign-key rules (`07_dq_create.sql`). The last full run found:

| Rule                                                                                                        | Table            | Rows | Valid | Invalid |
| ----------------------------------------------------------------------------------------------------------- | ---------------- | ---- | ----- | ------- |
| `dob_present_for_individuals`                                                                               | customer         | 305  | 302   | **3**   |
| `nationality_is_iso2`                                                                                       | customer         | 305  | 304   | 1       |
| `ownership_pct_present`                                                                                     | beneficial_owner | 21   | 20    | 1       |
| `counterparty_country_valid`                                                                                | payment          | 360  | 359   | 1       |
| `ownership_pct_in_range`, `payment_amount_positive`, `payment_bank_countries_valid`, `match_score_in_range` |                  |      | all   | 0       |

The real finding: three individual customers have no date of birth (for example CUST-0020), and `SHOW DQ ALL INVALID` returns those records. The Evidence step reads the failing records for the customer and payment in the case. A failing rule on the customer's record can never support a close: the policy guard turns a close into **NEED_MORE_INFO** and caps confidence at 0.6. A missing ownership percentage is "unknown", not zero, and also ends in NEED_MORE_INFO. The exam covers both (`md_no_dob_*`, `ob_missing_pct`).

### 4. Roles, grants and masking

Three roles each hold `SELECT` on every table of the model and nothing else (`08_access_create.sql`): `role_evidence_agent` (all agents), `role_reviewer` (people), `role_eval` (evaluation runs). Three non-admin users, one per role, are created through REST and assigned with `ASSIGN USER` (`09_agents_create.sql`). Identifier numbers are masked for the agents by the adapter (the column is marked sensitive in the model description and replaced by a mask before any value leaves the adapter); a Zetaris column policy on `customer_identifier.id_number` is an interface step (see above). Each query record says which role ran it and whether it used its own token or the labelled fallback.

### 5. Effort compared with hand-written joins

Measured: the Evidence, Matching, Ownership and Memory steps read through ten generated tools plus the hand-written identifier join; the list-change replay adds a few hand-written read queries. The application contains no per-table SQL for the other tables. Adding a table or column to the model changes the tools without code changes, and a test checks that the model, the setup scripts and the data files agree table by table and column by column. Not measured: elapsed time against a hand-written alternative. We did not build one, so no time-saving figure is claimed.

### 6. Why this helps real compliance work

- **One set of definitions.** "True match", "false positive", "strong identifier" and the ownership threshold are rows in `business_definition`, versioned and read by every agent. A decision cites the id and version, and the guard stops automatic closes if the wording changed and the code was not reviewed for it.
- **An audit trail that does not depend on the application.** Every query has an id that can be matched with Zetaris's own statement history.
- **Least privilege for agents.** Separate non-admin identities, read-only grants, masked identifiers, and a second guard in our code that allows one `SELECT` on the model's tables.

### 7. How Zetaris could improve

From building this:
- **Masking and row filters.** No SQL statement or REST endpoint for column or row policies was found; they appear to be interface-only, which makes them hard to keep in a repeatable script.
- **Users and tokens.** There is no `CREATE USER` in SQL; users are created with `POST /users`. A token is issued through the interface's own sign-in and `POST /auth/api-key` calls, which works but is not documented, and a password cannot be changed over REST. The tokens then could not read the model's tables (see "Access control" above), which is the larger gap.
- **API specification.** The OpenAPI document needs an administrator login that the API key does not satisfy; a read-only role for it would help.
- **Values as strings.** Every value returns as a string, so each query casts explicitly.
- **Reserved words.** A column named `precision` is stored with its quotes and breaks the model; a clear error at compile time would have saved time.
- **Cached tables outlive their database.** A cached REST table survived `DROP DATABASE` and had to be released first.
- **No MCP endpoint or lineage read**, so the adapter uses REST and the statement history only.

### Access control

The three runtime users read the model with their own tokens. Getting there needed four settings that exist only in the Zetaris interface, and that a rebuild of the model partly undoes:
1. **Management → Permissions:** give `ROLE_EVIDENCE_AGENT`, `ROLE_REVIEWER` and `ROLE_EVAL` the **View** permission on **Unified Semantic Layer**. Without it every read fails with `User '...' does not have access to USL: metastore.sanctions.<table>`, whatever grants exist; this was the missing step.
2. **Data Product → Unified Semantic Layer → the namespace (`sanctions`) → Access Control:** assign the three roles.
3. **The model (`screening_usl`) → Access Control:** assign the three roles and tick `SELECT` on all 14 tables.
4. **`customer_identifier` → Column Access:** a policy that sets `id_number` to HIDE for `ROLE_EVIDENCE_AGENT` only. This edition offers GRANT, DENY and HIDE for columns of a model table, and no pattern mask such as `******56`.

**A rebuild resets steps 2 and 3.** The access list belongs to the model's internal id, and rebuilding creates a new model with an empty list; the role-level permission in step 1 stays. Earlier failures came from access set on a model that was then rebuilt. The roles' SQL grants (`08_access_create.sql`) are re-applied by the rebuild, but the Access Control list is not.

**It cannot be scripted.** In sections 20 and 21 of the Lightning SQL command reference, `LIST ... FOR`, `ASSIGN` and `REVOKE` accept data sources, databases, data marts, pipelines and streaming sources but not a Unified Semantic Layer, and there is no REST call. `GRANT SELECT ON USL TABLE` writes a different store from the one the check reads, so it does not help. The steps above are therefore the documented procedure, and the repository checks the result instead:
- `npm run check:roles` makes each identity read the model with its own token and exits with an error naming who is refused and the four steps above. `npm run zetaris:rebuild` runs it last.
- **The API checks at start-up.** A live run (not sample mode) with role tokens reads the model once as each identity. If one is refused, the API logs the steps and does not start. Set `zetaris.requireRoleAccess` to `false` to turn this off.
- **No admin fallback by default.** `zetaris.fallbackOnDenied` is `false`: a refused role token is an error. Setting it to `true` retries once with the admin key, visibly (`token_source: fallback`), which is useful only while access is being set up.

Do not run `npm run zetaris:agents -- --apply` after the access is set: it drops and recreates the users and discards what was assigned to them.

#### Checks on the development instance

`npm run test:live` (`packages/zetaris/test/live/roles.live.test.ts`) runs raw REST calls, bypassing the application's own guard on purpose. Last result: 13 checks pass and one is an expected failure.

| Check                           | evidence                                             | reviewer | eval     |
| ------------------------------- | ---------------------------------------------------- | -------- | -------- |
| Signs in with its own token     | yes                                                  | yes      | yes      |
| Reads every table of the model  | yes                                                  | yes      | yes      |
| `CREATE`, `DROP`, `GRANT`       | refused: "User is not permitted to run this command" | refused  | refused  |
| Reads a table outside the model | refused                                              | refused  | refused  |
| `id_number` in clear            | **still returned**                                   | returned | returned |

The one gap is the column policy: with HIDE set for the evidence role, a `SELECT id_number` through that role's token still returns the clear value on this instance. The test for it is written the way it should behave and marked as an expected failure, so it starts failing when the platform enforces the policy. Until then the application hides the number itself: the evidence step masks it in the adapter (it comes back as `******56`), a customer identifier is compared with a listed one by a join inside Zetaris so the number is never read into the application, and the interface draws it as `••••`. If the platform starts enforcing HIDE, that join (which names `id_number`) must run under a role that may see the column; check it then.

### Each agent keeps its own allow-list

Whatever credential answers, our SQL guard first limits each agent to the tables and columns the policy gives it (`agentAccess` in `config/policy.default.json`): the evidence step reads the model's tables, the ownership step only the ownership register, the critic only the tables it re-reads cited facts from, and the steps that read no data (triage, matching, decision, challenger, policy guard, reporter) get none. Except for the evidence step, no agent may name the `id_number` column. A query outside an agent's scope is blocked before anything is sent and recorded as `agent_scope`. This is the application's check and is tested (`packages/zetaris/test/client.test.ts`); the platform's own limits now apply as well.

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

- **Column and row policies by SQL or REST**: not found (the OpenAPI document needs an administrator sign-in with a password, which the API key does not satisfy). Table-level grants are SQL; masking, hiding and row filters are therefore described as interface steps above, and masking is also done in the adapter.
- **Automated PII classification**: no SQL statement or endpoint for it exists in this build.
- **MCP endpoint**: none is exposed, so the adapter uses REST only.
- **Lineage**: this application does not read Zetaris lineage; evidence is linked through query ids and the platform's statement history instead.
