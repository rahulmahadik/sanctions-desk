# Development

| Command                             | What it does                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `npm run ci`                        | Typecheck, lint, voice lint and all tests with coverage gates (90 percent lines, functions, statements; 80 percent branches). |
| `npm test`, `npm run test:coverage` | Unit tests.                                                                                                                   |
| `npm run test:engines`              | Official Meterless conformance runners against our engines.                                                                   |
| `npm run test:live`                 | Live checks against Nightshift and Ollama.                                                                                    |
| `npm run verify`                    | Whole-environment check (containers, Zetaris, Nightshift, Ollama, repository hygiene).                                        |
| `npm run check:isolation`           | Proves the data containers are reachable by Zetaris only.                                                                     |
| `npm run data:synthetic`            | Rebuild the seeded synthetic bank and the exam from the committed list sample.                                                |
| `npm run sample:record`             | Record the sample-mode cache from live Zetaris.                                                                               |

Layout: `apps/api` (HTTP), `apps/web` (review desk interface), `apps/payments-api` (synthetic payments service), `packages/shared` (configuration, model seam, policy, events, records, receipts), `packages/data` (list parsers, matching, synthetic bank, exam), `packages/zetaris` (client, SQL guard, semantic-layer specification and scripts), `packages/agents` (the review steps), `packages/engines` (the three Meterless engines), `tools/`, `zetaris/sql/`, `docker/`, `eval/`, `docs/`.

The governance view, mapped to the headings of the Monetary Authority of Singapore's proposed AI risk management guidelines (a mapping, not a compliance claim), is in [docs/GOVERNANCE.md](GOVERNANCE.md) and on the Governance page of the review desk.

## The review desk interface

```bash
npm install
SAMPLE_MODE=true npm run dev                  # the API on :8000
npm run dev -w @sanctions-desk/web            # the interface on :3001
npm run build -w @sanctions-desk/web          # production build
```

The browser calls the API directly, so the API lists the interface's origin (`WEB_ORIGINS`); set `NEXT_PUBLIC_API_URL` when the API is not on `localhost:8000`.
