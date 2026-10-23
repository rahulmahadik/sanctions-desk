# API

The API listens on `http://localhost:8000`. An interactive description (Swagger UI) is at **`/docs`** and the OpenAPI 3.1 document at `/docs/json`; both are on by default and can be switched off with `DOCS_ENABLED=false`. The request and response shapes in the description are generated from the same zod schemas the routes validate with, and a test fails if a route exists that the description does not list.

Everything below works in sample mode (`SAMPLE_MODE=true`), which needs no external service. Every error has one shape:

```json
{ "status": "error", "request_id": "…", "error": { "type": "validation", "message": "…", "recoverable": false } }
```

The `request_id` is also returned in the `x-request-id` header; send your own `x-request-id` to correlate (letters, digits, `.`, `_`, `-`, up to 64 characters).

## People and decisions

Once sign-in is on, every route except `/health` needs `Authorization: Bearer <token>`. In sample mode a demo user can be chosen with the header `X-Demo-User` (`analyst_demo`, `approver_demo`, `admin_demo`).

| Route                                                             | What it does                                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET /me`                                                         | Who you are, what you may do, and the demo users in sample mode                                  |
| `GET /cases/{alertId}/human`                                      | Where a recommendation stands after people acted, and the records prepared from their decision   |
| `POST /cases/{alertId}/decision`                                  | Approve or override with a reason (`action`, `outcome` for an override, `reason`, `record_hash`) |
| `POST /cases/{alertId}/second-approval`                           | The second approver confirms or declines a block (`approve`, `reason`, `record_hash`)            |
| `POST /cases/{alertId}/reopen`                                    | Reopen a close the desk made automatically                                                       |
| `GET /cases/{alertId}/actions`                                    | The prepared records, each with its seal check                                                   |
| `GET /cases/{alertId}/file?format=md\|pdf`                        | The case file                                                                                    |
| `GET /autonomy`, `POST /autonomy/kill-switch`, `GET /auto-closed` | The autonomy level in force, the kill switch, and the automatic closes for review                |
| `GET /receipts/{receiptId}/verify`                                | Check a stored signed receipt: signature, pinned key, app, modes, serving model                  |

## Review an alert

```bash
curl -s localhost:8000/run -H 'content-type: application/json' \
  -d '{"alert_id":"ALR-0004","run_id":"my-run-1"}' | jq '{decision, confidence, rationale, key_evidence, critic, record_hash}'
```

```json
{
  "decision": "CLOSE_FALSE_POSITIVE",
  "confidence": 0.85,
  "rationale": "…",
  "key_evidence": ["Comparison: name 0.96 (phonetic) vs primary \"Andrew Kan\"", "Comparison: date of birth: conflict"],
  "critic": { "rounds": 1, "final_verdict": "approved" },
  "record_hash": "…"
}
```

`decision` is one of `CLOSE_FALSE_POSITIVE`, `ESCALATE_L2`, `RECOMMEND_BLOCK` (needs two approvals) and `NEED_MORE_INFO`. Every answer says a review by a person is required. A review that could not run is an error body, never an invented decision. Only one review of the same alert runs at a time.

Every answer, including an error, also carries the run's bookkeeping:

| Field                    | What it is                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `run_id`, `trace_id`     | The run's id; the trace id is the same value                                                  |
| `status`                 | `ok`, or `error` with `error: {type, message, recoverable}`                                   |
| `agents`                 | The steps that ran, in order (for example `triage`, `evidence`, ..., `policy_guard`, `reporter`) |
| `log_file`               | The run's trace file, relative to the project root: `logs/trace-<run_id>.jsonl`               |
| `record_hash`            | SHA-256 of the sealed decision record                                                         |
| `execution_time_seconds` | Time the review took                                                                          |
| `sample_mode`            | `true` when the run used saved data and the labelled rules-based model (absent in a live run) |

### The same review from the command line

```bash
npm run -s case -- input_examples/run-ALR-0004.json                              # readable trace lines, then the answer
TRACE_STDOUT_PRETTY=false npm run -s case -- input_examples/run-ALR-0004.json | jq   # only the answer
```

The file holds the same body as `POST /run`. The command runs the `/run` route inside the process (no server, no sign-in step), prints one JSON object with `run_id`, `status`, `decision`, `confidence`, `agents`, `trace_id`, `log_file`, `record_hash`, `execution_time_seconds` and `sample_mode`, and exits with a non-zero code and `{"error": {"type", "message"}}` when the review could not run. See [input_examples/README.md](../input_examples/README.md).

### Trace lines

Each line of `logs/trace-<run_id>.jsonl` is one event. Besides the event's own fields it always carries `run_id`, `timestamp` (same value as `ts`), `agent_name` (same as `agent`), `action`, `status`, `input_summary`, `output_summary`, `target_agent`, `confidence`, `retry_count` and `model` (the model that answered, when the event is a model call), each `null` when it does not apply. Model calls also carry `provider`, `model_requested`, `model_used`, `route_kind`, `latency_ms`, tokens and the signed Nightshift `receipt`; data reads carry `zetaris_query_id`. With `TRACE_STDOUT_PRETTY=true` the process prints one short line per event (time in UTC, agent, action, status, summary, receipt id) instead of the JSON line.

### Follow a run while it works

Give `/run` a `run_id` of your own, and open the stream first (or after: recorded events are replayed):

```bash
curl -N localhost:8000/runs/my-run-1/stream        # server-sent events, one "run_event" per step
curl -s localhost:8000/runs/my-run-1/events | jq   # the same events as a list
```

## Read the result again

```bash
curl -s localhost:8000/alerts | jq '.alerts[0]'                       # the queue, with the latest recommendation of each alert
curl -s localhost:8000/cases/ALR-0004/record | jq                     # the sealed decision record
curl -s localhost:8000/cases/ALR-0004/trace | jq '.definitions, .access, .cost.totals'   # definitions, data, access, cost
curl -s localhost:8000/cases/ALR-0004/trace?audit=true | jq .audit    # live runs: match each query with Zetaris's own history
curl -s localhost:8000/cases/ALR-0004/evidence | jq .customer_identifiers   # facts read through the evidence role; identifier numbers masked
```

## Check an earlier decision against a changed list

```bash
curl -s -X POST localhost:8000/list-change/replay -H 'content-type: application/json' -d '{}' | jq '.impact, (.reopen|length), (.release|length)'
```

It changes nothing: cases to re-open and parties to release are for a person to act on.

## Check a message for a customer

```bash
curl -s -X POST localhost:8000/guard/outbound -H 'content-type: application/json' \
  -d '{"text":"Please send a copy of your passport so we can clear a sanctions alert."}' | jq
```

A draft that reveals screening, a match or an investigation is refused, with the reason.

## Policy

```bash
curl -s localhost:8000/policy/versions | jq                              # versions and their status
curl -s -X POST localhost:8000/policy/reload -H 'content-type: application/json' -d '{"proposed_by":"analyst-a"}'   # the file as a draft
curl -s -X POST localhost:8000/policy/drafts/2/publish -H 'content-type: application/json' -d '{"approved_by":"lead-b"}'
curl -s -X POST localhost:8000/policy/whatif -H 'content-type: application/json' -d '{"version":2,"limit":10}' | jq '.changed, .new_false_closes'
```

A draft is published by a different person than the proposer (four-eyes); a published version applies to the next run without a restart. The hard limits (no automatic block, no customer messages, read-only data) are fixed in the schema: a draft that changes them is rejected with a 400. `POST /policy/whatif` re-reviews exam cases under the active policy and under a draft, flags any case the draft would newly close that the exam says must never be closed, and saves nothing.

## Other

| Route                                     | What it returns                                                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GET /health`, `GET /health/dependencies` | Liveness; readiness of Nightshift, Ollama and Zetaris                                                                   |
| `GET /exam`                               | Saved exam results, the headline measure and the measured split of calls by serving model                               |
| `GET /governance`                         | Inventory, risk materiality, oversight, testing, monitoring, change control and limits ([GOVERNANCE.md](GOVERNANCE.md)) |

## Cross-origin use

The review desk interface calls the API from the browser. Only the origins listed in `WEB_ORIGINS` receive cross-origin headers; any other origin is ignored.
