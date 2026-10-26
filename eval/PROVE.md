# One-command proof

Written by `npm run prove -- --write`. Every line comes from that run; nothing here is edited by hand.

- Machine time: 2026-10-26T01:47:50.325Z
- Commit: 2d0198b
- Node v26.3.0 on darwin-arm64
- Reproduce: `npm ci && npm run prove` (or `npm run prove -- --fresh` to run it in a clean clone)

```text
PASS  Sample-mode review: POST /run ALR-0004 -> CLOSE_FALSE_POSITIVE, sealed record 5c91a966e1ac… verifies, sample notice shown, human review required (0.1 s)
PASS  Engine conformance: H-MEM 13/13, World Model 8/8, Markovian 8/8 (1.0 s)
PASS  Critic mutation test: 147 of 147 changed facts caught over 25 decisions; 25 cited facts could not be checked in sample mode; 25/25 unchanged decisions approved (no false alarm); evidence standard: 5 of 5 pass; grounding and document-on-record: 3 of 3 pass (0.4 s)
PASS  Signed evidence: 3,411 signed receipts: 2,532 from exported runs, 879 from studies, all verified against the pinned key. In the 32 exported runs: 2532/2532 receipts verified (signing key pinned); 2532/2532 receipts named in the traces are present (answers from the Ollama backup and failed calls carry none); 0 trace/receipt model mismatches; run files: 28 verified, commit field remapped (documented), 0 other differences (0.7 s)
PASS  Roles and four-eyes: 88/88 tests passed (pentest-access 56/56, people 32/32), 0 failed (1.1 s)
PASS  Preregistration: heldout.json cases 1-18 match; heldout.json cases 1-22 match; heldout2.json file hash matches; held-out v2 freeze commit 8f6976c is in the history; heldout3.json file hash matches; held-out v3 frozen in commit 02d0a2e, the same file; heldout4.json file hash matches; held-out v4 frozen in commit fc64537, the same file (0.0 s)
PASS  No secrets in the tree: 726 tracked text files scanned: 0 credential-bearing URLs, private keys or tokens; no .env file tracked (0.1 s)
PASS: 7 of 7 checks passed
```
