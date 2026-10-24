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
| Used by          | Decision, critic and challenger (mostly Ultra); safety guard (mostly Lightning)                                                                                                                                                                              |
| Other components | Zetaris unified semantic layer (the only data path), Ollama (backup), the H-MEM, World Model and Markovian engines                                                                                                                                           |
| Policy           | Versioned; the active version is named in every decision record                                                                                                                                                                                              |

## Risk materiality (self-assessment)

| Dimension  | Rating         | Basis                                                                                                                                      |
| ---------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Impact     | High           | A wrongly closed true match is a potential sanctions breach; a wrongly escalated alert costs analyst time                                  |
| Complexity | Medium to high | Several steps, two model sizes, a router the desk does not control, retrieval from a semantic layer, learned memory                        |
| Reliance   | Medium         | A person decides every case, but a clear recommendation with cited evidence can be accepted without independent analysis (automation bias) |

Conclusion: treated as material. The controls below apply to every recommendation.

## Human oversight

- The desk recommends. It never blocks an account, never writes to a source system and never contacts a customer. These limits are fixed in the policy schema (`autoBlock: false`, `messageCustomers: false`, `dataAccess: read_only`) and a policy draft that tries to change them is rejected.
- A recommended block needs two different approvers.
- The policy guard can only make an outcome more cautious.
- A close is challenged by a second model when confidence is low, the name is very close, or a data-quality rule fails.
- Text in the data that tries to instruct the reviewer is flagged, treated as data, and cannot close a case.
- Every risk signal from the free text at or above the policy threshold stops a close, grounded or not. Grounding (whether code found a term of the signal's type and a name from the evidence at the cited span, policy version 7) only adds context for the reviewer: a signal that is not grounded is kept, recorded with its reason and shown as a flag, and it still stops a close. Grounding can never remove a block. (A first version let ungrounded signals through; on held-out v3 that wrongly closed two risk cases, so the rule was changed to fail closed in policy version 8.)
- A note counts as documentary evidence only if the document number it cites is one of the customer's documents, checked by a count inside the data layer. When it is not, the reviewer sees "document cited in note not on customer record" and a close becomes a request for more information. When the check cannot be made, the note is not documentary.
- Free text is read locally. A screener on the local model reads the customer note, the payment reference and the list remarks and returns structured facts: risk signals (a closed list of types, where in the text, a confidence) and documentary evidence that code validates against the policy's evidence standard. The decision, critic and challenger prompts carry those facts and never the text. A risk signal at or above the policy's threshold stops a close; a note counts as documentary only with a check reference, a document number and a date (and a named counterparty for a payment); a screener that cannot answer, did not read all of the text, or is missing never allows a close. A prompt that holds a note, reference or remark, or a 20-character run of one, is not sent, and the step fails closed. Names, aliases and the reasons a person wrote for earlier decisions are sent by design. What each model step was sent (field names, counts, a hash) is recorded, not the text. See "What leaves the machine, per step" in `docs/MODELS.md`.

### Oversight in proportion to risk

The more a mistake would cost, the more people are involved. A mistaken close is the costly one, so only a close can ever be made without waiting, and only under strict conditions. The policy's `autonomy` setting has two levels:
- **Level 0 (default; the headline exam runs here):** a person approves every alert.
- **Level 1:** a close is closed automatically only when code, the decision agent, the critic and the challenger all agree; the evidence standard is met; no data-quality rule fails; and the confidence is at least the policy's line. A random share of those (at least 5 percent) goes to a person as a quality-assurance sample, there is a daily cap, and a kill switch (an approver or a policy admin) forces level 0 at once. Each automatic close states "closed automatically under policy vX, level 1, conditions met: …", appears in a list for review, and can be reopened by an analyst.
- **Locked, whatever the level:** an escalation or a request for more information always goes to a person; a recommended block needs two different approvers; no automatic block; no message to a customer; read-only data access. These are fixed in the policy schema and a draft that tries to change them is rejected (tests: `packages/agents/test/autonomy.test.ts`).
- **Change control:** autonomy changes only through a draft, a preview on the exam (automatic closes, quality-assurance samples and false closes, which must be 0), and a publish by a different policy admin. Every step is in the audit log. The people, roles and four-eyes rules are described in the README.

## Explainability

Each recommendation has a hash-sealed decision record and a trace that answers four questions: which approved definition applied, what data it rested on, who could see what, and what it cost. Every cited fact is re-read from the data by code before the critic's model sees it. A citation of a source that cannot be checked at all (a free-text column, the identifier number, a block worked out by code) is sent back once; from the second round on it is set aside as not citable, recorded in the trace and the record, and the remaining facts are judged. This ended a deadlock in which the same uncheckable citation was rejected in every round. A citation whose value does not hold is still a rejection. See `GET /cases/:alertId/trace`, `GET /cases/:alertId/record`, and the alert view and replay in the review desk.

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
- Fairness across name origins and languages is only partly measured (see the README).
- The exam's labels and the rules share the same definitions.
- The ratings above are a self-assessment.
