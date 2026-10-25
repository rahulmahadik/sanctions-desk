# API

The API listens on `http://localhost:8000`. An interactive description (Swagger UI) is at **`/docs`** and the OpenAPI 3.1 document at `/docs/json`; both are on by default and can be switched off with `DOCS_ENABLED=false`. The request and response shapes in the description are generated from the same zod schemas the routes validate with, and a test fails if a route exists that the description does not list.

## API docs online

A read-only copy of the reference is at **https://rahulmahadik.github.io/sanctions-desk/api.html**, with a short landing page at https://rahulmahadik.github.io/sanctions-desk/. It is static: Redoc renders the OpenAPI document, which is generated from the API's code on every build (`npm run site:build`; `npm run openapi:export` writes the document alone), and nothing on the page calls the API. The workflow `.github/workflows/pages.yml` publishes it on a push to `main` that touches the API, the site or its tools.

The site is built and published by the Pages workflow (Pages set to "GitHub Actions" under Settings > Pages > Source). To look at the site locally, run `npm run site:build` and serve `site/` with any static file server.

<!-- auth-guide:start -->
## Authentication and access

**Get a token.** An administrator adds each person to the users file, which is kept outside the repository and named by `DESK_USERS_FILE`:

```bash
npm run users:add -- --file ~/.sanctions-desk/users.json --id olga --role approver --by admin --expires 90d
```

The token (`sd_` and 32 characters, 192 random bits) is printed once; the file keeps only its SHA-256. `npm run users:rotate` issues a new token and the old one stops working; `npm run users:revoke` stops a token at once; `--expires` (for example `90d` or an ISO time) makes a token stop working at that time. A running server reads the file again when it changes, so these take effect on the next request. Every change is logged in `users-audit.jsonl` beside the file (who, when, what; never a token). A token in any other form is refused, and with sign-in on the server will not start while the file holds a token that `users:add` did not make.

**When sign-in is on.** The setting is the environment variable `AUTH_MODE` (`server.auth` in the configuration files), and it defaults to `auto`. `auto` means sign-in is on in live mode and demo users in sample mode. `on` works in both modes. `demo` and `off` are refused in live mode, and in live mode without a users file (`DESK_USERS_FILE`) the server refuses to start, so the API never runs live with sign-in off.

**Runs without the API.** Two things do not go through the API's sign-in, because they open no port and whoever runs them already controls the process: `npm run case` (one review, in-process) and the evaluation tools (`npm run exam` and the study and guard tools), which call the review pipeline directly.

**Send it.** `Authorization: Bearer <token>` on every request. Every route except `/health` needs it when sign-in is on (the default outside sample mode). No token, or an unknown, malformed, expired or revoked one: `401`. A role that may not do this: `403`.

```bash
export DESK_TOKEN=...   # your token, from users:add; never put it in a file in the repository
curl -s https://desk.example.com/run -H "Authorization: Bearer $DESK_TOKEN" -H 'content-type: application/json' -d '{"alert_id": "ALR-0004"}'
```

**Roles.**

| Role | What it may do |
| --- | --- |
| `analyst` | read everything; start a review, replay a list change, check a draft for a customer, compare a policy draft; approve or override a recommendation, give a second approval, reopen an automatic close |
| `approver` | read everything; start a review, replay a list change, check a draft for a customer, compare a policy draft; approve or override a recommendation, give a second approval, reopen an automatic close; give the second approval of a block or of an override to a close; override towards a less cautious outcome (it then waits for a second approver); propose, reload or roll back a policy draft; stop automatic closing |
| `policy_admin` | read everything; start a review, replay a list change, check a draft for a customer, compare a policy draft; propose, reload or roll back a policy draft; publish a policy draft; stop automatic closing; switch automatic closing back on |
| `viewer` | read everything (read only) |

**Four-eyes.** A block (an approved block recommendation, or an override to a block), and an override to a close from any other recommendation, wait for a second, different approver. In sample mode `approver_demo` and `approver2_demo` can be the two approvers. A policy draft must be published by a different person from the one who proposed it; in sample mode `admin_demo` can propose it and `admin2_demo` publish it.

**Rate limits.** Per caller (the signed-in user; without sign-in, the address), in a fixed window: by default 60 changes a minute, 10 reviews a minute, and 4 reviews running at once across all callers; above a limit the answer is `429` with `Retry-After`, and nothing is queued. Reads and `/health` are not limited. The counts are kept in the memory of one server process: they reset when it restarts and are not shared between processes. Set them in `config` (`server.rateLimit`) or with `RATE_LIMIT_WRITES`, `RATE_LIMIT_REVIEWS`, `RATE_LIMIT_REVIEWS_IN_FLIGHT` and `RATE_LIMIT_WINDOW_MS`. For limits shared across several processes or machines, put a gateway or proxy with its own limits in front (for example nginx `limit_req` or an API gateway).

**TLS.** With `DESK_TLS_CERT_FILE` and `DESK_TLS_KEY_FILE` set, the server serves HTTPS only. Without them it serves plain HTTP and should stay on `127.0.0.1`, as by default; it logs a warning at start-up if it is bound to any other address without TLS. For a deployment, terminate TLS in a proxy in front, for example Caddy:

```
desk.example.com {
  reverse_proxy 127.0.0.1:8000
}
```

**Sample mode.** With `SAMPLE_MODE=true` and sign-in not on, the built-in demo users (`analyst_demo`, `approver_demo`, `approver2_demo`, `admin_demo`, `admin2_demo`) can be chosen with the `X-Demo-User` header, and reading and running a review need no token. The demo users are ignored when sign-in is on and never work in live mode.
<!-- auth-guide:end -->

## Errors and request ids

Everything below works in sample mode (`SAMPLE_MODE=true`), which needs no external service. Every error has one shape:

```json
{ "status": "error", "request_id": "…", "error": { "type": "validation", "message": "…", "recoverable": false } }
```

The `request_id` is also returned in the `x-request-id` header; send your own `x-request-id` to correlate (letters, digits, `.`, `_`, `-`, up to 64 characters).

## People and decisions

Once sign-in is on, every route except `/health` needs `Authorization: Bearer <token>`. In sample mode a demo user can be chosen with the header `X-Demo-User` (`analyst_demo`, `approver_demo`, `approver2_demo`, `admin_demo`, `admin2_demo`).

| Route                                                             | What it does                                                                                                                                 |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /me`                                                         | Who you are, what you may do, and the demo users in sample mode                                                                              |
| `GET /cases/{alertId}/human`                                      | Where a recommendation stands after people acted, and the records prepared from their decision                                               |
| `POST /cases/{alertId}/decision`                                  | Approve or override with a reason (`action`, `outcome` for an override, `reason`, `record_hash`)                                             |
| `POST /cases/{alertId}/second-approval`                           | The second approver confirms or declines a block, or an override to a close (status `override_pending`) (`approve`, `reason`, `record_hash`) |
| `POST /cases/{alertId}/reopen`                                    | Reopen a close the desk made automatically                                                                                                   |
| `GET /cases/{alertId}/actions`                                    | The prepared records, each with its seal check                                                                                               |
| `GET /cases/{alertId}/file?format=md\|pdf`                        | The case file                                                                                                                                |
| `GET /autonomy`, `POST /autonomy/kill-switch`, `GET /auto-closed` | The autonomy level in force, the kill switch, and the automatic closes for review                                                            |
| `GET /receipts/{receiptId}/verify`                                | Check a stored signed receipt: signature, pinned key, app, modes, serving model                                                              |

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

`decision` is one of `CLOSE_FALSE_POSITIVE`, `ESCALATE_L2`, `RECOMMEND_BLOCK` (needs two approvals) and `NEED_MORE_INFO`. Every answer says a review by a person is required. A review that could not run is an error body, never an invented decision. If Zetaris cannot be reached, the answer is `status: ok`, `ESCALATE_L2`, confidence 0, `held_reason: data_service_unavailable` and no `record_hash`: the case is held for a person. Only one review of the same alert runs at a time.

Every answer, including an error, also carries the run's bookkeeping:

| Field                    | What it is                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `run_id`, `trace_id`     | The run's id; the trace id is the same value                                                     |
| `status`                 | `ok`, or `error` with `error: {type, message, recoverable}`                                      |
| `agents`                 | The steps that ran, in order (for example `triage`, `evidence`, ..., `policy_guard`, `reporter`) |
| `log_file`               | The run's trace file, relative to the project root: `logs/trace-<run_id>.jsonl`                  |
| `record_hash`            | SHA-256 of the sealed decision record (absent when the case was held without a record)           |
| `held_reason`            | `data_service_unavailable` when Zetaris could not be reached and the case is held for a person   |
| `execution_time_seconds` | Time the review took                                                                             |
| `sample_mode`            | `true` when the run used saved data and the labelled rules-based model (absent in a live run)    |

### The same review from the command line

```bash
npm run -s case -- input_examples/run-ALR-0004.json        # readable trace lines on stderr, the answer on stdout
npm run -s case -- input_examples/run-ALR-0004.json | jq   # the answer through jq; the trace lines still show
```

The file holds the same body as `POST /run`. The command runs the `/run` route inside the process (no server, no sign-in step), prints one JSON object with `run_id`, `status`, `decision`, `confidence`, `agents`, `trace_id`, `log_file`, `record_hash`, `execution_time_seconds` and `sample_mode`, and exits with a non-zero code and `{"error": {"type", "message"}}` when the review could not run. See [input_examples/README.md](../input_examples/README.md).

### Run one case

One review from the command line, without the interface or a server. The request file holds the same body as `POST /run`; with `SAMPLE_MODE=true` no service or key is needed.

```bash
npm ci
SAMPLE_MODE=true npm run -s case -- input_examples/run-ALR-0004.json
```

The same review over HTTP, with the API running in sample mode (`SAMPLE_MODE=true npm run dev`, or `SAMPLE_MODE=true docker compose up --build`):

```bash
curl -s localhost:8000/run -H 'content-type: application/json' -d @input_examples/run-ALR-0004.json
```

While it runs, `npm run case` prints one short line per step to stderr (time, agent, action, status, summary, receipt id; turn off with `TRACE_STDOUT_PRETTY=false`), then one JSON object to stdout. Shape of the answer (values from a sample-mode run; `POST /run` returns these fields and more):

```json
{
  "run_id": "ae3c6311-1d7f-4718-9a8d-52bae7447275",
  "status": "ok",
  "decision": "CLOSE_FALSE_POSITIVE",
  "confidence": 0.85,
  "agents": [
    "triage",
    "evidence",
    "screener",
    "matching",
    "memory",
    "decision",
    "critic",
    "challenger",
    "policy_guard",
    "reporter"
  ],
  "trace_id": "ae3c6311-1d7f-4718-9a8d-52bae7447275",
  "log_file": "logs/trace-ae3c6311-1d7f-4718-9a8d-52bae7447275.jsonl",
  "record_hash": "f7c9ecf5702f91183f60c8a58ff01f95ae41c3f211f785773e69e567be67d9ff",
  "execution_time_seconds": 0.026,
  "sample_mode": true
}
```

A review held because Zetaris cannot be reached prints `status: ok` with `held_reason: data_service_unavailable` and exits with 0. A review that cannot run prints `{"status": "error", ..., "error": {"type": "...", "message": "..."}}` and exits with a non-zero code. The request files and the kind of outcome each one gives are in [input_examples/README.md](../input_examples/README.md).

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
curl -s -X POST localhost:8000/policy/reload -H 'X-Demo-User: approver_demo' -H 'content-type: application/json' -d '{}'   # the file as a draft (sample mode)
curl -s -X POST localhost:8000/policy/drafts/2/publish -H 'X-Demo-User: admin_demo' -H 'content-type: application/json' -d '{}'
curl -s -X POST localhost:8000/policy/whatif -H 'content-type: application/json' -d '{"version":2,"limit":10}' | jq '.changed, .new_false_closes'
```

A draft is published by a different person than the proposer (four-eyes); a published version applies to the next run without a restart. The hard limits (no automatic block, no customer messages, read-only data) are fixed in the schema: a draft that changes them is rejected with a 400. `POST /policy/whatif` re-reviews exam cases under the active policy and under a draft, flags any case the draft would newly close that the exam says must never be closed, and saves nothing.

## Other

| Route                                     | What it returns                                                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GET /health`, `GET /health/dependencies` | Liveness; readiness of Nightshift and Ollama (the status), with Zetaris reported alongside                              |
| `GET /exam`                               | Saved exam results, the headline measure and the measured split of calls by serving model                               |
| `GET /governance`                         | Inventory, risk materiality, oversight, testing, monitoring, change control and limits ([GOVERNANCE.md](GOVERNANCE.md)) |

## Cross-origin use

The review desk interface calls the API from the browser. Only the origins listed in `WEB_ORIGINS` receive cross-origin headers; any other origin is ignored.

## The decision trace

`GET /cases/:alertId/trace` (or `/runs/:runId/trace`) answers four questions from the sealed record, and says if the record no longer verifies:

| Question                               | Answer in the trace                                                                                                                                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which approved definition was applied? | `definitions`: id, version and a hash of the wording                                                                                                                                          |
| What data is it based on?              | `data`: model version, list snapshots, every query (id, statement hash, rows, latency, cache hit), row hashes                                                                                 |
| Who was allowed to see what?           | `access`: the role of each query, whether it ran under its own token or the labelled fallback, the masked columns, the policy version and hash                                                |
| What did it cost to produce?           | `cost`: per call the mode asked for, the model that answered, reasoning budget, tokens, latency, receipt status; Zetaris query time and rows; totals and cost under the configured unit costs |

## Routes at a glance

Interactive description at `http://localhost:8000/docs` (Swagger UI), and worked examples in [docs/API.md](#api).

Errors have one shape: `{ "status": "error", "request_id": "...", "error": { "type", "message", "recoverable" } }`.

| Method and path                                                                                    | Purpose                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`, `GET /health/dependencies`                                                          | Liveness; readiness of Nightshift and Ollama (the status), with Zetaris reported alongside.                                                                                                                            |
| `POST /run`                                                                                        | Review one alert by `alert_id` (customer name, ownership or payment alert). Returns the recommendation, rationale, citations, `what_would_change`, agents, model ledger, guard verdicts, critic result, `record_hash`. |
| `GET /cases/:alertId/trace`, `GET /runs/:runId/trace`                                              | The decision trace; add `?audit=true` to match queries with Zetaris's history.                                                                                                                                         |
| `GET /runs/:runId/events`                                                                          | The recorded events of a run.                                                                                                                                                                                          |
| `POST /list-change/replay`                                                                         | Earlier decisions against the list as it is now: cases to re-open, parties to release, portfolio impact.                                                                                                               |
| `POST /guard/outbound`                                                                             | Check a draft meant for a customer; refuses anything that reveals screening or an investigation.                                                                                                                       |
| `GET /policy`, `/policy/versions`, `/policy/versions/:v`, `/policy/audit`                          | The versioned policy.                                                                                                                                                                                                  |
| `POST /policy/drafts`, `/policy/reload`, `/policy/rollback`                                        | Propose a policy change: a full policy, the policy file read again, or an earlier version. Validated against the policy schema, which fixes the hard limits.                                                           |
| `POST /policy/drafts/:version/publish`, `/discard`                                                 | A second person publishes a draft (four-eyes); the next run uses it without a restart, and a run in progress keeps the version it started with.                                                                        |
| `POST /policy/whatif`                                                                              | Review exam cases under the active policy and under a draft, and list what changes, including any case the draft would newly close that the exam says must never be closed. Saves nothing.                             |
| `GET /alerts`, `GET /runs/:id/stream`, `GET /cases/:id/record`, `/cases/:id/evidence`, `GET /exam` | What the review desk interface reads: the queue, a live event stream, the sealed record, the masked facts, the exam results.                                                                                           |

A review writes `logs/trace-<run>.jsonl` (one JSON event per step), the sealed `logs/records/<record>.json` and the signed receipts under `logs/receipts/`.
