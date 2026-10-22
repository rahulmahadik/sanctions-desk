# sanctions-desk

An AI review desk for bank sanctions screening alerts. It clears false alarms with cited evidence,
looks for hidden risk that name matching misses (such as company ownership and list changes), and
remembers past decisions. A human always makes the final call.

Built for the Open Agent Hackathon 2026, Track 03 (Reasoning Architecture).

> **Status: work in progress.** The project skeleton (shared library, API shell, Docker) is in
> place. The agents, data layer and UI are not built yet. This README will be completed before
> submission and will only describe what exists.

## Run what exists today

Requirements: Node 22 or newer, npm, Docker (optional).

```bash
npm install
npm run typecheck
npm test
npm run dev          # API on http://localhost:8000
curl localhost:8000/health
```

`POST /run` currently answers with a structured `not_implemented` error. It never returns made-up
decisions.

## Configuration

Copy `.env.example` to `.env` and fill in your own values. Never commit `.env`.

## Licence

Apache-2.0. See `LICENSE` and `THIRD_PARTY_NOTICES.md`.
