# Input examples

Each file is a request body for `POST /run` and for `npm run case`. The alerts are synthetic and are in `data/synthetic/alert.json`; the matching exam case is in `eval/cases/exam.json`.

```bash
SAMPLE_MODE=true npm run -s case -- input_examples/run-ALR-0004.json
curl -s localhost:8000/run -H 'content-type: application/json' -d @input_examples/run-ALR-0004.json
```

| File                | Alert    | What the alert is                                                                                                | Expected kind of outcome                           |
| ------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `run-ALR-0004.json` | ALR-0004 | A customer whose name is a spelling variant of a listed name (0.965), with a different date of birth and country | Close as a false positive (`CLOSE_FALSE_POSITIVE`) |
| `run-ALR-0020.json` | ALR-0020 | A customer whose passport number on file equals the listed passport, with no date of birth on file               | Escalate to level 2 (`ESCALATE_L2`)                |
| `run-ALR-0030.json` | ALR-0030 | A name match where the customer has no date of birth on file, so the data-quality rule fails                     | Ask for more information (`NEED_MORE_INFO`)        |
| `run-ALR-0040.json` | ALR-0040 | A company owned by a listed party through a circular ownership chain                                             | Escalate to level 2 (`ESCALATE_L2`)                |
| `run-ALR-0073.json` | ALR-0073 | A payment whose counterparty name equals a listed bank's, with an onward-delivery city named only in the payment reference ("Tehran") | Escalate to level 2 (`ESCALATE_L2`): the local screener flags the city at its exact span |

In sample mode (saved Zetaris answers and the labelled rules-based stand-in for the models) the five files give the outcome in the last column. A live run asks the Nemotron models and can differ; every outcome is a recommendation for a person to act on, never an action.

Optional fields a request may carry, as `POST /run` accepts them:

| Field        | Meaning                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------- |
| `alert_id`   | The alert to review (required in this build)                                                  |
| `run_id`     | Your own run id (letters, digits, `.`, `_`, `-`), to follow the run on `/runs/{runId}/stream` |
| `alert_type` | `customer` (default) or `payment`                                                             |

The answers are not stored here. Outputs saved from real runs are exported with `npm run examples`.
