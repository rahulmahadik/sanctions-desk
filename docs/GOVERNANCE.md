# Governance

**This is a mapping, not a compliance claim.** It lists what the desk does under the headings of the Monetary Authority of Singapore's proposed Guidelines on AI Risk Management (consultation of November 2025), so that a reader can see where each control lives. It does not say the project complies with those guidelines or any other rule, the guideline text is not reproduced here, and the ratings are the project author's own assessment. The same content is served at `GET /governance` and shown on the Governance page of the review desk; everything on it comes from files and settings the project already holds.

## AI inventory entry

| Field            | Entry                                                                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Name             | sanctions-desk                                                                                                                                                                                                                                               |
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
- A recommended block needs two approvals.
- The policy guard can only make an outcome more cautious.
- A close is challenged by a second model when confidence is low, the name is very close, or a data-quality rule fails.
- Text in the data that tries to instruct the reviewer is flagged, treated as data, and cannot close a case.

## Explainability

Each recommendation has a hash-sealed decision record and a trace that answers four questions: which approved definition applied, what data it rested on, who could see what, and what it cost. Every cited fact is re-read from the data by code before the critic's model sees it. See `GET /cases/:alertId/trace`, `GET /cases/:alertId/record`, and the alert view and replay in the review desk.

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
