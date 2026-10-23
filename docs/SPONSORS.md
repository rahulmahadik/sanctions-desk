# Sponsor technology: how sanctions-desk uses Zetaris, Meterless and NVIDIA Nemotron

Zetaris, Meterless and NVIDIA each do real work in sanctions-desk. This page says what each one does, where it sits in the code, and how to see it working, with commands you can run from a clone. Figures that depend on a run live in [the exam report](../eval/REPORT.md) and in the signed evidence under `eval/runs/`, and are not copied here, so they cannot drift.

## 1. Zetaris: the only way the desk reads data

**What it does.** Three kinds of source meet in one Unified Semantic Layer, `lightning.metastore.sanctions.screening_usl`, of 14 tables:

| Source                                                                            | How it was onboarded                                                     | Tables                                                                                                     |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Sanctions lists (OFAC and UN subset) and the approved business definitions        | JSON files in the Zetaris file store, registered as a Lightning database | `list_entry`, `list_alias`, `list_dob`, `list_country`, `list_identifier`, `business_definition`           |
| A Postgres bank database (customers, accounts, owners, alerts, earlier decisions) | JDBC data source with a read-only login                                  | `customer`, `customer_identifier`, `customer_alias`, `account`, `beneficial_owner`, `alert`, `disposition` |
| A payments service                                                                | REST data source, then `CACHE TABLE`                                     | `payment`                                                                                                  |

The agents never write SQL and never open a data file. Each reads the layer's own description at run time and gets one read-only tool per table. An SQL guard in our code allows one `SELECT` on the model's tables and, per agent, only that agent's tables and columns (`agentAccess` in the policy); every query record names the role and the credential it ran under, and its query id can be matched with Zetaris's own statement history (`GET /cases/:alertId/trace?audit=true`).

**What Zetaris does that matters to the result.**
- _Data quality_: eight rules are registered in Zetaris (`zetaris/sql/07_dq_create.sql`). A failing rule on a customer or payment record can never support a close; the real finding (individuals with no date of birth) changes decisions.
- _Definitions as data_: "true match", "false positive", "strong identifier", "counterparty match" and the ownership threshold are versioned rows in `business_definition`. Every decision cites the id and version it applied, and the policy guard stops automatic closes if the newest approved wording is not the one the code was reviewed against. A new version (`false_positive@2`, which adds the documentary evidence standard) was added as a new row; the old row was not edited.
- _Joins inside the layer_: whether a customer's identifier equals a listed one is computed inside Zetaris, so identifier numbers are not read into the application.
- _Least privilege_: three non-admin roles and users, per-role API tokens, identifier numbers hidden (the HIDE policy is configured for the evidence role but not enforced by this local edition, so the SQL guard and the masking enforce it, with tests), a start-up check that the roles can read the model (`npm run check:roles`).

**Zetaris checklist** (1a to 2c, with the file or command that proves each item) is at the top of [ZETARIS.md](ZETARIS.md#zetaris-checklist): sources and exploratory queries (`npm run zetaris:queries`), the full DDL and data-quality output (`npm run zetaris:usl`), a hand-coded equivalent with line counts (`npm run compare:hand-coded`), a forecast for a periodic KYC review project, and a requirement for Zetaris with a proposed syntax and a working mock (`npm run usl:policy -- --demo`). Known problems: [KNOWN_ISSUES.md](KNOWN_ISSUES.md).

**Check it.** `npm run check:roles`; `npm run zetaris:sql -- zetaris/sql/06_activate_select.sql --apply --show`; the Evidence screen of the review desk shows the rows, the masked columns and the data-quality results for any case.

## 2. Meterless engines: three, each in a working feature, each with a passing test

| Engine          | What it does in the product                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Where                                                                                                                                 | Test that proves it                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **H-MEM**       | Remembers each earlier decision, and each decision a person makes on the desk, as an outcome, reason codes and a pointer to the row it rested on (table, key, content hash, list snapshot), never as personal data. On recall the pointer is re-checked against the entry as it is now: a changed hash makes the memory stale. A later person's decision overrides an earlier one and the trust ledger records who and why. A decision can cite a memory as a fact, and the critic verifies the citation. | `packages/engines/src/hmem/`, `src/domain/pointer-memory.ts`; used by `packages/agents/src/memory.ts`                                 | `packages/engines/test/hmem.test.ts`, `pointer-memory.test.ts`, `packages/agents/test/analyst-memory.test.ts`; conformance 13/13 |
| **World Model** | Holds each company's ownership picture with provenance and validity dates; the 50 percent rule runs on it (chains multiply, listed owners add up, exactly the threshold counts, a missing percentage is unknown, loops end, a depth limit escalates).                                                                                                                                                                                                                                                     | `packages/engines/src/world-model/`, `src/domain/ownership.ts`; used by `packages/agents/src/ownership.ts`                            | `world-model.test.ts`, `ownership.test.ts`; conformance 8/8                                                                      |
| **Markovian**   | Re-screens earlier decisions after a list update, in bounded batches with a carried cursor: changed entries are re-opened, removed ones are offered to a person for release.                                                                                                                                                                                                                                                                                                                              | `packages/engines/src/markovian/`, `src/domain/rescreen.ts`; used by `packages/agents/src/list-change.ts`, `POST /list-change/replay` | `markovian.test.ts`, `rescreen.test.ts`; conformance 8/8                                                                         |

**The official conformance suites are in the repository** (`packages/engines/conformance/`, copied without change, Apache-2.0, see `NOTICE`) and run against our engines in `npm test` and in CI, so the scorecards need no other checkout: `npm run test:engines` prints **H-MEM 13/13, World Model 8/8, Markovian 8/8**.

## 3. Nightshift: every model call goes through it

One injected `generator` function asks Nightshift (an OpenAI-compatible runtime) first, the Ollama backup only if Nightshift cannot answer, and a labelled rules stand-in in sample mode only. Nothing else in the code names a provider. The calls carry a pinned mode (`meterless/fast`, `meterless/deep`, `meterless/judge`; `meterless/auto` is rejected), a token limit of our own, and a strict JSON schema so the answer cannot be cut off in reasoning text.

The desk sends its calls under **two app identities**, `sanctions-desk-guard` (the safety guard) and `sanctions-desk-reasoning` (decision, critic, challenger), chosen per step in the policy. The Nightshift cockpit can bind an app to a routing mode, and a bind overrides what the client asked for: with the guard bound to **local**, 24 of 24 guard calls were served by Nemotron 3.5 Lightning on a local laptop. The exact cockpit steps, and the measurements, are in [MODELS.md](MODELS.md#two-app-identities-and-what-the-cockpit-does-with-them) (lab results: `eval/routing-lab*.json`, from `npm run lab:routing`).

Every call records the mode asked for, the model that answered, the app identity, tokens, latency, cost under stated unit costs, and **Nightshift's signed receipt** (Ed25519). After a 429 the generator waits and sends the same request again before the step's own fallback (the fast mode, then Ollama) is used; if every try fails the case is escalated to a person with the reason, never closed.

## 4. NVIDIA Nemotron: where it contributes, and how to check which model answered

Two Nemotron models do the language work: **Nemotron 3 Ultra 550B** (served in the cloud) and **Nemotron 3.5 Lightning 30B** (served on a local laptop). The decision, the critic and the challenger are Ultra answers for the most part; the safety guard is Lightning, locally. The split is a measurement from the receipts, not a setting, and it is in the exam report and the README for each run.

**Check which model served each call, in three commands** (details in [the README](../README.md#check-which-model-served-each-call)):

```bash
npm ci
npm run evidence:verify                       # every signature, every call has a receipt, trace model = receipt model, the split per step
gunzip -c eval/runs/<run-id>/receipts.jsonl.gz | head -1     # one signed receipt: winning_route.model is the serving model
```

In the review desk, the routing panel of any case lists the Nemotron model that answered each step, the app it was sent under, time, tokens and cost, with a **Verify receipt** button that checks the signature and says what the receipt proves (`GET /receipts/:id/verify`).

How the two models compare on the decision step, with the router's choice stated, is in the report section "Which Nemotron model does what, and why" and in [MODELS.md](MODELS.md).

## 5. What is unique

- **The critic does not trust the decision.** Every cited fact is re-read from Zetaris by code, and a claim that does not match is never approved, whatever any model says. Earlier decisions are citeable the same way, and a tampered or stale one fails.
- **Memory holds pointers, not copies**, and goes stale the moment the listed entry changes.
- **Definitions are data in the semantic layer, versioned**, and the code refuses to close automatically when the approved wording moved.
- **Oversight in proportion to risk.** A person decides every alert by default; at level 1 only a close the code, the decision agent, the critic and the challenger all agree on may be closed without waiting, with a random quality-assurance sample, a daily cap and a kill switch. Escalations, requests for information and blocks always go to a person, and a block needs two different approvers. This is enforced in code and in the policy schema, and tested.
- **The hybrid.** Code gives a first finding from the structured fields; when it settles the case the agents confirm and explain it, and when it does not (free text, missing data) they reason over all of it. The path is recorded for every case and results are reported per path.
- **A model ledger with signed receipts**, so the claim "this Nemotron model answered this step" can be checked by anyone.
- **Honest evaluation.** The deterministic core is exact on the 70 rule-defined cases; the agents earn their place on the held-out set the rules were not written for, on explanations and on the checks. Both are reported, with the baselines, in [the report](../eval/REPORT.md).
