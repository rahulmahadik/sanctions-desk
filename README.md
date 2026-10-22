# sanctions-desk

An AI review desk for bank sanctions screening alerts. It clears false alarms with cited evidence,
looks for risk that name matching misses (company ownership, list changes, embargoed jurisdictions),
and remembers past decisions. A human always makes the final call.

Built for the Open Agent Hackathon 2026, Track 03 (Reasoning Architecture).

## Contents

- [How it is built](#how-it-is-built)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [API](#api)
- [Policy](#policy)
- [Traces, events and receipts](#traces-events-and-receipts)
- [Docker](#docker)
- [Development](#development)
- [Project layout](#project-layout)
- [Security](#security)
- [Licence](#licence)

## How it is built

| Part                 | What it does                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Model seam**       | Agents never call a model directly. They receive one `generator` function. Nightshift (Meterless) is the primary provider, local Ollama is the backup, and a labelled rule-based fallback exists for sample mode only. Nightshift is always called with a pinned mode (`meterless/fast`, `meterless/deep`, `meterless/judge`), never `meterless/auto`. |
| **Dead routes**      | A retired mode (HTTP 410, or 400 `class_no_route`) is retried once on the next configured mode, then the call falls back to Ollama. Every attempt logs the requested and the routed model.                                                                                                                                                             |
| **Signed receipts**  | Nightshift signs a receipt for every answer. The generator keeps it, verifies the Ed25519 signature, and records it in the trace and the decision record.                                                                                                                                                                                              |
| **Policy**           | All tunable behaviour is a versioned, schema-validated document. A run pins the active version when it starts. Changes need a second approver and take effect without a restart. Auto-block, customer messaging and write access are locked off in the schema.                                                                                         |
| **Run events**       | Every trace line is also published on an in-process event bus, so a live view reads exactly what the file records.                                                                                                                                                                                                                                     |
| **Decision records** | Each recommendation can be sealed into a hashed record (policy version, list snapshots, queries and row hashes, memory use, models and receipts, guard verdicts, human actions) and compared with a replay.                                                                                                                                            |
| **Pointer memory**   | Memory holds a pointer to the source row plus a content hash, never a copy of personal data. A changed hash marks the memory stale.                                                                                                                                                                                                                    |

## Requirements

- **Node.js 24 or newer** (developed on 26). Check with `node --version`.
- **npm** 10 or newer (ships with Node).
- **Docker** with Compose v2 (only for the container workflow).
- Optional, for live model calls:
  - [Meterless Nightshift](https://meterless.ai) running locally, with a runtime token.
  - [Ollama](https://ollama.com) with a model pulled, for the backup provider.

The test suite needs none of the optional services.

## Quick start

```bash
git clone <repository-url> sanctions-desk
cd sanctions-desk

npm install                 # install dependencies
npm run ci                  # typecheck, lint and tests with coverage gates
npm run dev                 # start the API on http://localhost:8000
```

In another terminal:

```bash
curl localhost:8000/health
curl localhost:8000/policy
```

### Connect the model providers (optional)

1. Copy the example environment file and fill in your own values:

   ```bash
   cp .env.example .env
   ```

   `.env` is git-ignored. Never commit it.

2. Put your Nightshift runtime token in `METERLESS_RUNTIME_TOKEN`. Nightshift stores it in
   `~/Library/Application Support/ai.meterless.runtime/proxy-token` on macOS.

3. Make sure the Nightshift runtime is running (default `http://127.0.0.1:8088/v1`) and, for the
   backup, that Ollama is running with the model named in `config/default.json`.

4. Check that everything is reachable:

   ```bash
   curl localhost:8000/health/dependencies
   ```

   `ok` means Nightshift answers. `degraded` means only the Ollama backup does. `unavailable`
   (HTTP 503) means no model provider answers.

5. Optional live test of the model layer against the real services:

   ```bash
   npm run test:live
   ```

### Sample mode

`SAMPLE_MODE=true` runs without any credentials: model calls fall back to local providers and then
to a clearly labelled rule-based generator. See [Configuration](#configuration).

## Configuration

No URL, model name or timeout is written in the source code. Configuration is layered, lowest priority
first:
1. `config/default.json` — committed, non-secret defaults (URLs, pinned modes, timeouts, limits).
2. The file named by `CONFIG_FILE` — optional per-environment overrides. It must not contain secrets.
3. Environment variables — the only place secrets may come from.

The process validates the result at start-up and refuses to run on invalid configuration. Secrets are
held in a `Secret` wrapper that prints as `[REDACTED]`, and every log line and trace event is scrubbed
of known secret values.

| Variable                                  | Overrides                      | Notes                                                                                               |
| ----------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `HOST`, `PORT`                            | `server.host`, `server.port`   | Defaults `0.0.0.0` and `8000`.                                                                      |
| `LOG_LEVEL`, `LOG_DIR`                    | `logging.level`, `logging.dir` | A relative `LOG_DIR` is resolved from the project root.                                             |
| `SAMPLE_MODE`                             | `sampleMode`                   | `true` or `false`.                                                                                  |
| `CONFIG_FILE`                             | —                              | Path to an extra JSON overrides file.                                                               |
| `ZETARIS_REST_URL`, `ZETARIS_ORG_ID`      | `zetaris.*`                    |                                                                                                     |
| `ZETARIS_API_KEY`                         | `zetaris.apiKey`               | Secret.                                                                                             |
| `METERLESS_BASE_URL`, `METERLESS_APP_ID`  | `nightshift.*`                 |                                                                                                     |
| `METERLESS_RUNTIME_TOKEN`                 | `nightshift.runtimeToken`      | Secret.                                                                                             |
| `METERLESS_MODEL_FAST`, `_DEEP`, `_JUDGE` | `nightshift.models.*`          | Must be a pinned mode such as `meterless/fast`.`meterless/auto` and plain model names are rejected. |
| `METERLESS_RECEIPT_PUBLIC_KEY`            | `nightshift.receiptPublicKeys` | Comma separated base64 Ed25519 keys. Pin the runtime's key to mark its receipts `valid_pinned`.     |
| `OLLAMA_BASE_URL`, `OLLAMA_MODEL`         | `ollama.*`                     | Backup provider.                                                                                    |

## API

All errors have one shape: `{ "status": "error", "request_id": "...", "error": { "type", "message", "recoverable" } }`.
Every response carries an `x-request-id` header; a safe caller-supplied id is echoed back.

| Method and path                 | Purpose                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /health`                   | Liveness. Never touches other services.                                             |
| `GET /health/dependencies`      | Readiness: probes Nightshift and Ollama. 200 `ok` or `degraded`, 503 `unavailable`. |
| `GET /policy`                   | The active policy with its version and content hash.                                |
| `GET /policy/versions`          | All versions with status, proposer and approver.                                    |
| `GET /policy/versions/:version` | One version. 404 if unknown.                                                        |
| `GET /policy/audit`             | Append-only audit log of policy actions.                                            |
| `POST /run`                     | Submit an alert for review (see below).                                             |
| `GET /runs/:runId/events`       | The recorded events of a run, as the trace file holds them.                         |

### `POST /run`

```bash
curl -X POST localhost:8000/run \
  -H 'content-type: application/json' \
  -d '{"alert_type":"payment","alert_id":"P-0001"}'
```

| Field                 | Notes                                          |
| --------------------- | ---------------------------------------------- |
| `alert_type`          | `customer` (default) or `payment`.             |
| `alert_id` or `alert` | One of them is required.                       |
| `run_id`              | Optional. Letters, digits, `.`, `_`, `-` only. |
| `options.sample_mode` | Optional boolean.                              |

The request is validated, the active policy version is pinned for the run, and a trace is opened
(`logs/trace-<run_id>.jsonl`). While the agent pipeline is not enabled in a build, the response is
`501` with a structured `not_implemented` error and the pinned `policy_version`. The endpoint never
returns an invented decision.

## Policy

`config/policy.default.json` is the initial policy. The schema (`packages/shared/src/policy.ts`)
covers lists and weights, match thresholds and strong identifiers, the ownership threshold and chain
depth, embargoed jurisdictions and their actions, automation limits, the critic's round limit and
confidence floor, the model, thinking mode and timeout per agent, the Zetaris role per agent, and the
guard texts.

These are locked in the schema and cannot be switched on by any policy document:
- `autoBlock` is `false`
- `messageCustomers` is `false`
- `dataAccess` is `read_only`
- blocks need `2` approvals
- a depth-limit or circular ownership result always goes to a human
- records that fail data-quality rules never support an automatic close

Changing the policy is a draft, then a publish by a different person (four-eyes). Publishing swaps the
active version immediately; runs already in flight keep the version they started with. Rolling back
republishes an old version's content as a new version.

## Traces, events and receipts

Every run writes `logs/trace-<run_id>.jsonl`. Each line is one event with the agent, action, summaries,
target agent, confidence, retry count, status, requested and used model, route kind (`local` or
`cloud`), latency, tokens, Zetaris query id, policy version and the signed receipt. Secrets are
redacted before a line is written, and the same object is published on the event bus.

A Nightshift receipt is signed with Ed25519 over the sorted-key JSON of its body. The generator
reports one of:

| Status           | Meaning                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `valid_pinned`   | The signature is valid and the key is one of `nightshift.receiptPublicKeys`.                                               |
| `valid_unpinned` | The signature is valid, but the key came from the same response. It proves the receipt was not altered, not who signed it. |
| `invalid`        | The signature does not match the body.                                                                                     |
| `malformed`      | The receipt is not in the expected format.                                                                                 |

The runtime also reports the mode it served and whether the answer came from its cache. Both are
recorded, and a served mode that differs from the pinned one is logged as a warning.

## Docker

```bash
docker compose up --build
curl localhost:8000/health
```

The compose file reads an optional `.env`; a clean clone runs without one. Inside the container the
services on your machine are reached through `host.docker.internal`; override with
`DOCKER_METERLESS_BASE_URL`, `DOCKER_OLLAMA_BASE_URL` and `DOCKER_ZETARIS_REST_URL`. Traces are written
to `./logs` on the host. The container runs as an unprivileged user and has a health check.

## Development

| Command                 | What it does                                                                     |
| ----------------------- | -------------------------------------------------------------------------------- |
| `npm run dev`           | Start the API with reload.                                                       |
| `npm run typecheck`     | TypeScript, strict mode.                                                         |
| `npm run lint`          | Biome lint and format check.                                                     |
| `npm run format`        | Apply Biome fixes.                                                               |
| `npm test`              | Unit tests.                                                                      |
| `npm run test:coverage` | Unit tests with coverage gates (90% lines, functions, statements; 80% branches). |
| `npm run test:live`     | Live checks against the real Nightshift and Ollama.                              |
| `npm run ci`            | Typecheck, lint and tests with coverage, as CI runs them.                        |
| `npm run verify`        | Whole-environment check (containers, Zetaris, Nightshift, Ollama, repo hygiene). |

`npm run verify`, `check:zetaris` and `check:nemotron` are standard-library Python scripts in
`scripts/`; run them with [uv](https://docs.astral.sh/uv/). They are environment checks, not part of
the application.

## Project layout

```
apps/api/            Fastify API: routes, error mapping, logger, dependency probes
packages/shared/     Config, secrets, model seam, policy, event bus, traces, records, receipts
config/              default.json (settings) and policy.default.json (initial policy)
scripts/             Environment check scripts (Python, standard library)
.github/workflows/   CI
```

## Security

- Secrets come only from environment variables and are never logged, traced or returned by the API.
- Run ids and receipt ids that become file names are restricted to a safe alphabet.
- Request bodies are size limited; unknown configuration or policy keys are rejected.
- Error responses never include internal messages; details go to the server log.
- The audited data path is read-only by policy and by schema.

## Licence

Apache-2.0. See `LICENSE` and `THIRD_PARTY_NOTICES.md`.
