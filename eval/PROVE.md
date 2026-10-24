# One-command proof

Written by `npm run prove -- --write`. Every line comes from that run; nothing here is edited by hand.

- Machine time: 2026-10-24T03:05:21.575Z
- Commit: 96a206d
- Node v26.3.0 on darwin-arm64
- Reproduce: `npm ci && npm run prove` (or `npm run prove -- --fresh` to run it in a clean clone)

```text
PASS  Sample-mode review: POST /run ALR-0004 -> CLOSE_FALSE_POSITIVE, sealed record 8302c7aa14dc… verifies, sample notice shown, human review required (0.1 s)
PASS  Engine conformance: H-MEM 13/13, World Model 8/8, Markovian 8/8 (0.9 s)
PASS  Critic mutation test: 147/147 false cited facts caught over 25 decisions; 25/25 unchanged decisions approved (no false alarm); evidence standard: 5 of 5 pass; grounding and document-on-record: 3 of 3 pass (0.5 s)
PASS  Signed evidence: 26 runs: 1492/1492 receipts verified (signing key taken from each receipt, not pinned); 1492/1492 model calls have a receipt; 0 trace/receipt model mismatches (0.2 s)
PASS  Roles and four-eyes: 82/82 tests passed (pentest-access 56/56, people 26/26), 0 failed (1.0 s)
PASS  Preregistration: heldout.json cases 1-18 match; heldout.json cases 1-22 match; heldout2.json file hash matches; held-out v2 freeze commit da7aff4 is in the history; heldout3.json file hash matches; held-out v3 frozen in commit 8d7458b, the same file; heldout4.json file hash matches; held-out v4 frozen in commit 958d061, the same file (0.0 s)
PASS  No secrets in the tree: 532 tracked text files scanned: 0 credential-bearing URLs, private keys or tokens; no .env file tracked (0.1 s)
PASS: 7 of 7 checks passed
```
