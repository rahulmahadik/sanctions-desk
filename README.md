# Sanctions Desk

- **Who it is for:** sanctions screening analysts and their senior reviewers at a bank.
- **What goes wrong today:** name screening raises far more alerts than there are real matches; each one is worked by hand, field by field, and the costly mistake is closing the one that is real.
- **What it gives them:** for every alert, the evidence gathered through one data layer, every cited fact re-checked, risk signals from notes shown with the exact text they rest on, and a recommendation with its reasons.
- **How it stays safe:** it fails closed (missing evidence or any failed check escalates instead of closing), and a person decides every alert.
- **Privacy and proof:** raw notes stay on the analyst's machine and the cloud model sees structured facts only; every model call has a signed receipt.

<!-- badges:start -->
[![CI](https://github.com/rahulmahadik/sanctions-desk/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/rahulmahadik/sanctions-desk/actions/workflows/ci.yml) [![TypeScript 7](https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white)](package.json) [![Node >=24](https://img.shields.io/badge/node-%3E%3D24-339933?logo=nodedotjs&logoColor=white)](package.json) [![License Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
<!-- badges:end -->

![Architecture: agents, Zetaris as the only data path, local and cloud Nemotron through Nightshift, a raise-only policy guard and a person who decides](docs/media/architecture.png)

<table>
<tr>
<td width="33%"><img src="docs/media/screenshots/09-risk-signals.png" alt="Case view: a risk signal with its source field and the exact span highlighted in the payment reference"></td>
<td width="33%"><img src="docs/media/screenshots/13-live-agent-map.png" alt="Review steps of a live review: local Lightning and cloud Ultra chips, the routed model and the signed receipt id per model step"></td>
<td width="33%"><img src="docs/media/screenshots/11-heldout-rounds.png" alt="Test scores: every held-out round as run, with the baselines"></td>
</tr>
<tr>
<td>A risk signal with its source field and the exact text span (sample mode)</td>
<td>The review steps of a live review: where each model step ran, the model that served it and its receipt</td>
<td>Every held-out round as run, with the baselines, from the result files</td>
</tr>
</table>

An AI review desk for bank sanctions-screening alerts. For every alert it reads the evidence from the bank's data, compares the customer (or payment party, or owner) with the listed party under approved definitions, asks Nemotron models for a recommendation, has a second step re-read every cited fact, applies a written policy, and hands a **recommendation with its evidence** to a person. **A human always makes the final call**: the desk never blocks, never writes to a source system and never messages a customer.

**Privacy: raw notes stay on the analyst's machine.** Customer notes, payment references and list remarks are read only by a local Nemotron model on the analyst's laptop; the cloud model receives structured facts only (fields from the bank's data, risk signals with the position they point at, document checks as yes or no), never the free text and never an identifier number. If a screener answer ever came from a cloud route, the case record flags it.

**Who uses it.** A sanctions screening analyst at a bank, who works each alert raised by name screening, and a senior reviewer, who approves blocks and less cautious overrides. **What they get per alert:** the evidence gathered from the bank's data in one place, every cited fact re-checked against that data, risk signals from the free text with the exact field and span they rest on, a recommendation with its reasons, and a signed case record of what was used and who decided. **What it saves them:** the gathering and cross-checking an analyst now does by hand (looking up the customer, the payment, the list entry and earlier decisions, and comparing them field by field), and a written reason for every alert. Analyst time saved has not been measured, so no figure is claimed; the desk's own time per alert is measured (see the evaluation).

Built for the Open Agent Hackathon 2026, Track 03 (Reasoning Architecture).

<!-- headline:start -->
**Safe triage that fails closed.** The desk recommends and a person decides; when evidence is missing or any check fails it escalates instead of closing. On the 70-case exam (the cases the rules were written for) the full system wrongly closed 0 of 42 risk cases, against 10 for plain name matching. On the blind held-out rounds, the risk cases it wrongly closed were: 2 in held-out v1; 0 in held-out v2 (the screener had failed, so nothing was closed); 2 in held-out v3; 0 in held-out v4. Each round, what it found and what was changed after it are in the table below. **No claim of clearing alerts beyond the rules:** on the exam every close it makes is one the deterministic rules also make, and across the blind held-out rounds it made 0 correct clears, against 8 for the deterministic rules (which also close risk cases there). Every figure is one run. Details: [eval/REPORT.md](eval/REPORT.md).
<!-- headline:end -->

## Start here

|                             |                                                                                                                                                                                                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Video**                   | link added when the video is recorded ([Demo video](#demo-video))                                                                                                                                                                                                                                                              |
| **Slides**                  | link added when the slides are ready ([Slides](#slides))                                                                                                                                                                                                                                                                       |
| **Two-minute sample path**  | `SAMPLE_MODE=true docker compose up --build`, open http://localhost:3001, pick a demo user, open alert **ALR-0004** and press **Review this alert**. No account, key or model is needed; the data is replayed from saved real answers and the language model is a labelled stand-in ([AI and Model Usage](#ai-and-model-usage)) |
| **Live path**               | Zetaris, Nightshift and the synthetic bank running locally: [Run it live](#run-it-live)                                                                                                                                                                                                                                         |
| **Traces and receipts**     | the **Decision trace** and **Model routing** panels of every case (with a _Verify receipt_ button); `eval/runs/<run-id>/` holds the exported events and Nightshift's signed receipts; check them with `npm run evidence:verify` ([Check which model served each call](#check-which-model-served-each-call))                     |
| **Evidence for the claims** | [eval/REPORT.md](eval/REPORT.md), [docs/EVALUATION.md](docs/EVALUATION.md), [docs/SPONSORS.md](docs/SPONSORS.md), [docs/ZETARIS.md](docs/ZETARIS.md#zetaris-checklist)                                                                                                                                                          |

**Where to look**

| Question | Where it is answered |
| --- | --- |
| What happens when it fails? | [Failure handling](#failure-handling); a case the critic sent back: [output_examples/need-more-info-critic-sent-back/case.md](output_examples/need-more-info-critic-sent-back/case.md); Zetaris unreachable: `eval/results/2026-10-23T23-49-30-051Z-zdown-routed.json`; a signal that is not grounded still blocks a close: [screenshot](docs/media/screenshots/14-live-risk-signal-not-grounded.png); [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md) |
| What does it do without being asked? | [What it does on its own](#what-it-does-on-its-own) and [Can and cannot, step by step](#can-and-cannot-step-by-step) |
| How can a person tell afterwards what it did? | The sealed decision record and the run's events, for example [output_examples/sample-mode/ALR-0073/](output_examples/sample-mode/ALR-0073); `GET /cases/:alertId/trace`; `npm run ledger -- --case <alert id>`; the case view's decision trace and replay ([screenshot](docs/media/screenshots/02-case-evidence.png)); [One real trace](#one-real-trace) |
| Which model answered each call? | The routing panel ([screenshot](docs/media/screenshots/15-live-routing-and-receipts.png)); the trace fields `model_requested`, `model_used` and `receipt` on every model call (for example seq 25 in [output_examples/close-stopped-by-policy-guard/run-events.jsonl](output_examples/close-stopped-by-policy-guard/run-events.jsonl)); `npm run evidence:verify` ([Check which model served each call](#check-which-model-served-each-call)) |
| How can the results be re-checked? | `npm run prove` (below); `npm run evidence:verify`; `npm run exam:report` rebuilds [eval/REPORT.md](eval/REPORT.md) and the held-out table from `eval/results/` |

<!-- prove:start -->
**One-command proof** (`npm run prove`, no credentials or services; last run 2026-10-24T05:42:42.265Z on commit 20a8653):

```text
PASS  Sample-mode review: POST /run ALR-0004 -> CLOSE_FALSE_POSITIVE, sealed record 1bd95dce088d… verifies, sample notice shown, human review required (0.1 s)
PASS  Engine conformance: H-MEM 13/13, World Model 8/8, Markovian 8/8 (0.9 s)
PASS  Critic mutation test: 147/147 false cited facts caught over 25 decisions; 25/25 unchanged decisions approved (no false alarm); evidence standard: 5 of 5 pass; grounding and document-on-record: 3 of 3 pass (0.5 s)
PASS  Signed evidence: 28 runs: 1492/1492 receipts verified (signing key taken from each receipt, not pinned); 1492/1492 model calls have a receipt; 0 trace/receipt model mismatches (0.2 s)
PASS  Roles and four-eyes: 82/82 tests passed (pentest-access 56/56, people 26/26), 0 failed (0.9 s)
PASS  Preregistration: heldout.json cases 1-18 match; heldout.json cases 1-22 match; heldout2.json file hash matches; held-out v2 freeze commit 8f6976c is in the history; heldout3.json file hash matches; held-out v3 frozen in commit 02d0a2e, the same file; heldout4.json file hash matches; held-out v4 frozen in commit fc64537, the same file (0.0 s)
PASS  No secrets in the tree: 567 tracked text files scanned: 0 credential-bearing URLs, private keys or tokens; no .env file tracked (0.1 s)
PASS: 7 of 7 checks passed
```

Reproduce with `npm ci && npm run prove`, or `npm run prove -- --fresh` to clone this commit into a temporary folder, install and run the same checks there. Details: [eval/PROVE.md](eval/PROVE.md).
<!-- prove:end -->

**Headline numbers** (from the saved runs; refreshed by `npm run exam:report`):

<!-- rounds:start -->
- **Wrongly closed on the 42 risk cases of the exam:** full system **0**, plain name matching 10.
- **Every held-out round, as run**, with the baselines on the same frozen cases (cases the rules were not written for; one run each). The same table, from the same result files, is on the review desk's test-scores screen. Wrong closes are in bold and stay in this table:

| Round | Full system | Single (no critic, no challenger) | Deterministic rules | Name match | Escalate everything |
|---|---|---|---|---|---|
| Held-out v1 (30 cases) | **2 of 22 risks closed (HO-005, HO-006); 0 of 8 clears** | not run | **6 of 22 risks closed (HO-001, HO-003, HO-004, HO-005, HO-006, HO-011); 0 of 8 clears** | **8 of 22 risks closed (HO-005, HO-006, HO-007, HO-008, HO-009, HO-010, HO-011, HO-017); 0 of 8 clears** | 0 of 22 risks closed; 0 of 8 clears |
| Held-out v2 (19 cases) | 0 of 14 risks closed; 0 of 5 clears | not run | **3 of 14 risks closed (HO2-001, HO2-002, HO2-003); 5 of 5 clears** | **8 of 14 risks closed (HO2-001, HO2-002, HO2-003, HO2-004, HO2-005, HO2-006, HO2-007, HO2-017); 0 of 5 clears** | 0 of 14 risks closed; 0 of 5 clears |
| Held-out v2, re-run after an infrastructure fix (not blind) | 0 of 14 risks closed; 0 of 5 clears | not run | **3 of 14 risks closed (HO2-001, HO2-002, HO2-003); 5 of 5 clears** | **8 of 14 risks closed (HO2-001, HO2-002, HO2-003, HO2-004, HO2-005, HO2-006, HO2-007, HO2-017); 0 of 5 clears** | 0 of 14 risks closed; 0 of 5 clears |
| Held-out v3 (12 cases) | **2 of 6 risks closed (HO3-001, HO3-003); 0 of 6 clears** | 0 of 6 risks closed; 0 of 6 clears | **1 of 6 risks closed (HO3-005); 1 of 6 clears** | **5 of 6 risks closed (HO3-001, HO3-002, HO3-004, HO3-005, HO3-006); 0 of 6 clears** | 0 of 6 risks closed; 0 of 6 clears |
| Held-out v4 (12 cases, last round) | 0 of 6 risks closed; 0 of 6 clears | 0 of 6 risks closed; 0 of 6 clears | **3 of 6 risks closed (HO4-002, HO4-003, HO4-005); 2 of 6 clears** | **5 of 6 risks closed (HO4-001, HO4-003, HO4-004, HO4-005, HO4-006); 0 of 6 clears** | 0 of 6 risks closed; 0 of 6 clears |

- **What each round found and what changed after it:**

| Round | System tested | What it found | What changed after |
|---|---|---|---|
| Held-out v1 (30 cases) | first system (`8fe6205`) | risk stated only in free text (a note, a payment reference) never reached the decision | a local screener reads the free text and passes risk signals; a signal blocks a close |
| Held-out v2 (19 cases) | screener added; it failed on every case (`8f6976c`) | the local screener failed on every case (empty answers to schema-constrained requests); fail-closed held | plain JSON for the screener and local retries (`d44ee04`); no prompt, rule or threshold change |
| Held-out v2, re-run after an infrastructure fix | screener answering in plain JSON (`d44ee04`) | the screener over-flagged (signals pointing at text with no relation word); the critic deadlocked on uncheckable citations | span grounding of signals, document numbers checked against the customer record, citable-source list (`8f4c660`) |
| Held-out v3 (12 cases) | span grounding (`e56b204`) | two relationship notes were closed: the decision first escalated, citing the screener's signals; the critic rejected those citations as not citable; the decision then closed, and the guard let it stand because grounding had marked the signals not grounded. Four clears were stopped by the document-on-record rule, as that rule intends | fail closed: every signal at or above its threshold blocks a close, grounded or not (`80902ea`, policy 8) |
| Held-out v4 (12 cases, last round) | fails closed (`80902ea`) | no risk case closed; no clear made: every clear carried a relationship signal the screener could not ground, which now blocks (the cost of failing closed) | nothing; this was the last held-out round |
<!-- rounds:end -->

Rules settle what structured data can. On the cases the rules were written for, the deterministic pipeline is exact by design; on every held-out round it also closed risk cases (the table above), which is why the desk never closes on rules alone. The full system did not always do better: it wrongly closed 2 risk cases on held-out v1 (both also closed by the rules) and 2 on v3 (which the rules did not close); on v2 and v4 it closed none, where the rules closed 3 each. It made no clears the rules miss.

Counts in this README (<!--fact:exam_cases-->70<!--/fact--> exam cases in <!--fact:exam_groups-->12<!--/fact--> groups, <!--fact:heldout_cases-->30<!--/fact--> cases in the first held-out set (73 across the four held-out sets), <!--fact:edge_cases-->43<!--/fact--> edge cases) are written by `npm run readme:refresh` from the committed data.

## Run one case

One review from the command line, without the interface or a server. The request file holds the same body as `POST /run`; with `SAMPLE_MODE=true` no service or key is needed.

```bash
npm install
SAMPLE_MODE=true npm run -s case -- input_examples/run-ALR-0004.json
```

The same review over HTTP, with the API running (`npm run dev`, or `docker compose up --build`):

```bash
curl -s localhost:8000/run -H 'content-type: application/json' -d @input_examples/run-ALR-0004.json
```

While it runs, `npm run case` prints one short line per step (time, agent, action, status, summary, receipt id; turn off with `TRACE_STDOUT_PRETTY=false`), then one JSON object. Shape of the answer (values from a sample-mode run; `POST /run` returns these fields and more):

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

A review that cannot run prints `{"status": "error", ..., "error": {"type": "...", "message": "..."}}` and exits with a non-zero code. The request files and the kind of outcome each one gives are in [input_examples/README.md](input_examples/README.md).

## One real trace

A recorded case where the decision's first recommendation was to **close a risk case**, and the checks stopped it. The lines below are copied from the saved run by a script, not written by hand.

<!-- realtrace:start -->
Case **EX-064** (alert ALR-0073), first-system run of 23 Oct 2026, copied by `npm run readme:trace` from [output_examples/close-stopped-by-policy-guard](output_examples/close-stopped-by-policy-guard) (the same events are in the signed evidence export `eval/runs/routed-20261023T133311Z`). The label is ESCALATE_L2; closing it is a must-not.

| Seq | Agent | Action | Target | Model (requested → routed) | Status | Summary |
|---:|---|---|---|---|---|---|
| 24 | triage | path |  |  | ok | reason: the structured evidence points to CLOSE_FALSE_POSITIVE, but there is free text to weigh: the payment reference |
| 25 | decision | model_answer |  | meterless/deep → nvidia/nemotron-3-ultra-550b-a55b (receipt `rcpt_req_t9gx190b`) | ok | valid answer on attempt 1 |
| 26 | decision | recommend | critic |  | ok (0.95) | CLOSE_FALSE_POSITIVE: The counterparty name matches exactly but the counterparty country NL is not among the listed party's address countri… |
| 27 | critic | verify_facts |  |  | ok | 5 verified, 0 issues |
| 28 | critic | model_answer |  | meterless/judge → nvidia/nemotron-3-ultra-550b-a55b (receipt `rcpt_req_w1li6vf1`) | ok | valid answer on attempt 1 |
| 29 | critic | judge | policy_guard |  | ok | approved |
| 30 | policy_guard | apply_policy |  |  | blocked (0.6) | CLOSE_FALSE_POSITIVE raised to ESCALATE_L2 |
| 31 | reporter | seal_record |  |  | ok | record rec-eval-routed-EX-064 sealed |

- **What happened:** the decision's first recommendation was CLOSE_FALSE_POSITIVE at confidence 0.95, and the critic approved it (5 verified, 0 issues): the cited facts were true. The policy guard then blocked the close on a rule.
- **The rule that blocked:** `jurisdiction`: watched jurisdiction: IR (payment reference mentions "Tehran").
- **Final outcome:** ESCALATE_L2 at confidence 0.6, sealed as record `c2d235499ba6…`.
- **The human step:** none recorded yet: the recommendation waits for a person. An analyst or approver approves it or overrides it with a reason against the sealed record; only an approver may override towards a close. The escalation ticket is prepared only after that decision, and nothing is sent.
<!-- realtrace:end -->

## Demo video

Link added when recorded.


## Slides

Link added when the slides are ready.

## Track 3 fit

Track 3 asks for a reasoning architecture, not a prompt. Each stage of the desk is a separate, checked step:
- **Data:** every fact comes through one Unified Semantic Layer in Zetaris, under per-agent roles and data-quality rules.
- **Knowledge:** approved, versioned definitions are data; ownership is worked out by the World Model engine and the 50 percent rule runs in code.
- **Memory:** H-MEM keeps earlier decisions, and the decisions people make on the desk, as pointers that go stale when the listed entry changes; a decision can cite one and the critic checks it.
- **Reasoning:** code gives a first finding, Nemotron models decide, a critic re-reads every cited fact from the data, a challenger argues against a close, and a policy guard can only make the result more cautious.
- **Human decision and action:** a person approves or overrides with a reason (a block needs two), and only then is the next action prepared. Nothing is sent or changed in a source system.

## Contents

- [Start here](#start-here)
- [Run one case](#run-one-case)
- [One real trace](#one-real-trace)
- [Demo video](#demo-video)
- [Slides](#slides)
- [Track 3 fit](#track-3-fit)
- [What it does](#what-it-does)
- [Try it in two minutes](#try-it-in-two-minutes)
- [How it works](#how-it-works)
- [What it does on its own](#what-it-does-on-its-own)
- [Can and cannot, step by step](#can-and-cannot-step-by-step)
- [How sponsor technology is used](#how-sponsor-technology-is-used)
- [The decision trace](#the-decision-trace)
- [Review desk interface](#review-desk-interface)
- [Evaluation](#evaluation)
- [Edge cases handled](#edge-cases-handled)
- [Guardrails](#guardrails)
- [Failure handling](#failure-handling)
- [Responsible AI](#responsible-ai)
- [Data sources and licences](#data-sources-and-licences)
- [Run it live](#run-it-live)
- [Configuration](#configuration)
- [API](#api)
- [Policy](#policy)
- [Development](#development)
- [FAQ](#faq)
- [Not built / not verified](#not-built--not-verified)
- [Limits](#limits)
- [Future work](#future-work)
- [AI and Model Usage](#ai-and-model-usage)
- [Pre-existing work](#pre-existing-work)
- [Third-party code and licence](#third-party-code-and-licence)

## What it does

Name matching raises far more alerts than there are real matches. The desk works the way a careful analyst does:

| Alert                                                    | What the desk checks                                                                                              | Typical outcome                                                                                                                                     |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| A customer's name resembles a listed party               | Date of birth, nationality, document numbers, aliases in other scripts, look-alike letters, earlier decisions     | Close a clear false positive with cited evidence; escalate a true match; ask for more information when data is missing                              |
| A payment counterparty resembles a listed party          | Counterparty name and country, watched jurisdictions                                                              | Escalate a match; refuse to clear a payment with no usable country                                                                                  |
| A listed party appears on a company's ownership register | Effective ownership through chains and several owners, exactly at the 50 percent line, loops, missing percentages | Escalate at or above the threshold; close below it; ask when a percentage is missing                                                                |
| The sanctions list changes                               | Every earlier decision against the entry as it is now                                                             | Re-open cleared cases whose entry changed; offer delisted parties for release by a person; say how many customers and pending payments are affected |
| Text in the data tries to instruct the reviewer          | A safety guard with a written policy and fixed patterns                                                           | Flag it, treat it as data, never close because of it                                                                                                |

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

Open http://localhost:3001 for the review desk: pick an alert, press **Review this alert** and watch the steps light up as the real events arrive. See [Review desk interface](#review-desk-interface). Sample mode runs the real agents on saved answers from real Zetaris queries, with a labelled rules-based stand-in for the language model. See [docs/SAMPLE_MODE.md](docs/SAMPLE_MODE.md). Example inputs are in `input_examples/` and real outputs saved from live runs are in `output_examples/`.

**Check the claims without Docker.** With Node 24, `npm ci && npm run prove` runs seven checks in a few seconds once installed and prints one PASS or FAIL line each, then a summary; it exits with 1 if any check fails. It needs no credentials and no services, forces sample mode and never reads `.env`:

| Check                  | What it does                                                                                                                                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sample-mode review     | Starts the API in the same process, runs `POST /run` for ALR-0004 and checks the sealed record on disk: its SHA-256 hash verifies and the answer carries the sample notice                                                                                              |
| Engine conformance     | Runs the vendored conformance suites of H-MEM, the World Model and the Markovian engine (`npm run test:engines`) and reports each score                                                                                                                                 |
| Critic mutation test   | Changes one cited fact at a time to a false value and runs only the critic against the same evidence; every change must be caught and unchanged decisions approved. Also checks the evidence standard and the grounding of screener signals (`npm run critic:mutation`) |
| Signed evidence        | Verifies every receipt signature in `eval/runs` and that every model call in the traces has its receipt naming the same model (`npm run evidence:verify`)                                                                                                               |
| Roles and four-eyes    | Runs the API's access tests (every role against every route that changes something) and the human-decision tests, and reports the pass counts                                                                                                                           |
| Preregistration        | Recomputes the held-out case-file hashes pinned in the tests, checks that the final freeze commit of the second held-out set is in the history, and that the third and fourth sets\' files equal the ones in their freeze commits                                                      |
| No secrets in the tree | Scans the tracked text files for credential-bearing URLs, private keys and tokens, and reports counts only                                                                                                                                                              |

`npm run prove -- --verbose` also prints what each check printed. `npm run prove -- --fresh` clones the current commit into a temporary folder, runs `npm ci --no-audit --no-fund` there and runs the same checks inside it; it needs network access for npm and takes a few minutes. `npm run prove -- --write` writes the list to `eval/PROVE.md` and to the block at the top of this README.

## How it works

```mermaid
flowchart LR
  A[Alert] --> T[Triage]
  T --> E[Evidence]
  E -->|one SELECT at a time| Z[(Zetaris<br/>semantic layer)]
  Z --- L[List files]
  Z --- B[(bank database<br/>JDBC)]
  Z --- P[payments service<br/>REST]
  E --> S[Safety guard]
  S --> F[Screener<br/>local model]
  F --> M[Matching<br/>or Ownership]
  M --> Y[Memory<br/>pointers]
  Y --> D[Decision<br/>Nemotron]
  D <--> C[Critic<br/>re-reads cited facts]
  C --> G[Policy guard]
  G --> R[Reporter<br/>sealed decision record]
  R --> H{{A person decides}}
```

| Step         | What it does                                                                                                                                                                                                                                                                                                                                                                     | Uses a model                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Triage       | Chooses the path, decides whether the case is clear or contested                                                                                                                                                                                                                                                                                                                   | No                                                |
| Evidence     | Reads the semantic layer's own description, then builds one read-only tool per table and reads the alert, customer, list entry, aliases, dates, countries, identifiers, data-quality results and the approved definitions                                                                                                                                                        | No                                                |
| Safety guard | Screens text from the data for instructions aimed at the reviewer                                                                                                                                                                                                                                                                                                                | Yes (fast, local)                                 |
| Screener     | Reads the customer note, the payment reference and the list remarks on the local model and returns structured facts only: risk signals (a type from a closed list, where in the text, a confidence) and documentary evidence that code checks against the evidence standard. The cloud models see these facts and never the text. If it cannot answer, the case cannot be closed | Yes (local)                                       |
| Matching     | Field-by-field comparison with the approved definitions applied by code (true match, false positive, counterparty match)                                                                                                                                                                                                                                                         | No                                                |
| Ownership    | Reads the register level by level; the ownership engine works out effective ownership                                                                                                                                                                                                                                                                                            | No                                                |
| Memory       | Recalls earlier decisions as pointers (table, row key, content hash) and checks them against the entry now                                                                                                                                                                                                                                                                       | No                                                |
| Decision     | Recommends one of four outcomes with cited facts                                                                                                                                                                                                                                                                                                                                 | Yes (Nemotron; brief reasoning budget of our own) |
| Critic       | Re-reads every cited fact from the data, checks the recommendation against the definitions, asks a model for unsupported claims; may send it back, up to the policy's limit                                                                                                                                                                                                      | Yes                                               |
| Policy guard | Applies the hard rules. It can make a recommendation more cautious, never less                                                                                                                                                                                                                                                                                                   | No                                                |
| Reporter     | Seals a hash-protected decision record and returns the answer                                                                                                                                                                                                                                                                                                                    | No                                                |

The safety guard's model calls are logged under the agent name `policy_guard` (action `screen_inbound`): it is the inbound half of the policy guard, run on the data before any other model sees it; the rules half runs after the decision.

The outcomes are `CLOSE_FALSE_POSITIVE`, `ESCALATE_L2`, `RECOMMEND_BLOCK` (needs two human approvals) and `NEED_MORE_INFO`.

**Approved business definitions** are data in the semantic layer, versioned and cited by id and version in every decision: `true_match`, `false_positive`, `counterparty_match`, `strong_identifier`, `effective_ownership_threshold`. If the approved wording changes and the code has not been reviewed for it, the guard stops automatic closes.

## What it does on its own

**On every review, without being asked:**

- **Data-quality rules:** a customer record that fails a data-quality rule in Zetaris cannot support a close; the case goes to need-more-information.
- **Safety guard:** text in the data that tries to instruct the reviewer is flagged and treated as data; a flagged case is not closed.
- **Screener:** customer notes, payment references and list remarks are read on the local model; every risk signal at or above its threshold blocks a close, grounded in the text or not.
- **Critic re-check:** code re-reads every cited fact from Zetaris before the critic's model sees the recommendation; a fact that does not hold is never approved, and after three rounds the case goes to a person.
- **Challenger:** takes a second look at a proposed close when one of the policy's triggers applies (confidence below 0.85, a name similarity of 0.95 or more, a failing data-quality rule, or any screener signal), and argues against it.
- **Document-on-record check:** a document number cited in a note is counted against the customer's identifiers inside Zetaris; a note whose document is not on record does not count as evidence.
- **Memory:** earlier decisions are checked against the listed entry as it is now; a decision whose entry changed is marked stale and not relied on.
- **Policy guard:** the written hard rules are applied last; they can only make the outcome more cautious.
- **Masking and access:** each agent reads only its own tables and columns; identifier numbers are masked, and the model service never receives them.
- **Record:** every recommendation is sealed with a hash and the signed receipts of its model calls.

**Only when a person starts it:** the list-change re-check (the **Check earlier decisions against the list as it is now** button, or `POST /list-change/replay`) offers earlier decisions for review when their listed entry changed; nothing is reopened until a person does it. Approving, overriding and preparing the next action are a person's. Automatic closing (autonomy level 1) is off by default.

**Never:** block an account, write to a source system, or contact a customer.

## Can and cannot, step by step

| Step | Can | Cannot |
| --- | --- | --- |
| Triage | choose the review path and grade how clear the case is | read data or recommend an outcome |
| Evidence | read its own tables through Zetaris, one read-only statement at a time | write anything, read another agent's tables, or see an identifier number in clear |
| Safety guard | flag text that tries to instruct the reviewer | change the data or recommend an outcome |
| Screener | return risk signals with their exact span, and checked documentary facts | send the free text to the cloud (an answer from a cloud route is flagged in the record) or recommend an outcome |
| Matching and ownership | compare the parties under the approved definitions and work out effective ownership | decide the outcome (code's finding is a first finding only) |
| Memory | recall earlier decisions and mark them stale when the entry changed | close a case on its own |
| Decision | recommend one of four outcomes with cited facts | see the free text, act on the recommendation, or skip the critic |
| Critic | check every cited fact, approve, or send the recommendation back (up to three rounds) | change the recommendation itself, or approve a fact that does not hold |
| Challenger | argue against a close that meets the policy's triggers, and turn it into an escalation | propose a close |
| Policy guard | block a close and make any outcome more cautious | approve a close or make an outcome less cautious |
| Reporter | seal the record with a hash and the receipts | change a record after it is sealed |
| A person | approve or override with a reason; a block needs a second, different approver | (the desk never acts without one) |

## How sponsor technology is used

<!-- sponsors:start -->
**Zetaris: the only data path.** Three sources stay where they are and meet in one Unified Semantic Layer of 14 tables: list files in the Zetaris file store, a Postgres bank database over JDBC with a read-only login, and a payments service read as a REST table. Each agent reads only its own tables and columns, one read-only statement at a time, under a read-only Zetaris role; identifier numbers are masked. A customer record that fails a data-quality rule cannot support a close. Before a note counts as evidence, the document number it cites is counted against the customer's identifiers inside Zetaris, so the number never reaches a model. *Check it:* `zetaris/sql/` (sources and semantic layer), `npm run check:roles` and `npm run check:isolation` (live), `packages/zetaris/test/guard.test.ts` (access and masking), `packages/agents/test/policy-guard.test.ts` (data quality), `packages/agents/src/note-document.ts` (document on record), [docs/ZETARIS.md](docs/ZETARIS.md).

**Meterless engines: three, each in a working feature.** H-MEM keeps earlier decisions as pointers (table, key, content hash) that go stale when the listed entry changes; the memory step recalls them for each review. The World Model holds each company's ownership with provenance; the 50 percent rule runs on it for ownership alerts. Markovian re-screens every earlier decision after a list change in bounded batches with a carried cursor; the list-change check uses it. *Check it:* `npm run test:engines` (H-MEM 13/13, World Model 8/8, Markovian 8/8 on the official conformance suites), `packages/engines/src/`, `output_examples/close-previously-cleared/` (memory), `POST /list-change/replay` and `apps/api/test/review.test.ts` (list change).

**Meterless Nightshift: every model call.** The desk talks to Nightshift's OpenAI-compatible API through one injected generator, under two app identities: `sanctions-desk-guard`, bound to the local lane, and `sanctions-desk-reasoning`, bound to the deep lane (binds set in the Nightshift cockpit). Ollama is a backup only. Every call returns an Ed25519-signed receipt naming the model that served it; the trace keeps the requested model, the routed model and the receipt id side by side. *Check it:* `config/default.json` (`nightshift`), `packages/shared/src/generator.ts`, `npm run evidence:verify` (1,492 receipts across 28 exported runs, all valid), the **Verify receipt** button in the case view.

**NVIDIA Nemotron: local where the text is, cloud where the reasoning is.** Nemotron 3.5 Lightning 30B runs on the analyst's laptop for the safety guard and the free-text screener, so raw notes and payment references never leave the machine. Nemotron 3 Ultra 550B in the cloud handles the decision, the critic and the challenger, and receives structured facts only. Nightshift's router chooses within each lane and every receipt records the model: in the headline run the safety guard was answered by Lightning in 70 of 70 calls and the decision by Ultra in 87 of 89. *Check it:* `npm run evidence:verify -- eval/runs/routed-20261023T133311Z`, [docs/MODELS.md](docs/MODELS.md).

**Cursor: not used.** Built with Claude Code ([AI and Model Usage](#ai-and-model-usage)).

**What was unique**
1. The critic does not trust the decision: code re-reads every cited fact from Zetaris before the critic's model sees it, and a fact that does not hold is never approved.
2. Raw text stays on the laptop: the local model turns it into risk signals with exact spans, and a signal at or above its threshold blocks a close whether or not its span is grounded.
3. Every held-out round is published as run, wrong closes included, and every model call has a signed receipt that one command re-checks.
<!-- sponsors:end -->

The details follow.

### Meterless build: the engines

Three engines from the Meterless specifications are implemented in TypeScript (Apache-2.0, a "derived from the Meterless reference" header on every file) and each does real work in the product:

| Engine                          | What it does in the product                                                                                                                                                                                                                                                                                          | Where in the code                                                               | Used by                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **H-MEM** (hierarchical memory) | Remembers each earlier decision as its outcome, reason codes and a pointer to the row it rested on (table, key, content hash, list snapshot), never as personal data. On recall the pointer is re-checked: a changed hash makes the memory stale. A person's override beats memory and is written to a trust ledger. | `packages/engines/src/hmem/`, `packages/engines/src/domain/pointer-memory.ts`   | the memory step (`packages/agents/src/memory.ts`)                                     |
| **World Model**                 | Holds each company's ownership picture with provenance and validity dates. The 50 percent rule runs on it: chains multiply, listed owners add up, exactly the threshold counts, a missing percentage is unknown, loops end and a depth limit escalates.                                                              | `packages/engines/src/world-model/`, `packages/engines/src/domain/ownership.ts` | the ownership step (`packages/agents/src/ownership.ts`)                               |
| **Markovian**                   | Re-screens earlier decisions after a list update, in bounded batches with a carried cursor: entries that changed are re-opened, removed ones are offered to a person for release.                                                                                                                                    | `packages/engines/src/markovian/`, `packages/engines/src/domain/rescreen.ts`    | list-change replay (`packages/agents/src/list-change.ts`, `POST /list-change/replay`) |

```bash
npm run test:engines     # the official conformance runners against our code
```

Result of the last run: **H-MEM 13/13, World Model 8/8, Markovian 8/8** checks passed. The official conformance suites are vendored in `packages/engines/conformance/` (copied without change, Apache-2.0, see `NOTICE`), so no other checkout is needed. They run against our engines in `npm test` and in CI, which prints these scorecards on every push. Set `METERLESS_ENGINES_DIR` to run against a newer upstream copy. The engines also have their own unit tests in `packages/engines/test/`.

### Meterless power: Nightshift runs every model call

Nightshift, an OpenAI-compatible runtime, is the AI provider for all model calls. Nothing in the code names a model provider: one injected `generator` function asks Nightshift for a **pinned mode** (`meterless/fast`, `meterless/deep`, `meterless/judge`; `meterless/auto` is rejected), falls back to the Ollama backup only if Nightshift cannot answer, and a labelled rules stand-in exists for sample mode only.

| Step         | Mode we ask for | Reasoning budget (ours) | What it does                                                                                                       |
| ------------ | --------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Safety guard | `fast`          | none                    | Reads text that came out of the data for instructions aimed at the reviewer; checks drafts for tipping off         |
| Decision     | `deep`          | 500 tokens              | Recommends one of four outcomes with cited facts                                                                   |
| Critic       | `judge`         | 400 tokens              | Checks the recommendation against the evidence the code re-read                                                    |
| Challenger   | `deep`          | 500 tokens              | Argues against a close that could slip through (low confidence, a very close name, or a failing data-quality rule) |

The **reasoning budget** is our own token limit plus an instruction to put brief reasoning in the answer's `analysis` field; it is not a model parameter and nothing is sent to Nightshift to switch thinking on. Triage, evidence, matching, ownership, memory, the policy guard and the reporter are code and call no model.

**Which model serves a mode is Nightshift's decision, not ours.** Under the cockpit binds of the final runs (guard identity bound to local, reasoning identity bound to deep), the receipts of the headline run record the mode served as `deep` (190 calls) or `local` (70 calls), and within that mode Nightshift's learned router chose the model (routing policy `learned-router` in every receipt). We do not route by difficulty and we do not pin the cloud. What we do is record, for every call, the mode asked for, the model that answered (`routed_model`), reasoning budget, latency, tokens, the signed receipt and the cost under the configured unit costs (tokens served by the local model are priced at zero). The decision, critic and challenger ask for schema-constrained JSON with the reasoning in a field of the answer; the screener and local retries ask for plain JSON, checked by the same schema. See [docs/MODELS.md](docs/MODELS.md).

### Zetaris

Zetaris is the only data path. Three kinds of source meet in one Unified Semantic Layer (`lightning.metastore.sanctions.screening_usl`, 14 tables):
- **list files** in the Zetaris file store (OFAC and UN sample, business definitions),
- a **Postgres bank database** over JDBC with a read-only login (customers, ownership, alerts, earlier decisions),
- a **payments service** read as a REST table. The first system's runs read it live (the Zetaris cache of that table had been lost); the changed system's runs read it from the Zetaris cache, verified by stopping the service.

The agents read the model's own description at run time and build their read-only tools from it; each agent is limited by our SQL guard to its own tables and columns; failing data-quality records can never support a close; every query id is matched to Zetaris's own statement history. Zetaris checklist, item by item (sources and queries 1a to 1c, comparison with hand-coding 2a, benefit 2b, requirement and mock 2c): [docs/ZETARIS.md](docs/ZETARIS.md#zetaris-checklist). Runnable proofs: `npm run zetaris:queries`, `npm run zetaris:usl`, `npm run compare:hand-coded`, `npm run usl:policy -- --demo`. Access control and the problems met: [Access control](docs/ZETARIS.md#access-control) and [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md). Query plans: [docs/QUERY_PLANS.md](docs/QUERY_PLANS.md).

Before a customer note counts as documentary evidence, the system checks in Zetaris that the document number it cites is on the customer's record: a count query under the evidence agent's read-only identity, the same way as the identifier match. No model sees the number; only a yes or no comes back, and a number that is not on file sends the case to "need more information" with that reason shown.

### NVIDIA Nemotron

The language work is done by Nemotron models through Nightshift: **Nemotron 3 Ultra 550B** (served in the cloud) and **Nemotron 3.5 Lightning 30B** (served on a local laptop). Which of them answers a call is decided by Nightshift's router, so the split below is a measurement, not a setting:

App binds used in the final runs: `sanctions-desk-guard` bound to local and `sanctions-desk-reasoning` bound to deep in the Nightshift cockpit, unchanged for all of them (the report lists them per run).

<!-- routing:start -->
Measured in the full exam run of 2026-10-23, from the signed receipts (the model that served each call; Nightshift's learned router decides this, we only ask for a pinned mode):

| Step | Calls | Nemotron 3.5 Lightning 30B (local) | Nemotron 3 Ultra 550B (cloud) |
|---|---:|---:|---:|
| Safety guard | 70 | 100.0% (70) | 0 |
| Decision | 89 | 2.3% (2) | 97.8% (87) |
| Critic | 86 | 1.2% (1) | 98.8% (85) |
| Challenger | 15 | 0 | 100.0% (15) |
<!-- routing:end -->

Which agent runs on which Nemotron model, and what it does:

| Agent (step)             | Nemotron model               | Where it runs                                 | What it does                                                                                                                                                                |
| ------------------------ | ---------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Safety guard             | Nemotron 3.5 Lightning 30B   | local laptop (guard identity, bound to local) | Flags text in the data that tries to instruct the reviewer; blocks a customer draft that would tip them off                                                                 |
| Free-text screener       | Nemotron 3.5 Lightning 30B   | local laptop (guard identity)                 | Reads customer notes, payment references and list remarks and returns structured risk signals and validated documentary evidence only; the raw text never leaves the laptop |
| Decision                 | mostly Nemotron 3 Ultra 550B | cloud (reasoning identity, bound to deep)     | Recommends one of four outcomes from the structured evidence and the approved definitions, with cited facts                                                                 |
| Critic                   | mostly Nemotron 3 Ultra 550B | cloud                                         | Checks the recommendation against the evidence after code has re-read every cited fact; can send it back                                                                    |
| Challenger               | mostly Nemotron 3 Ultra 550B | cloud                                         | Argues against a close that could slip through                                                                                                                              |
| Retry after a failed try | Nemotron 3.5 Lightning 30B   | local (guard identity)                        | Answers in place of a step whose cloud call failed; such cases are counted in the report                                                                                    |

**We log the requested model, the routed model and the signed receipt for every model call**, side by side in the trace, the stdout lines and the case view's routing panel; when the model that served a call is not the one asked for, both are shown. Check any run yourself with the receipt verifier, `npm run evidence:verify` ([tools/evidence-verify.ts](tools/evidence-verify.ts); see [Check which model served each call](#check-which-model-served-each-call)).

**Pinned-model check: not run.** It needs Nightshift 1.2.3 or later to pin an exact model id per call; the runtime installed here is 1.2.1, so every model id above is the one Nightshift's router chose, as the receipts record. See [docs/MODELS.md](docs/MODELS.md).

**The signed receipt log of the final runs** (one Ed25519-signed Nightshift receipt per model call; the model that served each call is in `winning_route.model`):

<!-- receipts:start -->
| Run | Receipts | Receipt log | Check it |
| --- | ---: | --- | --- |
| `rules-20261023T085618Z` | 0 | [eval/runs/rules-20261023T085618Z/receipts.jsonl.gz](eval/runs/rules-20261023T085618Z/receipts.jsonl.gz) | `npm run evidence:verify -- eval/runs/rules-20261023T085618Z` |
| `fuzzy-20261023T085617Z` | 0 | [eval/runs/fuzzy-20261023T085617Z/receipts.jsonl.gz](eval/runs/fuzzy-20261023T085617Z/receipts.jsonl.gz) | `npm run evidence:verify -- eval/runs/fuzzy-20261023T085617Z` |
| `escalate_all-20261023T085617Z` | 0 | [eval/runs/escalate_all-20261023T085617Z/receipts.jsonl.gz](eval/runs/escalate_all-20261023T085617Z/receipts.jsonl.gz) | `npm run evidence:verify -- eval/runs/escalate_all-20261023T085617Z` |
| `routed-20261023T133311Z` | 260 | [eval/runs/routed-20261023T133311Z/receipts.jsonl.gz](eval/runs/routed-20261023T133311Z/receipts.jsonl.gz) | `npm run evidence:verify -- eval/runs/routed-20261023T133311Z` |
| `single-20261023T161731Z` | 132 | [eval/runs/single-20261023T161731Z/receipts.jsonl.gz](eval/runs/single-20261023T161731Z/receipts.jsonl.gz) | `npm run evidence:verify -- eval/runs/single-20261023T161731Z` |
| `no_memory-20261023T173107Z` | 42 | [eval/runs/no_memory-20261023T173107Z/receipts.jsonl.gz](eval/runs/no_memory-20261023T173107Z/receipts.jsonl.gz) | `npm run evidence:verify -- eval/runs/no_memory-20261023T173107Z` |
| `heldout-rules-20261023T081308Z` | 0 | [eval/runs/heldout-rules-20261023T081308Z/receipts.jsonl.gz](eval/runs/heldout-rules-20261023T081308Z/receipts.jsonl.gz) | `npm run evidence:verify -- eval/runs/heldout-rules-20261023T081308Z` |
| `heldout-fuzzy-20261023T082432Z` | 0 | [eval/runs/heldout-fuzzy-20261023T082432Z/receipts.jsonl.gz](eval/runs/heldout-fuzzy-20261023T082432Z/receipts.jsonl.gz) | `npm run evidence:verify -- eval/runs/heldout-fuzzy-20261023T082432Z` |
| `heldout-escalate_all-20261023T083248Z` | 0 | [eval/runs/heldout-escalate_all-20261023T083248Z/receipts.jsonl.gz](eval/runs/heldout-escalate_all-20261023T083248Z/receipts.jsonl.gz) | `npm run evidence:verify -- eval/runs/heldout-escalate_all-20261023T083248Z` |
| `heldout-routed-20261023T121140Z` | 142 | [eval/runs/heldout-routed-20261023T121140Z/receipts.jsonl.gz](eval/runs/heldout-routed-20261023T121140Z/receipts.jsonl.gz) | `npm run evidence:verify -- eval/runs/heldout-routed-20261023T121140Z` |
| `heldout2-sys2-routed-20261023T180732Z` | 81 | [eval/runs/heldout2-sys2-routed-20261023T180732Z/receipts.jsonl.gz](eval/runs/heldout2-sys2-routed-20261023T180732Z/receipts.jsonl.gz) | `npm run evidence:verify -- eval/runs/heldout2-sys2-routed-20261023T180732Z` |
| `heldout2-escalate_all-20261023T193323Z` | 0 | [eval/runs/heldout2-escalate_all-20261023T193323Z/receipts.jsonl.gz](eval/runs/heldout2-escalate_all-20261023T193323Z/receipts.jsonl.gz) | `npm run evidence:verify -- eval/runs/heldout2-escalate_all-20261023T193323Z` |
| `heldout2-fuzzy-20261023T193323Z` | 0 | [eval/runs/heldout2-fuzzy-20261023T193323Z/receipts.jsonl.gz](eval/runs/heldout2-fuzzy-20261023T193323Z/receipts.jsonl.gz) | `npm run evidence:verify -- eval/runs/heldout2-fuzzy-20261023T193323Z` |
| `heldout2-rules-20261023T193324Z` | 0 | [eval/runs/heldout2-rules-20261023T193324Z/receipts.jsonl.gz](eval/runs/heldout2-rules-20261023T193324Z/receipts.jsonl.gz) | `npm run evidence:verify -- eval/runs/heldout2-rules-20261023T193324Z` |
| `heldout2-sys2b-routed-20261023T193436Z` | 98 | [eval/runs/heldout2-sys2b-routed-20261023T193436Z/receipts.jsonl.gz](eval/runs/heldout2-sys2b-routed-20261023T193436Z/receipts.jsonl.gz) | `npm run evidence:verify -- eval/runs/heldout2-sys2b-routed-20261023T193436Z` |
| `sys2b-routed-20261023T195504Z` | 305 | [eval/runs/sys2b-routed-20261023T195504Z/receipts.jsonl.gz](eval/runs/sys2b-routed-20261023T195504Z/receipts.jsonl.gz) | `npm run evidence:verify -- eval/runs/sys2b-routed-20261023T195504Z` |
| `heldout-sys2b-routed-20261023T214515Z` | 135 | [eval/runs/heldout-sys2b-routed-20261023T214515Z/receipts.jsonl.gz](eval/runs/heldout-sys2b-routed-20261023T214515Z/receipts.jsonl.gz) | `npm run evidence:verify -- eval/runs/heldout-sys2b-routed-20261023T214515Z` |
| `heldout2-sys2bnoscreen-routed-20261023T222222Z` | 102 | [eval/runs/heldout2-sys2bnoscreen-routed-20261023T222222Z/receipts.jsonl.gz](eval/runs/heldout2-sys2bnoscreen-routed-20261023T222222Z/receipts.jsonl.gz) | `npm run evidence:verify -- eval/runs/heldout2-sys2bnoscreen-routed-20261023T222222Z` |
| `heldout3-sys3-routed-20261023T231901Z` | 67 | [eval/runs/heldout3-sys3-routed-20261023T231901Z/receipts.jsonl.gz](eval/runs/heldout3-sys3-routed-20261023T231901Z/receipts.jsonl.gz) | `npm run evidence:verify -- eval/runs/heldout3-sys3-routed-20261023T231901Z` |
| `heldout3-escalate_all-20261023T233941Z` | 0 | [eval/runs/heldout3-escalate_all-20261023T233941Z/receipts.jsonl.gz](eval/runs/heldout3-escalate_all-20261023T233941Z/receipts.jsonl.gz) | `npm run evidence:verify -- eval/runs/heldout3-escalate_all-20261023T233941Z` |
| `heldout3-rules-20261023T234147Z` | 0 | [eval/runs/heldout3-rules-20261023T234147Z/receipts.jsonl.gz](eval/runs/heldout3-rules-20261023T234147Z/receipts.jsonl.gz) | `npm run evidence:verify -- eval/runs/heldout3-rules-20261023T234147Z` |
| `heldout3-sys3-single-20261023T234224Z` | 36 | [eval/runs/heldout3-sys3-single-20261023T234224Z/receipts.jsonl.gz](eval/runs/heldout3-sys3-single-20261023T234224Z/receipts.jsonl.gz) | `npm run evidence:verify -- eval/runs/heldout3-sys3-single-20261023T234224Z` |
| `heldout4-sys4-routed-20261024T024523Z` | 56 | [eval/runs/heldout4-sys4-routed-20261024T024523Z/receipts.jsonl.gz](eval/runs/heldout4-sys4-routed-20261024T024523Z/receipts.jsonl.gz) | `npm run evidence:verify -- eval/runs/heldout4-sys4-routed-20261024T024523Z` |
| `heldout4-sys4-single-20261024T025629Z` | 36 | [eval/runs/heldout4-sys4-single-20261024T025629Z/receipts.jsonl.gz](eval/runs/heldout4-sys4-single-20261024T025629Z/receipts.jsonl.gz) | `npm run evidence:verify -- eval/runs/heldout4-sys4-single-20261024T025629Z` |
| `heldout4-rules-20261024T030240Z` | 0 | [eval/runs/heldout4-rules-20261024T030240Z/receipts.jsonl.gz](eval/runs/heldout4-rules-20261024T030240Z/receipts.jsonl.gz) | `npm run evidence:verify -- eval/runs/heldout4-rules-20261024T030240Z` |
| `heldout4-escalate_all-20261024T030324Z` | 0 | [eval/runs/heldout4-escalate_all-20261024T030324Z/receipts.jsonl.gz](eval/runs/heldout4-escalate_all-20261024T030324Z/receipts.jsonl.gz) | `npm run evidence:verify -- eval/runs/heldout4-escalate_all-20261024T030324Z` |
| `heldout3-fuzzy-20261024T033840Z` | 0 | [eval/runs/heldout3-fuzzy-20261024T033840Z/receipts.jsonl.gz](eval/runs/heldout3-fuzzy-20261024T033840Z/receipts.jsonl.gz) | `npm run evidence:verify -- eval/runs/heldout3-fuzzy-20261024T033840Z` |
| `heldout4-fuzzy-20261024T033840Z` | 0 | [eval/runs/heldout4-fuzzy-20261024T033840Z/receipts.jsonl.gz](eval/runs/heldout4-fuzzy-20261024T033840Z/receipts.jsonl.gz) | `npm run evidence:verify -- eval/runs/heldout4-fuzzy-20261024T033840Z` |

`npm run evidence:verify` with no argument checks every run: each signature, that every model call has a receipt, and that the model in the trace equals the model in the receipt.
<!-- receipts:end -->

The **model ledger** of every recommendation lists, per step, the mode asked for, the model that answered, reasoning budget, tokens, latency and the signed receipt with its verification status (`GET /cases/:alertId/trace`, `npm run ledger -- --case <alert id>`, the routing panel of the review desk, and the saved decision records in `output_examples/`).

### What is distinctive

- Every recommendation can answer four questions from its sealed record: which approved definition was applied, what data it rested on, who was allowed to see what, and what it cost to produce.
- The critic does not trust the decision: it re-reads each cited fact from the data, and a claim that does not match is never approved, whatever any model says.
- Memory holds pointers, not copies, and goes stale the moment the listed entry changes.
- The policy guard can only add caution; a block needs a strong match and an approving critic, and always needs two people.

### What changes when it is off

Only results from runs and tests that were actually made; anything else says NOT MEASURED. Each run is one run unless stated, and model answers vary between runs.

| Component                                               | Where in the code                                            | Run or test that switches it off                                                                                                          | Measured effect                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Zetaris (the only data path)                            | `packages/zetaris`, `packages/agents/src/evidence.ts`        | Zetaris unreachable (closed port `127.0.0.1:59999`), live mode, 4 cases (a clear, a true match, a payment match, a missing date of birth) | All 4 stopped with a connection error before any recommendation: no close, no model call, recorded as errors in the result file (`eval/results/2026-10-23T23-49-30-051Z-zdown-routed.json`). The review cannot run without its data layer                                                                                      |
| H-MEM (memory of earlier decisions)                     | `packages/engines/src/hmem`, `packages/agents/src/memory.ts` | `--variant no_memory`, first system, the 11 previously-cleared cases                                                                      | 10 of 11 acceptable without memory against 11 of 11 with it; exact 8 against 8; no false close either way                                                                                                                                                                                                                      |
| Local screener (Nemotron 3.5 Lightning via Nightshift)  | `packages/agents/src/screener.ts`                            | `--screener off`, changed system, the 19 frozen held-out v2 cases                                                                         | Screener off: **2 of 14 risk cases wrongly closed** (HO2-016, HO2-017: risk stated only in free text) and 3 of 5 clears made. Screener on: 0 wrong closes and 0 of 5 clears (it over-flagged; see below)                                                                                                                       |
| Cloud decision (mostly Nemotron 3 Ultra via Nightshift) | `packages/agents/src/decision.ts`                            | the deterministic pipeline (`--variant rules`, no language model) as the comparison                                                       | 70 cases: exact by design. Held-out v1: 16 of 22 risks caught, 0 of 8 clears. Held-out v2: 11 of 14 caught (3 wrong closes), 5 of 5 clears. Held-out v3: 5 of 6 caught (1 wrong close, HO3-005), 1 of 6 clears. Held-out v4: 3 of 6 caught (3 wrong closes, HO4-002, HO4-003, HO4-005), 2 of 6 clears. A "Nemotron alone" run: NOT MEASURED                                                                                                                                               |
| Critic, challenger and memory together                  | `critic.ts`, `challenger.ts`, `memory.ts`                    | `--variant single`, first system, 70 cases                                                                                                | **No measured gain on the 70 cases:** 66 of 70 acceptable either way, 0 false closes either way; `single` had more exact answers (57 against 49), because the full run had 9 provider failures (each escalated, 6 of them among the cases where single was exact and the full run was not) and its checks escalated 5 cases more cautiously than the label (and recommended a block on 1 labelled escalate)                                                                 |
| The same checks, inside the full runs                   | `critic.ts`, `policy-guard.ts`                               | counted from the traces: the decision's first recommendation against the final outcome                                                    | First-recommendation wrong closes stopped: 70 cases, first system **5 of 5**; 70 cases, changed system **3 of 3**. Held-out v1, first system: **2 slipped through** (HO-005, HO-006: the evidence was never shown to the decision), the honest counter-example. Held-out v2: none proposed. Held-out v3: none proposed first, but on HO3-001 and HO3-003 the critic rejected the decision's escalation because it cited the screener's signals (not a citable source), and the decision's second answer was a close that the critic approved: **the critic's citation rule caused both v3 wrong closes**. Held-out v4: none proposed                                     |
| Critic's fact re-check                                  | `critic.ts`                                                  | `npm run critic:mutation` (deterministic fact re-check, sample mode)                                                                      | 147 of 147 cited facts changed to false values caught; 25 of 25 unchanged decisions approved                                                                                                                                                                                                                                   |
| Challenger alone                                        | `challenger.ts`                                              | NOT MEASURED separately                                                                                                                   | In the full 70-case run of the first system it turned 1 of 17 closes into an escalation, because it could not answer; it found no credible argument against the other 16                                                                                                                                                                                                                                                              |
| Policy guard                                            | `packages/agents/src/policy-guard.ts`                        | NOT MEASURED by a run (unit tests only)                                                                                                   | Every outcome after a critic deadlock is the guard's (it raises, never lowers)                                                                                                                                                                                                                                                 |
| Held-out v3, critic and challenger off                  |                                                              | `--variant single` on held-out v3 (new set, frozen before the fix), fixed system                                                          | Critic and challenger off: 6 of 6 risks caught, 0 wrong closes, 0 of 6 clears. Full system on the same set: 4 of 6 caught, **2 wrong closes** (HO3-001, HO3-003), 0 of 6 clears. One run each. The difference **is the critic**: on HO3-001 and HO3-003 the decision first escalated, citing the screener's signals; the critic rejected those citations as not citable, and the decision's second answer, a close, was approved and stood because the signals were marked not grounded (policy 7). Single mode, with no critic, escalated both |
| Held-out v4, critic and challenger off | | `--variant single` on held-out v4 (the last round, frozen before the fail-closed change), fail-closed system | Critic and challenger off: 6 of 6 risks caught, 0 wrong closes, 0 of 6 clears. Full system on the same set: the same (6 of 6, 0 wrong closes, 0 of 6 clears; one critic deadlock, HO4-012). Deterministic pipeline: **3 of 6 risk cases wrongly closed** (HO4-002, HO4-003, HO4-005), 2 of 6 clears. One run each |
| Grounding as a way to remove a block | `packages/agents/src/policy-guard.ts` | policy version 7 (ungrounded signals did not block) against version 8 (they block), on different held-out sets | Version 7 on held-out v3: **2 of 6 risk cases wrongly closed** (HO3-001, HO3-003). Version 8 on held-out v4: 0 of 6 wrongly closed, and 0 of 6 clears (every clear carried an ungrounded signal that now blocks). Not the same cases, so not a like-for-like comparison |

## The decision trace

`GET /cases/:alertId/trace` (or `/runs/:runId/trace`) answers four questions from the sealed record, and says if the record no longer verifies:

| Question                               | Answer in the trace                                                                                                                                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which approved definition was applied? | `definitions`: id, version and a hash of the wording                                                                                                                                          |
| What data is it based on?              | `data`: model version, list snapshots, every query (id, statement hash, rows, latency, cache hit), row hashes                                                                                 |
| Who was allowed to see what?           | `access`: the role of each query, whether it ran under its own token or the labelled fallback, the masked columns, the policy version and hash                                                |
| What did it cost to produce?           | `cost`: per call the mode asked for, the model that answered, reasoning budget, tokens, latency, receipt status; Zetaris query time and rows; totals and cost under the configured unit costs |

## Review desk interface

A small Next.js application (`apps/web`) on http://localhost:3001. It works in sample mode and live, and reads everything from the API.

| Screen                          | What it shows                                                                                                                                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alert queue                     | Every alert read through the semantic layer, with the latest recommendation and record hash; filter by type and by reviewed or not                                                                                                  |
| Case: live run                  | The review steps lighting up from the real run events (a server-sent stream, not a timer), the critic's round count against the three allowed, retries on each step, and which model answered each model step and where it ran |
| Case: evidence                  | The customer, the listed party, the payment route and the data-quality results. Identifier numbers are drawn as `••••`; the API names the masked columns                                                                            |
| Case: model routing and cost    | Per step: the mode asked for and the model that answered (cloud or local), reasoning budget, time, tokens, signed-receipt status and cost under the configured unit costs, with the measured split of the latest full exam          |
| Case: decision trace and replay | The four questions answered from the sealed record, and a slider that replays the run as of any recorded event                                                                                                                      |
| Case: decision and next action  | Approve or override with a reason; the second approval of a block; the prepared next action with its seal; the case file as PDF or Markdown; reopen an automatic close. Which buttons appear depends on the signed-in role          |
| Policy studio                   | The active policy, drafts, a replay of a draft on the exam, publishing by a different person, the autonomy card and its kill switch, and the audit log                                                                              |
| Exam results                    | Every held-out round as run with its baselines (the same table as this README), then the 70-case variants with false closes and results by case group                                                                                                                                          |

The interface recommends and records. A person with the right role can **approve or override** a recommendation with a reason, and the next action (a closure note, an escalation ticket, a request for information or a hold instruction) is prepared only after that decision; a block needs a second, different approver. Nothing in it blocks an account, writes to a source system or contacts a customer. Roles, demo users and the decision step are described under [People, roles and the decision step](#people-roles-and-the-decision-step). It respects the visitor's reduced-motion setting (the working step is marked with a double border instead of a pulse) and follows the light or dark theme of the system.

```bash
npm install
SAMPLE_MODE=true npm run dev                  # the API on :8000
npm run dev -w @sanctions-desk/web            # the interface on :3001
npm run build -w @sanctions-desk/web          # production build
```

The browser calls the API directly, so the API lists the interface's origin (`WEB_ORIGINS`); set `NEXT_PUBLIC_API_URL` when the API is not on `localhost:8000`.

### People, roles and the decision step

A person decides every alert unless the policy has switched on automatic closing for the certain cases. The roles are `analyst`, `approver` (a sanctions officer), `policy_admin` and `viewer`:

| Rule                                                                                                                                                                                                                                                          | Where it is enforced                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Every route except `/health` needs a person's bearer token once sign-in is on (the default live); tokens are stored only as SHA-256 hashes in a users file outside the repository (`npm run users:add`)                                                       | `apps/api/src/app.ts`, `packages/shared/src/auth.ts`         |
| A viewer is read-only; only an analyst or approver decides; only an approver gives the second approval of a block or overrides towards a less cautious outcome; only a policy admin publishes                                                                 | `PERMISSIONS` in `packages/shared/src/auth.ts`               |
| A decision needs a reason and names the sealed record it is about; an override names a different outcome                                                                                                                                                      | `packages/agents/src/human-decision.ts`                      |
| A recommended block needs a second, different approver and is only ever a recommendation for the sanctions officer                                                                                                                                            | the same file; the `block approval pending` ticket           |
| A policy change is a draft, previewed on the exam, then published by a different policy admin than the author; the author and approver come from the token, not from the request body                                                                         | `apps/api/src/routes/policy.ts`                              |
| The next action (closure note, escalation ticket, request-for-information draft, hold instruction) is prepared only after a decision, signed with an Ed25519 key kept outside the repository if one is set and otherwise labelled hash-sealed, and never sent | `packages/agents/src/actions.ts`                             |
| Every action, accepted or refused, is logged under the person's id; tokens never appear in logs                                                                                                                                                               | `logs/decisions/audit.jsonl`, `apps/api/test/people.test.ts` |

In sample mode, with no setup, three **demo users** (`analyst_demo`, `approver_demo`, `admin_demo`) can be chosen from a labelled switcher in the desk so a visitor can try the four-eyes rules; they never work against a live deployment. The user guide ([docs/USER_GUIDE.md](docs/USER_GUIDE.md)) walks through the decision flow, autonomy and the case file.

**Autonomy** (`autonomy` in the policy): level 0, the default, has a person approve every alert. Level 1 closes a close automatically only when code, the decision agent, the critic and the challenger agree, the evidence standard is met, no data-quality rule fails and confidence is at least the policy's line; at least 5% of those go to a person at random, there is a daily cap, and a kill switch forces level 0 at once. Escalations, requests for information and blocks always go to a person; that is fixed in the policy schema. The headline exam runs at level 0; level 1 is previewed on the exam in Policy Studio.

## Evaluation

**Which code the numbers came from.** First system: review code at commit `8fe6205` (all four first-system runs). Changed system: held-out v2 blind at `8f6976c`; the re-run of v2 after the infrastructure fix, the 70-case re-run, held-out v1 after the fix and the screener-off ablation at `d44ee04`. The SQL guard fix came after all of those, in merge `d49b726`; held-out v3 and its single-mode run used the code after it (`e56b204`, with the grounding and document-number fixes). Held-out v4 and its single-mode run used the fail-closed change (`80902ea`, policy version 8), committed after v4 was frozen in `fc64537`. Each result file records the commit it was saved at.

The exam has <!--fact:exam_cases-->70<!--/fact--> cases built from real public list entries and synthetic customers, payments and owners, in <!--fact:exam_groups-->12<!--/fact--> groups (false positives, true matches, transliteration, missing data, hidden ownership at and above 50 percent, ownership below 50 percent, earlier clearances that still hold, earlier clearances that no longer hold, injection, tipping-off drafts, payment routes through watched jurisdictions, and a rules gap). Each case has one right answer, acceptable alternatives, and answers that must never be given. The most important number is the **false-close rate**: how often a case that carries real risk is recommended for closing. The target is zero.

Every variant is one command, and each is a separate saved result:

```bash
npm run exam -- --variant routed          # the full system, live
npm run exam -- --variant single          # one recommendation: no critic, no challenger, no memory
npm run exam -- --variant no_memory       # the full system with memory off (the previously cleared cases only)
npm run exam -- --variant local           # reasoning off everywhere, the local model only
npm run exam -- --variant lightning       # decision, critic and challenger sent to the local model
npm run exam -- --variant rules           # our deterministic pipeline, no language model
npm run exam -- --variant fuzzy           # baseline: a name-score threshold
npm run exam -- --variant escalate_all    # baseline: every alert goes to a person
npm run exam -- --variant routed --exam heldout   # the same, on the held-out set the rules were not written for
npm run bench -- --variant routed --runs 3        # repeat runs or random batches unattended
npm run exam:report                       # builds eval/REPORT.md from the saved results
```

Results from real runs are in `eval/results/` and summarised in [eval/REPORT.md](eval/REPORT.md). The exported evidence of the final runs (events, signed receipts and results, with local paths and addresses removed) is committed in `eval/runs/` and can be checked from a fresh clone, as shown below. Nothing in them is edited by hand.

### Check which model served each call

The final runs are exported to `eval/runs/<run-id>/`: `results.json`, `run-meta.json`, `trace.jsonl.gz` (the decision events, with local paths, addresses, e-mail addresses and tokens removed) and `receipts.jsonl.gz` (the runtime's signed receipts, untouched). Anyone can check them from a fresh clone:

```bash
npm ci
npm run evidence:verify                      # every signature, every call has a receipt, trace model = receipt model
npm run evidence:verify -- eval/runs/<run-id>   # one run: the share of calls each model served, per step
```

The third command, `gunzip -c eval/runs/<run-id>/receipts.jsonl.gz | head -1`, shows one signed receipt: `winning_route.model` is the model that served the call and `routing` records whether the runtime coerced the requested mode. `npm run evidence:export` rebuilds the folder from `logs/` and `eval/results/` and refuses to write anything that still matches a redaction pattern.

### Benchmark command

One command runs the exam unattended, once or many times, or on random batches of alert cases, and writes a results file and a summary:

```bash
npm run bench -- --variant routed                        # the full exam once
npm run bench -- --variant routed --runs 3               # the full exam three times
npm run bench -- --variant routed --batch 20 --runs 5   # five random batches of 20 alert cases
npm run bench -- --variant routed,single --runs 2        # several variants, one after another
```

`--seed N` repeats the random batches exactly, `--name` labels the output, and `--dry-run` prints what would run. Each run is a separate `npm run exam`, so one failing run does not stop the rest. The summary (`eval/results/bench-*.md` and `.json`) gives the mean and range of accuracy, false-close rate and median time over the runs, the model calls by the model that served them, and the model cost: cloud tokens are priced under the unit costs in `config/default.json`, and tokens served by the local model are counted and cost nothing. `npm run json:rate` reports how often a model answer could not be used as JSON, from the traces of the runs.

### How long a run takes

**Sample mode, no model calls** (saved Zetaris answers and the rules stand-in; the desk's own code only), Apple M5 Max, Node 26, 50 alerts, three repeats each, 0 errors: one at a time, a median of 4 to 5 ms and a p95 of 7 to 10 ms per alert; five at a time, a median of 20 to 23 ms and a p95 of about 36 ms, about 12,500 to 13,500 alerts a minute. The API's limits were raised for this test (`RATE_LIMIT_REVIEWS`, `RATE_LIMIT_WRITES`, `RATE_LIMIT_REVIEWS_IN_FLIGHT=5`); by default it runs at most 4 reviews at once and refuses more. Script: `tools/load-sample.mjs`.

**Live, with the models:** the current system's newest run (held-out v4, 12 alerts) took a median of 45 seconds per alert; most of it is the cloud model.

## Edge cases handled

<!--fact:edge_cases-->43<!--/fact--> edge cases (names, ownership, lists and memory, data and systems, security) each have an expected outcome and a check: [docs/EDGE_CASES.md](docs/EDGE_CASES.md). Highlights: exactly 50 percent counts; 49.9 does not; 25 plus 25 from two listed owners does; circular ownership ends; a missing percentage is unknown, not zero; look-alike Cyrillic letters in a Latin name are seen through; a customer note that says "ignore previous instructions" is data; a draft that tells a customer they are being screened is refused.

## Guardrails

- Read-only by schema and by policy; no write to any source system; no customer message; no automatic block (locked off in the policy schema).
- A recommendation needs a person. `RECOMMEND_BLOCK` needs two approvals.
- The policy guard only raises caution. It stops a close on a strong match, an identifier match, a missing date of birth with a matching name, an unresolved possible match, low confidence, a watched jurisdiction, instruction-like text in the data, a failing data-quality rule, a changed approved definition, an ownership at or above the threshold, a missing ownership percentage, and an unresolved critic.
- Every model, query and external call has a timeout; loops are capped (the critic gets at most three rounds).
- Secrets come only from the environment and are scrubbed from every log line and trace event.
- Text that comes from the data is quoted as data; long fields are cut to a fixed length in prompts.

## Data sources and licences

| Data                                                                                       | Source                                     | Licence / note                                                                                                                   |
| ------------------------------------------------------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| OFAC SDN and consolidated list (`data/sample/`: 366-entry subset)                          | US Treasury OFAC, public download          | Public-domain US government data                                                                                                 |
| UN Security Council consolidated list (subset)                                             | scsanctions.un.org, public download        | Public; no explicit licence stated                                                                                               |
| GLEIF LEI records and parent relationships (`data/reference/gleif/`: 74 records, 48 links) | GLEIF public API                           | CC0 1.0, https://www.gleif.org/en/meta/lei-data-terms-of-use                                                                     |
| Customers, accounts, owners, payments, alerts, earlier decisions                           | Built by `npm run data:synthetic` (seeded) | **Synthetic**; every table says so. The list update used for re-opening cases is a labelled synthetic edit of a few real entries |

`npm run data:fetch`, `data:normalise` and `data:sample` rebuild the list data from the public sources.

## Run it live

Needs Zetaris running locally, the Nightshift runtime, and optionally Ollama.

```bash
npm install
cp .env.example .env                       # then add your own values; never commit .env
docker compose --env-file .env.data --profile data up -d --build bankdb payments-api   # synthetic bank + payments (see below)
npm run zetaris:rebuild                    # create everything in Zetaris from the committed scripts
npm run dev                                # the API on http://localhost:8000
npm run exam -- --variant routed           # the <!--fact:exam_cases-->70<!--/fact-->-case exam against live services
```

The `data` profile needs `BANKDB_ADMIN_PASSWORD`, `BANKDB_READER_PASSWORD` and `PAYMENTS_API_KEY` (any random values; keep them in a git-ignored file such as `.env.data`). The two containers join the Zetaris network only and publish no ports; `npm run check:isolation` proves that Zetaris can reach them and nothing else can.

Create the three non-admin Zetaris users and tokens as described in [docs/ZETARIS.md](docs/ZETARIS.md#roles-identities-and-tokens).

**Running the API in Docker against live services.** `SAMPLE_MODE=false docker compose up --build` runs the API in a container. Inside a container, `localhost` is the container itself, so Zetaris, Nightshift and Ollama on the host are reached at `http://host.docker.internal:<port>`: `ZETARIS_REST_URL=http://host.docker.internal:8888/api/v1.0`, `METERLESS_BASE_URL=http://host.docker.internal:8088/v1`, `OLLAMA_BASE_URL=http://host.docker.internal:11434/v1`. Compose sets these three for the `api` service (override them with `DOCKER_ZETARIS_REST_URL`, `DOCKER_METERLESS_BASE_URL`, `DOCKER_OLLAMA_BASE_URL`) and adds `extra_hosts: host.docker.internal:host-gateway`, which makes the name resolve on Linux as well as on Docker Desktop. The image sets `HOST=0.0.0.0` so the API listens inside the container; outside a container the default is `127.0.0.1`, and compose publishes the port on `127.0.0.1` unless `BIND_ADDRESS` says otherwise.

## Configuration

No URL, model name or timeout is written in the source. Configuration is layered, lowest priority first: `config/default.json` (committed defaults), `config/local.json` (git-ignored, this machine's non-secret settings such as a pinned receipt key), the file named by `CONFIG_FILE`, then environment variables, which are the only place secrets may come from. Invalid configuration stops the process at start-up. Secrets print as `[REDACTED]`.

| Variable                                                              | Overrides                          | Notes                                                                                                                                                                 |
| --------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOST`, `PORT`                                                        | `server.*`                         | Defaults `127.0.0.1`, `8000`. The container image and compose set `HOST=0.0.0.0` inside the container.                                                                |
| `WEB_ORIGINS`                                                         | `server.webOrigins`                | Browser origins allowed to call the API (the review desk interface). Comma separated.                                                                                 |
| `DOCS_ENABLED`                                                        | `server.docs`                      | Serve the OpenAPI description and Swagger UI at `/docs`. On by default.                                                                                               |
| `METERLESS_APP_REASONING`                                             | `nightshift.apps.reasoning`        | App identity for the decision, critic and challenger calls; bind it to `deep` in the Nightshift cockpit.                                                              |
| `METERLESS_APP_GUARD`                                                 | `nightshift.apps.guard`            | App identity for the safety guard calls; bind it to `local` in the Nightshift cockpit.                                                                                |
| `RATE_LIMIT_ENABLED`, `RATE_LIMIT_WINDOW_MS`                          | `server.rateLimit.*`               | Per-caller limits (the signed-in user, or the address without sign-in) in a fixed window, default 60 s. On by default; reads and `/health` are never limited.         |
| `RATE_LIMIT_WRITES`, `RATE_LIMIT_REVIEWS`                             | `server.rateLimit.*`               | Requests per window to any non-read route (default 60), and to `POST /run` and `POST /policy/whatif` (default 10). Above a limit: 429 with `Retry-After`.             |
| `RATE_LIMIT_REVIEWS_IN_FLIGHT`                                        | `server.rateLimit.reviewsInFlight` | Reviews running at once across all callers (default 4). One more is refused with 429, not queued.                                                                     |
| `AUTH_MODE`                                                           | `server.auth`                      | `auto` (tokens required live, demo users in sample mode), `on`, `demo` or `off` (tests only).                                                                         |
| `DESK_USERS_FILE`                                                     | `server.usersFile`                 | File with users, roles and the SHA-256 of each token, outside the repository.                                                                                         |
| `DESK_OUTBOX_DIR`                                                     | `actions.outboxDir`                | Folder for the records written after an approval. Nothing in it is sent anywhere.                                                                                     |
| `DESK_SIGNING_KEY_FILE`                                               | `actions.signingKeyFile`           | Ed25519 private key (PEM) outside the repository. Without it, records are hash-sealed, not signed.                                                                    |
| `DESK_SIGNING_PUBLIC_KEY`                                             | `actions.publicKey`                | Ed25519 public key (base64) that signed records are checked against.                                                                                                  |
| `NEXT_PUBLIC_API_URL`                                                 | none                               | Where the browser reaches the API (the review desk interface, `apps/web`). Default `http://localhost:8000`. Fixed when the interface is built.                        |
| `LOG_LEVEL`, `LOG_DIR`                                                | `logging.*`                        | A relative `LOG_DIR` is resolved from the project root.                                                                                                               |
| `TRACE_STDOUT_PRETTY`                                                 | `logging.pretty`                   | `true` prints one short line per trace event (time, agent, action, status, summary, receipt id) instead of the JSON line. Off by default; `npm run case` turns it on. |
| `SAMPLE_MODE`                                                         | `sampleMode`                       | `true` runs on saved answers and the labelled stand-in.                                                                                                               |
| `ZETARIS_REST_URL`, `ZETARIS_ORG_ID`                                  | `zetaris.*`                        |                                                                                                                                                                       |
| `ZETARIS_UI_URL`                                                      | none                               | The Zetaris web interface, used only by `npm run zetaris:agents` to issue the runtime tokens. Default `http://localhost:3000`.                                        |
| `ZETARIS_API_KEY`                                                     | `zetaris.apiKey`                   | Secret. Setup tooling and the labelled fallback only.                                                                                                                 |
| `ZETARIS_TOKEN_EVIDENCE`, `_REVIEWER`, `_EVAL`                        | `zetaris.tokens.*`                 | Secrets. One per runtime identity.                                                                                                                                    |
| `METERLESS_BASE_URL`, `METERLESS_APP_ID`, `METERLESS_EVAL_APP_ID`     | `nightshift.*`                     | The evaluation app id keeps the runtime's answer cache separate from live use.                                                                                        |
| `METERLESS_RUNTIME_TOKEN`                                             | `nightshift.runtimeToken`          | Secret.                                                                                                                                                               |
| `METERLESS_MODEL_FAST`, `_DEEP`, `_JUDGE`                             | `nightshift.models.*`              | Must be pinned modes.                                                                                                                                                 |
| `METERLESS_RECEIPT_PUBLIC_KEY`                                        | `nightshift.receiptPublicKeys`     | Comma separated base64 Ed25519 keys; marks receipts `valid_pinned`.                                                                                                   |
| `OLLAMA_BASE_URL`, `OLLAMA_MODEL`                                     | `ollama.*`                         | Backup provider.                                                                                                                                                      |
| `DESK_API_URL`, `DESK_TOKEN`, `DESK_DEMO_USER`                        | (MCP server only)                  | Where the MCP server finds the desk API, and the token (or, in sample mode, the demo user) it sends. See [docs/MCP.md](docs/MCP.md).                                  |
| `METERLESS_ENGINES_DIR`                                               | none                               | Folder with the engine conformance runners for `npm run test:engines`. Default `../meterless-engines`.                                                                |
| `BANKDB_ADMIN_PASSWORD`, `BANKDB_READER_PASSWORD`, `PAYMENTS_API_KEY` | none                               | Used by the `data` Docker profile (synthetic bank and payments service). Secrets.                                                                                     |
| `PAYMENTS_FILE`                                                       | none                               | Payments service data file when run outside Docker. Default `data/synthetic/payment.json`.                                                                            |
| `LIVE_TESTS`                                                          | none                               | Set to `1` to run the live model checks (`npm run test:live`).                                                                                                        |
| `ZETARIS_CHECK_CONTAINER`                                             | none                               | Container used by `npm run check:isolation`. Default `zetaris-driver-1`.                                                                                              |

## API

Interactive description at `http://localhost:8000/docs` (Swagger UI), and worked examples in [docs/API.md](docs/API.md).

Errors have one shape: `{ "status": "error", "request_id": "...", "error": { "type", "message", "recoverable" } }`.

| Method and path                                                                                    | Purpose                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`, `GET /health/dependencies`                                                          | Liveness; readiness of Nightshift and Ollama.                                                                                                                                                                          |
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

## Policy

`config/policy.default.json` is the initial policy: lists and weights, name threshold, ownership threshold and depth, watched jurisdictions (a configurable example, to be checked against current sanctions programmes before use; each has place names that count when found in a payment reference), automation limits, the critic's round limit and confidence floor, the mode and reasoning budget per step, the Zetaris role per step, the guard texts and patterns.

The hard limits are fixed in the policy schema, so no draft can lift them: no automatic block, no customer messages, read-only data access. The policy also holds the **documentary evidence standard**: a customer note or payment reference counts as documentary evidence only when it carries a check reference, a document number and a date (and, for a payment, a named counterparty). Anything less is a claim: it is shown to the reviewer but cannot clear a match, and a close that rests on it is raised to NEED_MORE_INFO by the policy guard. A note that meets the standard and states a date of birth supplies it when the customer has none on record. The standard was added in policy version 2, before the held-out run; see [docs/EVALUATION.md](docs/EVALUATION.md#definition-changes).

A change is a draft, then a publish by a different person (four-eyes). A published version applies to the next run without a restart, every sealed decision record names the policy version it used, and `POST /policy/whatif` shows what a draft would change on the exam before anyone publishes it. Versions and the audit log are kept in memory; a restart returns to the policy file.

## Development

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

The governance view, mapped to the headings of the Monetary Authority of Singapore's proposed AI risk management guidelines (a mapping, not a compliance claim), is in [docs/GOVERNANCE.md](docs/GOVERNANCE.md) and on the Governance page of the review desk.

## Failure handling

| What fails                                                                                  | What the system does                                                                                                                                                     | What the user sees                                                                                                          |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| The model service is down, or a step gets no answer at all                                  | Tries the next mode, then the Ollama backup, with a short pause after a provider failure. If every try fails, the decision step escalates the case; it never closes one. | An escalation with the reason "model decision unavailable"; the report counts provider failures apart from unusable answers |
| A model answer cannot be used (cut off, no JSON, an unknown decision word, a wrong type)    | Answers are requested as schema-constrained JSON; known spellings of the four decisions are read as the same decision; a bad answer is retried on the next mode          | The same escalation if every try fails, with the cause (service failure or unusable answer)                                 |
| The critic finds a cited fact that is not true, or does not exist                           | The recommendation goes back to the decision step with notes, up to three rounds; if the critic still cannot approve, the policy guard escalates                         | "critic: escalated after 3 rounds" and the critic's reasons                                                                 |
| The challenger cannot answer, or finds a credible true-match argument                       | A close does not stand either way: it becomes an escalation                                                                                                              | The escalation, with the argument or "the close could not be challenged"                                                    |
| A data-quality rule fails on the customer's or payment's record                             | No close; the outcome becomes "need more information" and confidence is capped                                                                                           | The rule's name and the capped confidence with its reason                                                                   |
| An ownership percentage is missing, the chain loops, or it is longer than the policy allows | The percentage is "unknown", never zero; a loop ends; a chain over the limit escalates                                                                                   | "Need more information" or an escalation with the ownership step's reason                                                   |
| Text in the data tries to instruct the reviewer                                             | It is treated as data, flagged, and never closes a case                                                                                                                  | A flagged check on the case, and an escalation                                                                              |
| A draft message to a customer would reveal screening or an investigation                    | The draft is refused                                                                                                                                                     | The refusal and the reason                                                                                                  |
| A role's Zetaris token is refused, or access was emptied by a rebuild                       | A live API refuses to start and prints the fix steps; with the admin fallback switched on, the retry is labelled                                                         | The start-up message; every query record names the credential used                                                          |
| A query is outside an agent's tables or columns, or is not a single read-only statement     | It is blocked before anything is sent                                                                                                                                    | A recorded block (`agent_scope` or the guard's code)                                                                        |
| A policy change lifts a hard limit or has no second approver                                | It is rejected                                                                                                                                                           | The validation error naming the field, or the four-eyes refusal                                                             |
| A model receipt does not verify                                                             | The call is kept, with its status                                                                                                                                        | `valid_pinned`, `valid_unpinned` or `invalid` in the model ledger                                                           |
| No live services are available                                                              | Sample mode replays saved answers with a labelled rules stand-in                                                                                                         | A notice on every answer saying so                                                                                          |

## Responsible AI

- **A person decides.** The desk recommends. It never blocks an account, never writes to a source system and never contacts a customer; those limits are fixed in the policy schema and cannot be lifted by a policy change. A recommended block needs two approvals.
- **Evidence you can check.** Every cited fact is re-read from the data by code before the critic's model sees it; a claim that does not match is never approved. Each recommendation has a sealed decision record and a trace that answers four questions: which approved definition applied, what data it rested on, who could see what, and what it cost.
- **Synthetic data only.** Customers, accounts, owners and payments are generated; only the listed parties are real public entries.
- **Memory without personal data.** Earlier decisions are remembered as an outcome, reason codes and a pointer to the row (table, key, content hash). The pointer is re-checked each time and goes stale when the listed entry changes; a memory can inform a decision but cannot close an alert on its own.
- **Least privilege.** Each agent can read only its own tables and columns; identifier numbers are hidden by the application (see below); the model service never receives them. Zetaris's HIDE policy for `customer_identifier.id_number` is configured for the evidence role, but this local edition does not enforce it. The application enforces it instead: the SQL guard stops every agent except the evidence step from naming the column, the evidence step's masking returns only the last two characters, and a customer identifier is compared with a listed one by a join inside Zetaris so the number is never read into the application. Tests prove each part (`packages/zetaris/test/guard.test.ts`, `client.test.ts`, `tools.test.ts`).
- **Fairness in name matching across languages.** What was measured: six transliteration cases across Cyrillic, Arabic and Han scripts, look-alike letters, accents, name order and spelling variants, and every one of those that carried real risk was escalated, none closed. What was not measured: other scripts and naming conventions, and how often common names in any one culture are escalated without cause. Name matching tends to raise more alerts for people whose names are common or transliterated in many ways, and the cost of that falls on those customers as extra review. Before any real use, measure the escalation rate by name origin and set the thresholds with that in mind.
- **Where the models run.** Most decision and critic calls are answered by a cloud model through Nightshift. That is acceptable for synthetic data; with real customer data it needs an explicit decision about what may leave the machine.

## FAQ

**How does Zetaris keep the data in place and mask fields?** The data stays in its sources (the file store, the bank database, the payments service); Zetaris federates them into one semantic layer, and the agents send one read-only `SELECT` at a time to it, so nothing is copied into the desk except query answers. Identifier numbers are protected in three ways: the SQL guard stops every agent except the evidence step from naming the column, the evidence step's masking returns only the last two characters, and a customer's identifier is compared with a listed one by a join inside Zetaris, so the number is never read into the application. Zetaris's own column policy for that column is configured, but this local edition does not enforce it, which is why the application does. See [docs/ZETARIS.md](docs/ZETARIS.md) and `packages/zetaris/test/guard.test.ts`.

**How does memory change a decision?** The memory step recalls earlier decisions about the same customer and listed party, kept by H-MEM as pointers to the rows they rested on. A fresh pointer (the listed entry has not changed) can be cited by the decision, and a still-valid clearance on a case the definitions call a false positive takes the short path. A stale pointer (the entry changed since) is shown as stale and not relied on. Memory alone never closes a case, and a person's override beats it. Measured on the earlier-cleared cases: 11 of 11 acceptable with memory, 10 of 11 without. Example: [output_examples/close-previously-cleared/](output_examples/close-previously-cleared); a stale one: alert ALR-0058 in sample mode.

**How does the 50 percent ownership rule work?** The World Model holds who owns whom, with sources and dates. Shares multiply along a chain and add up across listed owners; at or above 50 percent (exactly 50 counts) a listed party effectively owns the company and the alert is escalated; below it the ownership alone does not stop a close; a missing percentage is unknown and the desk asks for more information; loops end, and a chain longer than the depth limit goes to a person. See the `effective_ownership_threshold` definition, [docs/EDGE_CASES.md](docs/EDGE_CASES.md) and `npm run test:engines` (World Model 8/8).

**What happens when data is missing or a service is down?** Missing data is never filled in: a record that fails a data-quality rule (for example no date of birth) cannot support a close and the case asks for more information. If the screener cannot read the free text, the case cannot be closed. If no model answers after the retry and the fallback, the case is escalated, never closed. If Zetaris cannot be reached, the review stops with an error and makes no recommendation (measured with a closed port: 4 of 4 cases stopped, no close). Every failure moves the case towards a person. See [Failure handling](#failure-handling).

**Why does every decision need a person, and a block two?** The desk recommends; it never blocks an account, writes to a source system or contacts a customer, and those limits are fixed in the policy schema, so no policy change can lift them. A person approves or overrides each recommendation with a reason, recorded against the sealed record. A block stops a customer's money and is the most serious outcome, so it needs a second, different approver. See `packages/agents/src/human-decision.ts` and the roles check in `npm run prove`.

**What are the known limits?** The local screener over-flags, so correct clears go to a person; every result is one run; the data is synthetic. The full list is under [Limits](#limits), [Not built / not verified](#not-built--not-verified) and [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md).

## Not built / not verified

- **The local screener over-flags.** On held-out v2 its blocking "relationship to listed party" signals pointed at text with no relationship word and no name (often the first 30 characters of a note), and no clear was made (0 of 5). A span-grounding check and a list of citable sources were added after that run and tested once, blind, on held-out v3 (a new set frozen before the fix): it made things worse on risk, **2 of 6 risk cases were wrongly closed** (a son of a listed person, a nominee). The screener flagged both relationships at 0.9 but grounding marked them not grounded; the decision first escalated, citing them; the critic rejected those citations as not citable and the decision then closed; and under policy 7 the guard let a close stand on signals that were not grounded; no clear was made (0 of 6), four of them because the note's document was not on the customer record. Reported as run; the v2 numbers are reported as they were. The grounding window was not widened and v3 was not re-run; instead policy version 8 fails closed: a signal marked not grounded is still shown and still blocks a close. On held-out v4 (the last round, frozen before that change) no risk case was closed (0 of 6), and no clear was made either (0 of 6): every clear met the documentary standard with its document on the customer record, but each carried a relationship signal at 0.9 that the screener could not ground, and that now blocks. **The desk does not clear alerts beyond what the rules clear**; its measured value is the risk it does not close.
- **Critic deadlocks.** When the decision cited a source the critic cannot check by design (a free-text column, an identifier number, a computed block), both repeated themselves for three rounds and the guard escalated. The decision step now gets the list of citable sources and such citations are set aside from the second round; on held-out v3 one deadlock still happened (HO3-012), and on v4 one (HO4-012). The critic still tells the decision step that screener signals cannot be cited, which is how both v3 wrong closes came about; under policy 8 the guard blocks such a close, but the critic rule itself is unchanged (feature freeze).
- **Thermal limits.** Long runs on one laptop drive the model runtime into a serious thermal state; the runner cools down between cases and pauses when it lasts. Provider failures are counted per run and shown by thermal posture for the 70 cases, v1 and v2. The routed v4 run ran without the gate (see Limits).
- **Nemotron 3 Super 120B.** The runtime lists it, but its cloud endpoint was retired during development (it answered "Function not found"), so the cloud lanes use Nemotron 3 Ultra. From development notes; not re-measured.
- **Single runs.** Every result is one run; repeats of the held-out sets were not made. Held-out v4 was the last held-out round; nothing was changed after it.
- **Not measured:** a run without Zetaris other than the unreachable-endpoint test, the policy guard switched off, the challenger alone, a "Nemotron alone" baseline, the Lightning-versus-Ultra study and a pinned-model run.
- Everything in [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md), including the Zetaris column policy on identifier numbers that this local edition does not enforce, the payments cache lost on an engine restart, and the local model's empty answers to schema-constrained requests.

## Limits

- The customers, accounts, owners and payments are **synthetic**; only the listed parties are real public entries. The exam measures behaviour on planted situations, not performance on a bank's real alert volume.
- The approved definitions are written in this repository for the exam, and the exam's labels follow the same definitions. A high score shows consistency with them, not that they are the right ones for a given bank.
- Each variant in the report is one run. Model answers vary between runs and the runtime may answer a repeated prompt from its cache.
- Speed: the first-system run of the 70-case exam took a median of 130 seconds per alert (the headline measure), because it uses a large cloud model, a critic and sometimes a challenger; the changed system took a median of 62 seconds a case on the same cases and 45 seconds on held-out v4. One run each, on one laptop.
- Cost figures use illustrative unit costs. Analyst time saved was not measured; the report's minutes-saved figure is an estimate on stated assumptions and is not claimed here.
- Sanctions law and list programmes change; the jurisdiction list is an example.
- Embeddings are not used: this Nightshift build serves no embedding route.
- Zetaris model access is set in its interface and is emptied by a rebuild; the HIDE policy on identifier numbers is configured but not enforced by this local edition, so the application enforces it in the SQL guard and the masking, and tests prove it. See `docs/ZETARIS.md`.
- Model answers vary between runs, and cloud routing is decided by the runtime.
- **The local screener over-flags relationships**, so on the held-out sets the correct clears go to a person: the fail-closed rule (policy version 8) makes every signal at or above its threshold block a close, grounded or not. On held-out v4 that cost all six clears; no risk case was closed.
- **The routed held-out v4 run ran without the thermal gate** (an operator slip, recorded in the run log); the single, rules and escalate-all runs of v4 used it. It was not re-run, so the set stays run once.

## Future work

- **A stronger local screener model**, so fewer relationship signals are raised on text that holds no relationship, and correct clears are not held back by the fail-closed rule.
- **Keep all raw text on the machine.** Today only the local screener reads notes and payment references and the cloud steps get structured signals; a screener answer served by a cloud route is flagged. The next step is to make a local-only route a hard requirement for the screener.
- A pinned-model run (exact model per step) once Nightshift 1.2.3 is installed, and repeated held-out runs to show the spread between runs.

## AI and Model Usage

Disclosure under section 6 of the event's AI Usage Policy.

**Models, through Meterless Nightshift.** Every model call in the product goes through Nightshift, an OpenAI-compatible runtime, as the primary provider. The models are NVIDIA Nemotron: **Nemotron 3.5 Lightning 30B** (on a local laptop) and **Nemotron 3 Ultra 550B** (cloud). Nightshift's router decides which of them answers a call unless the cockpit binds the app; the table under [NVIDIA Nemotron](#nvidia-nemotron) is the split measured from the signed receipts, and [docs/MODELS.md](docs/MODELS.md) explains each step.

| Step                                | Model                                         | What it does                                                                                                                                                                                                                                                                  |
| ----------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Safety guard (inbound and outbound) | Nemotron 3.5 Lightning 30B, on a local laptop | Reads free text that came out of the data for instructions aimed at the reviewer; checks a draft for a customer against the tipping-off policy. The guard's app identity is bound to _local_ in the Nightshift cockpit, and 24 of 24 lab calls were served locally (receipts) |
| Decision                            | mostly Nemotron 3 Ultra 550B (cloud)          | Reads the evidence and the approved definitions; recommends one of four outcomes with cited facts                                                                                                                                                                             |
| Critic                              | mostly Nemotron 3 Ultra 550B (cloud)          | Looks for claims the evidence does not support (cited facts are re-read from the data by code first)                                                                                                                                                                          |
| Challenger                          | mostly Nemotron 3 Ultra 550B (cloud)          | Argues the case against a close that could slip through                                                                                                                                                                                                                       |

"Mostly" is a measurement, not a promise: Nightshift's router chooses the model for these three steps, and the split from the signed receipts is in the table under [NVIDIA Nemotron](#nvidia-nemotron). We tried binding their app identity to the _deep_ mode in the cockpit; that races both models, so it did not make the routing deterministic (19 of 21 lab calls were served by Ultra, 2 by Lightning). The cockpit variables and the steps to set them are in [docs/MODELS.md](docs/MODELS.md#two-app-identities-and-what-the-cockpit-does-with-them).

The Ollama backup (`nemotron-3.5-lightning:30b`) answers only if Nightshift cannot. In sample mode a labelled rules-based stand-in answers instead. No other model provider is named anywhere in the code.

**Agent frameworks.** None. The agents are our own orchestration: plain TypeScript functions in `packages/agents`, one injected `generator` function for model calls, a bounded loop (at most 3 critic rounds) and a sealed, hash-chained decision record. There is no LangChain, LlamaIndex, AutoGen or similar.

**Sponsor technology.**
- **Zetaris** serves all the data the agents use. The agents never open a file or a database: each sends one read-only SQL statement at a time to the Zetaris REST API and reads the Unified Semantic Layer (14 tables over lists, a bank database and a payments service), under per-agent roles and with data-quality rules. See [docs/ZETARIS.md](docs/ZETARIS.md#zetaris-checklist).
- **Meterless engines**: H-MEM (agent and analyst memory), World Model (ownership and the 50 percent rule) and Markovian (re-screening after a list change). Each runs in a working feature and has a passing test, and the official conformance suites run in `npm test` (H-MEM 13/13, World Model 8/8, Markovian 8/8). See [docs/SPONSORS.md](docs/SPONSORS.md#2-meterless-engines-three-each-in-a-working-feature-each-with-a-passing-test).
- **Meterless Nightshift** is the primary model provider. The app connects with `METERLESS_BASE_URL`, a bearer key and the `meterless-app` header, asks for a pinned mode per step, and stores each call's signed receipt.
- **NVIDIA Nemotron** is the only family of language models used, in the steps above.

**Development tools.** Built with Claude Code. AI-assisted coding was used for scaffolding, tests, debugging and documentation. All generated code was reviewed and tested. Cursor was not used.

**External tools and libraries.** Node.js, TypeScript, Fastify, Zod, Pino, Next.js and React, Vitest and Biome, and `tsx`; Postgres for the synthetic bank database; Docker for packaging. Security checks used npm audit, Semgrep, Trivy, Gitleaks and ZAP. Versions are in `package-lock.json`.

**Data.** The lists are real public data: OFAC SDN and consolidated list, the UN consolidated list and GLEIF, with licences in [Data sources and licences](#data-sources-and-licences). **All customer, account, ownership and payment data is synthetic**, produced by a seeded script; nothing comes from a real bank, client or employer.

**Open-source code adapted.** The three Meterless engines in `packages/engines/src` are derived from the Meterless reference implementations, and the official conformance suites in `packages/engines/conformance` are copied without change (Apache-2.0). Attribution is in `NOTICE` and `THIRD_PARTY_NOTICES.md`.

**Known limitations.** A person makes every decision by default; the desk only recommends. The exam labels follow the same definitions as the rules, so a high score on the 70 rule-defined cases shows consistency, not that the definitions are right; the held-out set is the test of reasoning beyond them. Model answers vary between runs and cloud routing is decided by the runtime. Cost figures rest on stated unit costs; analyst time saved was not measured and is not claimed. The column policy on identifier numbers is not enforced on the Zetaris instance used, so the application masks them as well. The full list is under [Limits](#limits).

**Sample mode.** With `SAMPLE_MODE=true` the desk runs without Zetaris or Nightshift. It replays saved answers recorded from real Zetaris runs, runs the real agent logic on them, and uses a rules-based stand-in in place of the language models. The interface says so in a banner on every page, and every record made this way carries a sample notice. Sample mode never presents the stand-in's output as a Nemotron answer.

## Pre-existing work

Pre-existing components: none; first commit 22 Oct 2026.

No pre-existing code; everything in this repository was built during the build window (22–27 Oct 2026). Third-party code: Meterless engine specs/reference and conformance suites (Apache-2.0), see `NOTICE`.

## Third-party code and licence

Apache-2.0. See `LICENSE` and `THIRD_PARTY_NOTICES.md` (Meterless engine specifications and reference implementations, GLEIF data).
