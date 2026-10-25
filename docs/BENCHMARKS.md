# Benchmarks

Measured on one machine (a recent Apple silicon laptop, macOS 27, Node 26), with the API in sample mode (saved Zetaris answers and the labelled stand-in model, so no network or model service is involved), a local client, 200 requests per route and 20 at a time. Reproduce with `npm run bench:api -- --requests 200 --concurrency 20`. Measured on 23 Oct 2026, before the rate limits were added on 24 Oct (10 reviews a minute per caller, 4 in flight); with the default limits the same command now gets 429 answers, so raise them for this test as described below. These numbers describe this software on this machine, not a deployment: a live review is bounded by the model service and by Zetaris, and its times are in [the exam report](../eval/REPORT.md).

| Route                                                                               | Errors | Median ms | p95 ms | Max ms | Requests/s |
| ----------------------------------------------------------------------------------- | -----: | --------: | -----: | -----: | ---------: |
| `GET /health`                                                                       |      0 |       1.8 |   11.1 |   18.4 |      4,781 |
| `GET /alerts` (the queue, read through the semantic layer's saved answers)          |      0 |     107.9 |  221.2 |  237.2 |        165 |
| `GET /policy`                                                                       |      0 |       1.2 |    2.8 |    5.9 |     14,221 |
| `GET /governance`                                                                   |      0 |       9.3 |   19.0 |   21.3 |      1,886 |
| `POST /run` (a full review in sample mode, every agent step, sealed record written) |      0 |      39.7 |   80.0 |  107.8 |        431 |

What this shows: the application around the models is not the bottleneck. A full review in sample mode (ten steps, 10 to 17 read-only data queries replayed from the saved cache, the critic's fact checks, the policy guard and a sealed, hashed record on disk) takes about 40 ms at the median under 20 concurrent callers. In a live review the time is the model calls (tens of seconds each for the cloud model) and Zetaris round trips (about 100 ms each).

**Bounds that keep a run short.** Every model call has a timeout; the critic gets at most three rounds; one review runs per alert at a time (a second request for the same alert is answered, not queued); a 429 from the model service is waited out three times (3, 6 and 12 seconds) before the step's own fallback takes over; a case that exceeds ten minutes in the exam runner is abandoned and recorded as an error.

**Exam timing** (live, model-backed) is measured per run and reported in `eval/REPORT.md`: median and p95 seconds per case, by path (confirm or reason), with the model cost under the configured unit costs.

## How long a run takes

**Sample mode, no model calls** (saved Zetaris answers and the rules stand-in; the desk's own code only), a recent Apple silicon laptop, Node 26, 50 alerts, three repeats each, 0 errors: one at a time, a median of 4 to 5 ms and a p95 of 7 to 10 ms per alert; five at a time, a median of 20 to 23 ms and a p95 of about 36 ms, about 12,500 to 13,500 alerts a minute. The API's limits were raised for this test (`RATE_LIMIT_REVIEWS`, `RATE_LIMIT_WRITES`, `RATE_LIMIT_REVIEWS_IN_FLIGHT=5`); by default it runs at most 4 reviews at once and refuses more. Script: `tools/load-sample.mjs`.

**Live, with the models:** the current system's newest run (held-out v4, 12 alerts) took a median of 45 seconds per alert; most of it is the cloud model.
