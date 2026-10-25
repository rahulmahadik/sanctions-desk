# Governance

**This is a mapping, not a compliance claim.** It lists what the desk does under the headings of the Monetary Authority of Singapore's proposed Guidelines on AI Risk Management (consultation of November 2025), so that a reader can see where each control lives. It does not say the project complies with those guidelines or any other rule, the guideline text is not reproduced here, and the ratings are the project author's own assessment. The same content is served at `GET /governance` and shown on the Governance page of the review desk; everything on it comes from files and settings the project already holds.

## AI inventory entry

| Field            | Entry                                                                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Name             | Sanctions Desk                                                                                                                                                                                                                                               |
| Purpose          | Recommends an outcome for a bank sanctions-screening alert, with the evidence, for a person to decide                                                                                                                                                        |
| Status           | A prototype built for a hackathon; not in production                                                                                                                                                                                                         |
| Deployment       | Runs locally. Sample mode needs no external service                                                                                                                                                                                                          |
| Data             | Synthetic customers, payments and owners; real public sanctions-list entries (OFAC, UN)                                                                                                                                                                      |
| Models           | Nemotron 3 Ultra 550B (served in the cloud) and Nemotron 3.5 Lightning 30B (served locally), both through Meterless Nightshift. Nightshift's learned router decides which serves a call; the desk asks for a pinned mode and records the model that answered |
| Used by          | Decision, critic and challenger: Ultra in 187 of 190 calls of the headline run (3 by Lightning); safety guard and free-text screener: Lightning (70 of 70 safety-guard calls)                                                                                |
| Other components | Zetaris unified semantic layer (the only data path), Ollama (backup), the H-MEM, World Model and Markovian engines                                                                                                                                           |
| Policy           | Versioned; the active version is named in every decision record                                                                                                                                                                                              |

## Risk materiality (self-assessment)

| Dimension  | Rating         | Basis                                                                                                                                                                                   |
| ---------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Impact     | High           | A wrongly closed true match is a potential sanctions breach; a wrongly escalated alert costs analyst time                                                                               |
| Complexity | Medium to high | Several steps, two model sizes, a router the desk does not control, retrieval from a semantic layer, learned memory                                                                     |
| Reliance   | Medium         | A person decides every case while automatic closing is off (the default), but a clear recommendation with cited evidence can be accepted without independent analysis (automation bias) |

Conclusion: treated as material. The controls below apply to every recommendation.

## Human oversight

- The desk recommends. It never blocks an account, never writes to a source system and never contacts a customer. These limits are fixed in the policy schema (`autoBlock: false`, `messageCustomers: false`, `dataAccess: read_only`) and a policy draft that tries to change them is rejected.
- A recommended block needs two different approvers.
- An override that lowers caution to a close (from an escalation, a block or a request for more information) needs a second, different approver before it is final; declining escalates the case.
- The policy guard can only make an outcome more cautious.
- A close is challenged by a second model when confidence is low, the name is very close, or a data-quality rule fails.
- Text in the data that tries to instruct the reviewer is flagged, treated as data, and cannot close a case.
- Every risk signal from the free text at or above the policy threshold stops a close, grounded or not. Grounding (whether code found a term of the signal's type and a name from the evidence at the cited span, policy version 7) only adds context for the reviewer: a signal that is not grounded is kept, recorded with its reason and shown as a flag, and it still stops a close. Grounding can never remove a block. (A first version let ungrounded signals through; on held-out v3 that wrongly closed two risk cases, so the rule was changed to fail closed in policy version 8.)
- A note counts as documentary evidence only if the document number it cites is one of the customer's documents, checked by a count inside the data layer. When it is not, the reviewer sees "document cited in note not on customer record" and a close becomes a request for more information. When the check cannot be made, the note is not documentary.
- Free text is read locally, and the desk never puts it in a cloud prompt (Nightshift's own answer memory can add earlier answers, local ones included, to a cloud request; it was on during the recorded runs, so whether text read on the laptop reached the cloud that way cannot be checked for them, and it has been off since 24 Oct 2026 (30 receipts checked, none with an added memory; see MODELS.md)). A screener on the local model reads the customer note, the payment reference and the list remarks and returns structured facts: risk signals (a closed list of types, where in the text, a confidence) and documentary evidence that code validates against the policy's evidence standard. The decision, critic and challenger prompts carry those facts and never the text. A risk signal at or above the policy's threshold stops a close; a note counts as documentary only with a check reference, a document number and a date (and a named counterparty for a payment); a screener that cannot answer, did not read all of the text, or is missing never allows a close. A prompt that holds a note, reference or remark, or a 20-character run of one, is not sent, and the step fails closed. Names, aliases and the reasons a person wrote for earlier decisions are sent by design. What each model step was sent (field names, counts, a hash) is recorded, not the text. See "What leaves the machine, per step" in `docs/MODELS.md`.

### Oversight in proportion to risk

The more a mistake would cost, the more people are involved. A mistaken close is the costly one, so only a close can ever be made without waiting, and only under strict conditions. The policy's `autonomy` setting has two levels:
- **Level 0 (default; the headline exam runs here):** a person approves every alert.
- **Level 1:** a close is closed automatically only when code, the decision agent, the critic and the challenger all agree; the evidence standard is met; no data-quality rule fails; and the confidence is at least the policy's line. A random share of those (at least 5 percent) goes to a person as a quality-assurance sample, there is a daily cap, and a kill switch (an approver or a policy admin) forces level 0 at once. Each automatic close states "closed automatically under policy vX, level 1, conditions met: …", appears in a list for review, and can be reopened by an analyst.
- **Locked, whatever the level:** an escalation or a request for more information always goes to a person; a recommended block needs two different approvers; no automatic block; no message to a customer; read-only data access. These are fixed in the policy schema and a draft that tries to change them is rejected (tests: `packages/agents/test/autonomy.test.ts`).
- **Change control:** autonomy changes only through a draft, a preview on the exam (automatic closes, quality-assurance samples and false closes, which must be 0), and a publish by a different policy admin. Every step is in the audit log. The people, roles and four-eyes rules are described under [People, roles and the decision step](#people-roles-and-the-decision-step).

## Explainability

Each recommendation has a hash-sealed decision record and a trace that answers four questions: which approved definition applied, what data it rested on, who could see what, and what it cost. Every cited fact is re-read from the data by code before the critic's model sees it. A citation of a source that cannot be checked at all (a free-text column, the identifier number, a block worked out by code) is sent back once; from the second round on it is set aside as not citable, recorded in the trace and the record, and the remaining facts are checked. This ended a deadlock in which the same uncheckable citation was rejected in every round. A citation whose value does not hold is still a rejection. See `GET /cases/:alertId/trace`, `GET /cases/:alertId/record`, and the alert view and replay in the review desk.

## Testing

A 70-case exam, written from the approved definitions, with the system compared against a name-match rules baseline and against the deterministic pipeline on the same cases; a further held-out set of cases the rules were not written for. Results, confusion matrices and limits are in [../eval/REPORT.md](../eval/REPORT.md); the method is in [EVALUATION.md](EVALUATION.md). Labels changed after the first full run are listed in `eval/label-changes.json` and in the report.

## Monitoring

- The model ledger records, for every call, the mode asked for, the model that answered, reasoning budget, tokens, latency, cost and the signed receipt's verification status.
- The report gives the measured split of calls by serving model, the rate of answers that could not be used as JSON, and the calls that ended before any answer (provider failures) by mode asked for.
- `npm run check:roles` verifies each agent's access to the data; the API checks it at start-up.

## Change control

- A policy change is a draft, then a publish by a different person (four-eyes). A run keeps the version it started with, and every record names the version it used. The audit log lists every draft, publish and refusal.
- Exam labels that changed after the first full run are kept with the reason, and reports score against both sets.
- Code changes go through version control with tests and checks on each commit.

## Limits

- Synthetic data only; not tested on a bank's real alerts.
- Most decision and critic calls are answered by a cloud model. With real customer data, what may leave the machine would need an explicit decision.
- Fairness across name origins and languages is only partly measured (see [Responsible AI](#responsible-ai)).
- The exam's labels and the rules share the same definitions.
- The ratings above are a self-assessment.

## People, roles and the decision step

A person decides every alert unless the policy has switched on automatic closing for the certain cases. The roles are `analyst`, `approver` (a sanctions officer), `policy_admin` and `viewer`:

| Rule                                                                                                                                                                                                                                                          | Where it is enforced                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Every route except `/health` needs a person's bearer token once sign-in is on (the default live); tokens are stored only as SHA-256 hashes in a users file outside the repository (`npm run users:add`)                                                       | `apps/api/src/app.ts`, `packages/shared/src/auth.ts`         |
| A viewer is read-only; only an analyst or approver decides; only an approver gives the second approval of a block or overrides towards a less cautious outcome; only a policy admin publishes                                                                 | `PERMISSIONS` in `packages/shared/src/auth.ts`               |
| A decision needs a reason and names the sealed record it is about; an override names a different outcome                                                                                                                                                      | `packages/agents/src/human-decision.ts`                      |
| A recommended block needs a second, different approver and is only ever a recommendation for the sanctions officer                                                                                                                                            | the same file; the `block approval pending` ticket           |
| A policy change is a draft, previewed on the exam, then published by a different policy admin than the author; the author and approver come from the token, not from the request body                                                                         | `apps/api/src/routes/policy.ts`                              |
| The next action (closure note, escalation ticket, request-for-information draft, hold instruction) is prepared only after a decision, signed with an Ed25519 key kept outside the repository if one is set and otherwise labelled hash-sealed, and never sent | `packages/agents/src/actions.ts`                             |
| Every action, accepted or refused, is logged under the person's id; tokens never appear in logs                                                                                                                                                               | `logs/decisions/audit.jsonl`, `apps/api/test/people.test.ts` |

In sample mode, with no setup, three **demo users** (`analyst_demo`, `approver_demo`, `admin_demo`) can be chosen from a labelled switcher in the desk so a visitor can try the four-eyes rules; they never work against a live deployment. The user guide ([docs/USER_GUIDE.md](USER_GUIDE.md)) walks through the decision flow, autonomy and the case file.

**Autonomy** (`autonomy` in the policy): level 0, the default, has a person approve every alert. Level 1 closes a close automatically only when code, the decision agent, the critic and the challenger agree, the evidence standard is met, no data-quality rule fails and confidence is at least the policy's line; at least 5% of those go to a person at random, there is a daily cap, and a kill switch forces level 0 at once. Escalations, requests for information and blocks always go to a person; that is fixed in the policy schema. The headline exam runs at level 0; level 1 is previewed on the exam in Policy Studio.

## Policy

`config/policy.default.json` is the initial policy: lists and weights, name threshold, ownership threshold and depth, watched jurisdictions (a configurable example, to be checked against current sanctions programmes before use; each has place names that count when found in a payment reference; every action, `review`, `escalate` or `recommend_block`, escalates, and none switches a country off), automation limits, the critic's round limit and confidence floor, the mode and reasoning budget per step, the Zetaris role per step, the guard texts and patterns.

The hard limits are fixed in the policy schema, so no draft can lift them: no automatic block, no customer messages, read-only data access. The policy also holds the **documentary evidence standard**: a customer note or payment reference counts as documentary evidence only when it carries a check reference, a document number and a date (and, for a payment, a named counterparty). Anything less is a claim: it is shown to the reviewer but cannot clear a match, and a close that rests on it is raised to NEED_MORE_INFO by the policy guard. A note that meets the standard and states a date of birth supplies it when the customer has none on record. The standard was added in policy version 2, before the held-out run; see [docs/EVALUATION.md](EVALUATION.md#definition-changes).

A change is a draft, then a publish by a different person (four-eyes). A published version applies to the next run without a restart, every sealed decision record names the policy version it used, and `POST /policy/whatif` shows what a draft would change on the exam before anyone publishes it. Every version (draft, active, retired, discarded) is saved to `logs/policy/policies.json` and every audit entry is appended to `logs/policy/audit.jsonl`, so a policy version named in a record can still be looked up after a restart. Once that folder exists it is the starting point, not the policy file; delete it to start again from the file. (Changed after the recorded runs, 25 Oct 2026: before, versions and the audit log were kept in memory only.)

## Responsible AI

- **A person decides.** The desk recommends. Automatic closing is off by default and was off in every recorded run; a person makes the final call. It never blocks an account, never writes to a source system and never contacts a customer; those limits are fixed in the policy schema and cannot be lifted by a policy change. A recommended block needs two approvals.
- **Evidence you can check.** Every cited fact is re-read from the data by code before the critic's model sees it; a claim that does not match is never approved. Each recommendation has a sealed decision record and a trace that answers four questions: which approved definition applied, what data it rested on, who could see what, and what it cost.
- **Synthetic data only.** Customers, accounts, owners and payments are generated; only the listed parties are real public entries.
- **Memory without personal data.** Earlier decisions are remembered as an outcome, reason codes and a pointer to the row (table, key, content hash). The pointer is re-checked each time and goes stale when the listed entry changes; a memory can inform a decision but cannot close an alert on its own.
- **Least privilege.** Each agent can read only its own tables and columns; identifier numbers are masked by the application (see below); the model service receives only the masked form, never the clear number. Zetaris's HIDE policy for `customer_identifier.id_number` is configured for the evidence role, but this local edition does not enforce it. The application enforces it instead: the SQL guard stops every agent except the evidence step from naming the column, the evidence step's masking returns only the last two characters, and a customer identifier is compared with a listed one by a join inside Zetaris so the number is never read into the application. Tests prove each part (`packages/zetaris/test/guard.test.ts`, `client.test.ts`, `tools.test.ts`).
- **Fairness in name matching across languages.** What was measured: six transliteration cases across Cyrillic, Arabic and Han scripts, look-alike letters, accents, name order and spelling variants, and every one of those that carried real risk was escalated, none closed. What was not measured: other scripts and naming conventions, and how often common names in any one culture are escalated without cause. Name matching tends to raise more alerts for people whose names are common or transliterated in many ways, and the cost of that falls on those customers as extra review. Before any real use, measure the escalation rate by name origin and set the thresholds with that in mind.
- **Where the models run.** Most decision and critic calls are answered by a cloud model through Nightshift. That is acceptable for synthetic data; with real customer data it needs an explicit decision about what may leave the machine.
