# Output examples

Each folder is exported from a real saved run by `npm run examples` (nothing is written by hand) and is never read back by the application. Each holds the sealed decision record, the decision trace (with the model ledger and signed receipts), the run events, and a short case file to read first (`case.md`).

| Folder                            | Outcome                                  | Run it comes from                                                                                                                                                                            | Input that produces the same kind of case in sample mode   |
| --------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `close-previously-cleared`        | CLOSE_FALSE_POSITIVE                     | 70-case exam, case EX-045, changed system                                                                                                                                                    | `input_examples/run-ALR-0004.json` (a close)               |
| `escalate-true-match`             | ESCALATE_L2                              | 70-case exam, case EX-016, changed system                                                                                                                                                    | `input_examples/run-ALR-0020.json` (an escalation)         |
| `need-more-info-critic-sent-back` | NEED_MORE_INFO                           | 70-case exam, case EX-030, changed system; the critic sent the first recommendation back                                                                                                     | `input_examples/run-ALR-0030.json` (need more information) |
| `block-transliteration`           | RECOMMEND_BLOCK (still needs two people) | 70-case exam, case EX-025, changed system                                                                                                                                                    | live only: sample mode never recommends a block            |
| `v3-relationship-escalated`       | ESCALATE_L2                              | held-out v3, case HO3-002, fixed system, blind run                                                                                                                                           | live only                                                  |
| `v3-relationship-wrongly-closed`  | CLOSE_FALSE_POSITIVE, **a wrong close**  | held-out v3, case HO3-001, fixed system, blind run: the screener flagged the relationship, but its cited span did not hold the relationship word, so the grounding rule set the signal aside | live only; kept as the honest counter-example              |
| `close-stopped-by-policy-guard` | ESCALATE_L2 | 70-case exam, case EX-064, first system: the decision's first recommendation was a close at 0.95 and the critic approved it; the policy guard blocked it on a watched jurisdiction named in the payment reference (the README's "One real trace") | `input_examples/run-ALR-0073.json` (an escalation; in sample mode the screener flags the city) |

## Sample mode: one saved output per input

`sample-mode/<alert>/` holds what each request in [`input_examples/`](../input_examples) gives in sample mode, saved from a real run by `npm run examples:sample` (all services on closed ports; the saved Zetaris answers and the labelled rules-based stand-in): the answer printed by `npm run case` (`answer.json`), the sealed decision record and the run's events. Re-run the same request and compare.

| Input | Saved output | Outcome |
| --- | --- | --- |
| `input_examples/run-ALR-0004.json` | `sample-mode/ALR-0004/` | CLOSE_FALSE_POSITIVE |
| `input_examples/run-ALR-0020.json` | `sample-mode/ALR-0020/` | ESCALATE_L2 |
| `input_examples/run-ALR-0030.json` | `sample-mode/ALR-0030/` | NEED_MORE_INFO |
| `input_examples/run-ALR-0040.json` | `sample-mode/ALR-0040/` | ESCALATE_L2 |
| `input_examples/run-ALR-0073.json` | `sample-mode/ALR-0073/` | ESCALATE_L2 |
