# Sample mode

Sample mode runs a complete review with **no Zetaris, no Nightshift, no Ollama and no credentials**. It is how a clean clone is tried out and how most of the test suite runs.

```bash
SAMPLE_MODE=true docker compose up --build        # or: SAMPLE_MODE=true npm run dev
curl -s localhost:8000/run -H 'content-type: application/json' -d '{"alert_id":"ALR-0004"}' | jq .
curl -s localhost:8000/cases/ALR-0004/trace | jq .
```

## What is real and what is labelled

| Part                                                                                                                                                | In sample mode                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The agents, the matching rules, the ownership engine, the memory step, the critic's fact checks, the policy guard, the decision record and its hash | **Real**. The same code runs.                                                                                                                                                                |
| The semantic layer and the SQL guard                                                                                                                | **Real** code. The queries are answered from `data/sample/query-cache.json`.                                                                                                                 |
| The answers in that file                                                                                                                            | Saved from **real queries** against Zetaris by `npm run sample:record`. A query that was never recorded fails with "not in the sample cache"; nothing is invented.                           |
| The language model                                                                                                                                  | A **labelled rules-based stand-in** (`provider: fallback-rules` in the ledger). It follows the approved definitions, so its recommendations are consistent with them, but it is not a model. |
| Every answer                                                                                                                                        | Carries `sample_mode: true` and a `sample_notice`.                                                                                                                                           |

The trace of a sample run says `cache_hit: true` on every query, so a sample run cannot be mistaken for a live one.

## Recording the cache again

After changing the data or the queries the review sends:

```bash
npm run zetaris:rebuild     # load data into Zetaris
npm run sample:record       # run every exam alert once against it, with the rules stand-in, and save the answers
```
