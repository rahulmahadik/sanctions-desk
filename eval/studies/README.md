# Small studies

These are small live studies run on 24 and 25 Oct 2026. They are **not part of the recorded evaluation** (that is in [eval/runs](../runs) and [eval/results](../results)). Each one is a few runs on a small set of cases, so it shows the shape of a result, not a measured difference.

Each run folder has the same files as an exported evaluation run:

- `results.json`: the run's result file, as written by the run.
- `trace.jsonl.gz`: every logged event of the run.
- `receipts.jsonl.gz`: the signed Nightshift receipt of every model call, copied untouched.
- `run-meta.json`: where the run came from, its settings, and the size and SHA-256 hash of each file.

Tokens, local paths, hostnames and addresses other than the local machine, usernames, e-mail addresses and secret values are removed from the results and the trace, with the same patterns as `npm run evidence:export`. In the study runs nothing needed removing, so each `results.json` is byte for byte the file the run wrote; in the step-role reviews below, a few local paths and host names were removed from the traces. The receipts are never edited, because their signatures cover them.

[index.json](index.json) lists every study run with its source file, start time, case count, event count and receipt count; the step-role reviews are not in it (see their folder, `step-role-reviews/`).

## Check them

```bash
npm run evidence:verify                                   # every run in eval/runs and here
npm run evidence:verify -- eval/studies/<study>/<run-id>  # one run
```

For each run this checks every receipt's signature against the pinned Nightshift key in `config/default.json`, that every model call in the trace has its receipt, that the model the trace names is the model the receipt says served the call, and that every file still matches the hash in `run-meta.json`.

`npm run studies:export` rebuilds these folders from the local logs. It calls nothing live.

## The studies

| Folder | Runs | What it shows | Cited by |
| --- | --- | --- | --- |
| [nemotron-alone-v1-v3](nemotron-alone-v1-v3) | Nemotron alone, once on held-out v1 (30 cases) and once on held-out v3 (12 cases) | One cloud Ultra call per case on the structured case facts, with no free text, critic, challenger, policy guard or memory, on the two rounds where the full system wrongly closed risk cases | [docs/NEMOTRON.md](../../docs/NEMOTRON.md) (Nemotron alone on held-out v1 and v3), [eval/nemotron-alone-sets.json](../nemotron-alone-sets.json) |
| [repeat-heldout4](repeat-heldout4) | Held-out v4 (12 cases): the full system three times (`repr1` to `repr3`), Nemotron alone three times (`r1` to `r3`), and, on 25 Oct, Nemotron alone given the free text the screener reads three times (`text1` to `text3`; this arm sends the synthetic free text to the cloud model, which the desk never does) | How often each gives the same outcome across runs, and how many risk cases each closes | [docs/NEMOTRON.md](../../docs/NEMOTRON.md) (What the agents add over Nemotron alone), [eval/repeat-study.json](../repeat-study.json) |
| [heldout3-rerun](heldout3-rerun) | Held-out v3 (12 cases): today's system three times (`todayt1` to `todayt3`) | Held-out v3 re-run after the fail-closed fix. Not blind: the cases were known. The recorded v3 result stays the headline | [docs/EVALUATION.md](../../docs/EVALUATION.md) and [docs/NEMOTRON.md](../../docs/NEMOTRON.md) (Held-out v3 three ways), [eval/v3-today.json](../v3-today.json) |
| [model-choice](model-choice) | Decision, critic and challenger on Nemotron 3.5 Lightning (local): held-out v4 (12 cases) and 8 of the 70 exam cases | The Lightning arm of the model-choice study. The default (Ultra) arm is the privacy-mode-off pair in `privacy-mode`. [STUDY.md](model-choice/STUDY.md) is the table written at the time | [docs/NEMOTRON.md](../../docs/NEMOTRON.md) (Why two models), [eval/model-choice.json](../model-choice.json) |
| [privacy-mode](privacy-mode) | The full system with privacy mode off (`privoff`) and on (`privon`), each on held-out v4 (12 cases) and the same 8 exam cases | Which model served each step, and whether pseudonymising the cloud calls changed the outcomes | [docs/NEMOTRON.md](../../docs/NEMOTRON.md) (Small test of an optional mode), [eval/receipt-stats.json](../receipt-stats.json) |
| `local-mode` (written by `npm run study:local-mode` once its runs are in) | Held-out v4 (12 cases): the current system three times with every model step on Nemotron 3.5 Lightning on the laptop (`a3-local-r1` to `a3-local-r3`) and three times in the default mode (`a3-default-r1` to `a3-default-r3`) | What the fully local mode costs in outcomes, time per case and cloud calls | [docs/NEMOTRON.md](../../docs/NEMOTRON.md) (Fully local mode), [eval/local-mode.json](../local-mode.json) |

## The live step-role reviews

[step-role-reviews](step-role-reviews) holds three live reviews run on 25 Oct 2026 (about 02:30 SGT) with every data-reading step under its own non-admin Zetaris identity: ALR-0073, ALR-0043 and ALR-L0007. For each: `record.json` (the sealed decision record, copied untouched so its hash still checks), `trace.jsonl.gz` and `receipts.jsonl.gz` (14 receipts in all, each valid against the pinned key).

[statement-history-audit.json](step-role-reviews/statement-history-audit.json) is the read-only check, run again on 25 Oct 2026 and saved this time: the statement history of each step identity (evidence, ownership, critic, memory, document) was read with that identity's own token, because Zetaris keeps one history per user. A statement counts when it is in the history of exactly the identity its step should use and its text hash matches the record. Result: 64 of 64 (ALR-0073 23 of 23, ALR-0043 21 of 21, ALR-L0007 20 of 20).

Two things to know when reading the records: the `role` field of each query is the masking role the policy applied (`role_evidence_agent` for every step), not the identity that ran it; and the document-on-record check is kept under the evidence step (`agent: evidence`, `redacted: true`) but runs as the document identity. The identity is shown by the statement history, not by the record.
