# Exam report

## Headline

_The full system has not been run yet, so there is no headline figure._

Every number below was produced by `npm run exam` on this machine and is read from `eval/results/*.json`; rebuild this file with `npm run exam:report`.

**Single run.** Each variant below is from one run. Model answers vary between runs, and the runtime may answer a repeated prompt from its cache, which makes time and cost look better than a cold run. Treat differences of a few cases as noise.

The exam has 70 cases built from real public list entries and synthetic customers, payments and owners: 68 alerts and 2 drafts that must not tip a customer off. Each case has one right answer, some acceptable alternatives, and answers that must never be given. A case carries real risk when closing it would be wrong; the **false-close rate** is the share of those cases the system recommended closing.

## Variants compared

| Variant                                                                                 | Cases |  Exact | Acceptable | Acceptable, leaving out unavailable decisions | False closes (risk cases) | No usable decision: provider / parsing | Median s | p95 s | Cloud share of calls | Model cost |
| --------------------------------------------------------------------------------------- | ----: | -----: | ---------: | --------------------------------------------: | ------------------------: | -------------------------------------: | -------: | ----: | -------------------: | ---------: |
| Deterministic pipeline (our own matching, ownership and policy code; no language model) |    70 | 100.0% |     100.0% |                             100.0% (70 cases) |            0 of 42 (0.0%) |                                  0 / 0 |     2.47 |  3.58 |                 0.0% |     0.0000 |
| Name-match rules baseline (name score at or above 0.90 escalates, below closes)         |    70 |  42.9% |      54.3% |                              54.3% (70 cases) |          10 of 42 (23.8%) |                                  0 / 0 |        0 |     0 |                 0.0% |     0.0000 |
| Baseline: every alert goes to a person                                                  |    70 |  51.4% |      65.7% |                              65.7% (70 cases) |            0 of 42 (0.0%) |                                  0 / 0 |        0 |     0 |                 0.0% |     0.0000 |

**Not run:** Full system (routed across the model lanes, critic, challenger, memory); Single recommendation (no critic, no challenger, no memory); Full system with memory off (earlier-cleared cases only); Full system, local lane only, reasoning off.
- _Deterministic pipeline_ is our own code (matching, ownership engine, policy guard) with a labelled rules stand-in in place of a language model. It is not typical screening: it reads the same evidence, so it shows what the code alone settles. _Name-match rules baseline_ is typical screening: it sees only a name score, with no ownership, data-quality or evidence reasoning.
- _No usable decision_ counts the cases where the decision step got no usable model answer and the desk escalated them with the reason "model decision unavailable". **Provider** means the model service failed or answered with nothing; **parsing** means it answered in a form that could not be used. They are in the totals; the next column leaves them out.
- Model cost uses the illustrative unit costs in `config/default.json` (`costs`, currency USD); they are assumptions, not prices. Calls on the local lane run on this machine and cost nothing per call; only cloud tokens are priced.

### The name-match rules baseline at other thresholds

| Threshold | Acceptable | False closes (risk cases) | Escalated |
| --------: | ---------: | ------------------------: | --------: |
|      0.50 |      64.3% |                   1 of 42 |  66 of 68 |
|      0.60 |      52.9% |                  10 of 42 |  56 of 68 |
|      0.70 |      52.9% |                  10 of 42 |  56 of 68 |
|      0.80 |      54.3% |                  10 of 42 |  55 of 68 |
|      0.90 |      54.3% |                  10 of 42 |  55 of 68 |
|      0.95 |      55.7% |                  10 of 42 |  54 of 68 |

Moving the line changes how many alerts go to a person, and the false closes are the risk cases that score below it.

## Accuracy by group

| Group                        | rules | fuzzy | escalate_all |
| ---------------------------- | ----: | ----: | -----------: |
| false_positive               | 15/15 |  3/15 |         1/15 |
| true_match                   |   8/8 |   6/8 |          8/8 |
| transliteration              |   6/6 |   4/6 |          4/6 |
| missing_data                 |   5/5 |   4/5 |          5/5 |
| hidden_ownership             |   6/6 |   6/6 |          6/6 |
| ownership_below              |   4/4 |   4/4 |          4/4 |
| previously_cleared_unchanged |   6/6 |   0/6 |          0/6 |
| previously_cleared_changed   |   5/5 |   5/5 |          5/5 |
| injection                    |   3/3 |   1/3 |          3/3 |
| tipping_off                  |   2/2 |   0/2 |          0/2 |
| payment_jurisdiction         |   5/5 |   1/5 |          5/5 |
| rules_gap                    |   5/5 |   4/5 |          5/5 |

Cells show cases answered acceptably out of cases run.

## Misses: rules

None.

## Limits of this exam

- The customers, payments and owners are synthetic; the listed parties are real public entries. The exam shows how the system behaves on planted situations, not how it would perform on a bank's real alert volume.
- Cases were written together with the rules they test (the approved definitions), so a high score shows consistency with those definitions rather than proof that the definitions are right. Five cases were added later to test where plain name matching fails; the system was not tuned to them.
- Time depends on this machine, on whether the cloud lane answers within the runtime's time limit, on what else is running, and on the runtime's answer cache.
- Each variant is one run; the file of that run is named in `eval/results/`.
