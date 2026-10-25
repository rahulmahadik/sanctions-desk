# Setup

How to run the desk: in sample mode with Docker, live against Zetaris and Nightshift, and where the data comes from. Every setting is in [CONFIGURATION.md](CONFIGURATION.md).

## Try it in two minutes

Needs Docker, nothing else: no Zetaris, no model service, no credentials.

```bash
git clone https://github.com/rahulmahadik/sanctions-desk.git && cd sanctions-desk
SAMPLE_MODE=true docker compose up --build        # the API on http://localhost:8000, the review desk on http://localhost:3001

curl -s localhost:8000/run -H 'content-type: application/json' \
  -d '{"alert_id":"ALR-0004"}' | jq '{decision, confidence, rationale, critic, record_hash, sample_notice}'
curl -s localhost:8000/cases/ALR-0004/trace | jq '.definitions, .access, .cost.totals'
curl -s localhost:8000/list-change/replay -X POST -H 'content-type: application/json' -d '{}' | jq '.impact, (.reopen | length), (.release | length)'
```

Open http://localhost:3001 for the review desk: pick an alert, press **Review this alert** and watch the steps light up as the real events arrive. See [Review desk interface](USER_GUIDE.md#review-desk-interface). Sample mode runs the real agents on saved answers from real Zetaris queries, with a labelled rules-based stand-in for the language model. See [docs/SAMPLE_MODE.md](SAMPLE_MODE.md). Example inputs are in `input_examples/` and real outputs saved from live runs are in `output_examples/`.

## Run it live

Needs Zetaris running locally, the Nightshift runtime, and optionally Ollama.

```bash
npm ci
cp .env.example .env                       # then add your own values; never commit .env
docker compose --env-file .env.data --profile data up -d --build bankdb payments-api   # synthetic bank + payments (see below)
npm run zetaris:rebuild                    # create everything in Zetaris from the committed scripts
npm run dev                                # the API on http://localhost:8000
npm run exam -- --variant routed           # the <!--fact:exam_cases-->70<!--/fact-->-case exam against live services
```

The `data` profile needs `BANKDB_ADMIN_PASSWORD`, `BANKDB_READER_PASSWORD` and `PAYMENTS_API_KEY` (any random values; keep them in a git-ignored file such as `.env.data`). The two containers join the Zetaris network only and publish no ports; `npm run check:isolation` proves that Zetaris can reach them and nothing else can.

Create the three non-admin Zetaris users and tokens as described in [docs/ZETARIS.md](ZETARIS.md#roles-identities-and-tokens).

**Running the API in Docker against live services.** `SAMPLE_MODE=false docker compose up --build` runs the API in a container. Inside a container, `localhost` is the container itself, so Zetaris, Nightshift and Ollama on the host are reached at `http://host.docker.internal:<port>`: `ZETARIS_REST_URL=http://host.docker.internal:8888/api/v1.0`, `METERLESS_BASE_URL=http://host.docker.internal:8088/v1`, `OLLAMA_BASE_URL=http://host.docker.internal:11434/v1`. Compose sets these three for the `api` service (override them with `DOCKER_ZETARIS_REST_URL`, `DOCKER_METERLESS_BASE_URL`, `DOCKER_OLLAMA_BASE_URL`) and adds `extra_hosts: host.docker.internal:host-gateway`, which makes the name resolve on Linux as well as on Docker Desktop. The image sets `HOST=0.0.0.0` so the API listens inside the container; outside a container the default is `127.0.0.1`, and compose publishes the port on `127.0.0.1` unless `BIND_ADDRESS` says otherwise.

## Data sources and licences

| Data                                                                                       | Source                                     | Licence / note                                                                                                                   |
| ------------------------------------------------------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| OFAC SDN and consolidated list (`data/sample/`: 366-entry subset)                          | US Treasury OFAC, public download          | Public-domain US government data                                                                                                 |
| UN Security Council consolidated list (subset)                                             | scsanctions.un.org, public download        | Public; no explicit licence stated                                                                                               |
| GLEIF LEI records and parent relationships (`data/reference/gleif/`: 74 records, 48 links) | GLEIF public API                           | CC0 1.0, https://www.gleif.org/en/meta/lei-data-terms-of-use                                                                     |
| Customers, accounts, owners, payments, alerts, earlier decisions                           | Built by `npm run data:synthetic` (seeded) | **Synthetic**; every table says so. The list update used for re-opening cases is a labelled synthetic edit of a few real entries |

`npm run data:fetch`, `data:normalise` and `data:sample` rebuild the list data from the public sources.
