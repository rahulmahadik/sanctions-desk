# API

The API listens on `http://localhost:8000`. An interactive description (Swagger UI) is at **`/docs`** and the OpenAPI 3.1 document at `/docs/json`; both are on by default and can be switched off with `DOCS_ENABLED=false`. The request and response shapes in the description are generated from the same zod schemas the routes validate with, and a test fails if a route exists that the description does not list.

Everything below works in sample mode (`SAMPLE_MODE=true`), which needs no external service. Every error has one shape:

```json
{ "status": "error", "request_id": "…", "error": { "type": "validation", "message": "…", "recoverable": false } }
```

The `request_id` is also returned in the `x-request-id` header; send your own `x-request-id` to correlate (letters, digits, `.`, `_`, `-`, up to 64 characters).

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
