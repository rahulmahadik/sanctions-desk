# How NVIDIA Nemotron is used

Sanctions Desk uses two NVIDIA Nemotron models, both through Meterless Nightshift: **Nemotron 3.5 Lightning 30B** on the analyst's laptop, where the raw text is, and **Nemotron 3 Ultra 550B** in the cloud, where the reasoning over structured evidence happens. Every answer from Nightshift carries a signed receipt naming the model that served it, so each statement below can be checked.

## Which model does each step, and why

| Step                           | Model                      | Where                                                      | Why this model                                                                                                                                                            |
| ------------------------------ | -------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Safety guard (inbound)         | Nemotron 3.5 Lightning 30B | Laptop (`sanctions-desk-guard`, bound to the local lane)   | It reads the free text of the data to flag instructions aimed at the reviewer, so the text must stay on the machine; a short yes/no answer, about half a second.          |
| Free-text screener             | Nemotron 3.5 Lightning 30B | Laptop (same identity)                                     | It reads customer notes, payment references and list remarks and returns risk signals with the exact text span; only those structured signals go further.                 |
| Decision                       | Nemotron 3 Ultra 550B      | Cloud (`sanctions-desk-reasoning`, bound to the deep lane) | Applying the approved definitions to many fields at once and citing the rows it rests on is the hardest step; it receives structured fields and signals, never free text. |
| Critic                         | Nemotron 3 Ultra 550B      | Cloud (same identity, `judge` mode)                        | It checks the recommendation against the evidence after code has re-read every cited fact from Zetaris.                                                                   |
| Challenger                     | Nemotron 3 Ultra 550B      | Cloud (same identity)                                      | It argues against a close before it can stand.                                                                                                                            |
| Safety guard (outbound drafts) | Nemotron 3.5 Lightning 30B | Laptop                                                     | It checks a draft meant for a customer for tipping-off wording, on top of fixed patterns.                                                                                 |

![A live review of ALR-0073: the safety guard and screener answered by Lightning on the laptop, the decision and critic by Ultra in the cloud, each with its receipt id](media/screenshots/13-live-agent-map.png)

Nightshift's learned router chooses the model inside the lane each app identity is bound to. In the headline run the receipts show the safety guard on Lightning in 70 of 70 calls and the decision, critic and challenger on Ultra in 187 of 190 (3 answered by Lightning). The desk asks for a pinned mode per step (`meterless/fast`, `meterless/deep`, `meterless/judge`) and records both the mode asked for and the model that answered. Details: [MODELS.md](MODELS.md).

<!-- adversarial:start -->
**Safety guard against injected text (one run, 2026-10-23, policy 7):** Lightning flagged 70 of 70 injected instructions, against 24 for the fixed patterns alone, and 12 of 12 tipping-off drafts (patterns: 1); it wrongly flagged 1 of 23 harmless texts. It tests the safety guard only, not a full review. Details: [EVALUATION.md](EVALUATION.md#safety-guard-against-injected-text).
<!-- adversarial:end -->

## The privacy design

- **Free text never goes into a cloud prompt from the desk.** Before each decision, critic and challenger call, code compares the prompt with the case's notes, payment references and list remarks; if any of them, or a run of 20 characters from one, is in the prompt, the call is not made and the case goes to a person ([MODELS.md](MODELS.md#what-leaves-the-machine-per-step)).
- **Nightshift's own answer memory is off.** It was on during the recorded runs and could add earlier answers, local ones included, to a cloud request; that cannot be checked for those runs. Since 24 Oct 2026 it is off, checked on the live runs since (no receipt carries an added memory) ([MODELS.md](MODELS.md#nightshifts-own-memory-switched-off-on-24-oct-2026)).
- **Optional privacy mode.** With `PRIVACY_MODE=pseudonymise` the cloud steps receive per-case tokens instead of names, identifiers, dates of birth, addresses and countries, plus the comparison worked out locally; a prompt that still holds a raw value is not sent. Small test of an optional mode, not part of the recorded evaluation: 0 wrong closes in both modes; 14 of 20 outcomes identical; all 65 cloud prompts passed the raw-value check ([MODELS.md](MODELS.md#privacy-mode)).

## Why two models: a small study of model choice

The same 20 cases were run with the decision, critic and challenger on Ultra in the cloud (the default) and on Lightning on the laptop. It is one live run per arm on a small sample, so it shows the shape of the trade-off, not a measured difference.

<!-- model-choice:start -->
**Small study of model choice, not part of the recorded evaluation.** Held-out v4 (12 cases) and 8 of the 70 exam cases (4 risks, 4 clears), one live run per arm on 24 Oct 2026, Nightshift warmed up and not restarted. The default arm is the privacy-mode-off run of the same day.

| Arm                                                                      | Risk cases wrongly closed | Clears made | Outcomes identical to the default | Errors | Reasoning calls (receipts verified) | Median s per reasoning call | Median s per case | Answers set aside for more than 8 facts | Backup answers (no receipt) |
| ------------------------------------------------------------------------ | ------------------------: | ----------: | --------------------------------: | -----: | ----------------------------------: | --------------------------: | ----------------: | --------------------------------------: | --------------------------: |
| Decision, critic and challenger on Nemotron 3 Ultra (cloud), the default |                   0 of 10 |     3 of 10 |                          20 of 20 |      0 |                             75 (75) |                        27.4 |               113 |                                       6 |                           6 |
| Decision, critic and challenger on Nemotron 3.5 Lightning (local)        |                   0 of 10 |     1 of 10 |                          10 of 20 |      4 |                             81 (81) |                         8.3 |               387 |                                       0 |                          32 |

Which model served the reasoning calls (receipts): Ultra arm (default): Nemotron 3 Ultra 550B (cloud) 62, Nemotron 3.5 Lightning 30B (local) 13; Lightning arm: Nemotron 3.5 Lightning 30B (local) 81.
<!-- model-choice:end -->

![Reasoning steps: Ultra in the cloud or Lightning locally](media/charts/model-choice.png)

Read plainly: neither arm closed a risk case. With Lightning doing the reasoning, the desk made fewer clears, reached the same outcome as the default on half the cases, had 4 cases with no usable decision, and took longer per case, because many local reasoning calls through Nightshift failed and fell back to the Ollama copy of Lightning. Ultra's single calls are slower, but its answers were usable far more often. That is why the reasoning steps are bound to the cloud lane and the raw-text steps to the laptop. One run per arm on 20 cases shows the shape of the trade-off, not a measured difference.

## What the agents add over Nemotron alone

The same 12 held-out cases, three runs each: the full system, and Nemotron alone (one Ultra call per case on the structured case facts the decision step gets, with no free text, no critic, no challenger, no policy guard and no memory, through the same Nightshift path with receipts). It is reported as measured, including where Nemotron alone does as well or better.

The runs were made on 24 and 25 Oct 2026; the table below is filled in from their result files once all six have finished.

<!-- repeat-study:start -->
<!-- repeat-study:end -->

## Receipt statistics

Every model call in the recorded runs and in the labelled small runs of 24 Oct 2026, per step and per model that served it, from the traces and the signed receipts. The groups are kept apart and never added together. Rebuild with `npm run receipt:stats`.

![Time per model call, by step and model](media/charts/model-latency.png)

<!-- receipt-stats:start -->
**Recorded runs (28 exported runs in eval/runs)**

| Step         | Model that served it                  | Calls | Receipts verified | Median s | p95 s | Median tokens in | Median tokens out |
| ------------ | ------------------------------------- | ----: | ----------------: | -------: | ----: | ---------------: | ----------------: |
| Safety guard | Nemotron 3.5 Lightning 30B (local)    |   386 |               386 |      0.5 |     1 |              513 |                19 |
| Screener     | Nemotron 3.5 Lightning 30B (local)    |   122 |               122 |        3 |     4 |             1571 |               223 |
| Decision     | Nemotron 3 Ultra 550B (cloud)         |   504 |               504 |     25.8 |  61.9 |             4943 |               673 |
| Decision     | Nemotron 3.5 Lightning 30B (local)    |    16 |                16 |     13.3 |  70.8 |             4232 |               531 |
| Decision     | Ollama backup (Lightning, no receipt) |    15 |                 0 |     16.2 |  20.6 |             2863 |              1603 |
| Critic       | Nemotron 3 Ultra 550B (cloud)         |   418 |               418 |     23.2 |  45.7 |             3381 |               158 |
| Critic       | Nemotron 3.5 Lightning 30B (local)    |     8 |                 8 |     19.1 |  45.9 |             3258 |               672 |
| Critic       | Ollama backup (Lightning, no receipt) |     2 |                 0 |       13 |  14.9 |             1703 |              1688 |
| Challenger   | Nemotron 3 Ultra 550B (cloud)         |    38 |                38 |     26.9 |  63.9 |             3203 |               406 |
| Challenger   | Ollama backup (Lightning, no receipt) |     2 |                 0 |     20.2 |  20.5 |             1663 |              2068 |

Fallbacks: Decision: 15 answer(s) from the Ollama backup, 3 answer(s) set aside for citing more than 8 facts; Critic: 2 answer(s) from the Ollama backup, 0 answer(s) set aside for citing more than 8 facts; Challenger: 2 answer(s) from the Ollama backup, 0 answer(s) set aside for citing more than 8 facts.

**Small test of an optional mode: privacy mode off (24 Oct 2026, not part of the recorded evaluation)**

| Step         | Model that served it                  | Calls | Receipts verified | Median s | p95 s | Median tokens in | Median tokens out |
| ------------ | ------------------------------------- | ----: | ----------------: | -------: | ----: | ---------------: | ----------------: |
| Safety guard | Nemotron 3.5 Lightning 30B (local)    |    20 |                20 |      0.3 |   0.3 |              351 |                19 |
| Screener     | Nemotron 3.5 Lightning 30B (local)    |    15 |                15 |      2.3 |   4.9 |              830 |               188 |
| Decision     | Nemotron 3 Ultra 550B (cloud)         |    31 |                31 |     31.1 |  44.7 |             3716 |               690 |
| Decision     | Nemotron 3.5 Lightning 30B (local)    |     8 |                 8 |      8.4 |  15.3 |             3962 |               422 |
| Decision     | Ollama backup (Lightning, no receipt) |     5 |                 0 |      9.4 |  16.8 |             3929 |               493 |
| Critic       | Nemotron 3 Ultra 550B (cloud)         |    28 |                28 |     26.9 |  40.2 |             2169 |               165 |
| Critic       | Nemotron 3.5 Lightning 30B (local)    |     2 |                 2 |     28.4 |  52.6 |             1925 |               796 |
| Critic       | Ollama backup (Lightning, no receipt) |     1 |                 0 |      3.3 |   3.3 |             1886 |               236 |
| Challenger   | Nemotron 3 Ultra 550B (cloud)         |     3 |                 3 |     32.4 |  53.2 |             2123 |               382 |
| Challenger   | Nemotron 3.5 Lightning 30B (local)    |     3 |                 3 |     11.3 |  74.9 |             1962 |               391 |

Fallbacks: Decision: 5 answer(s) from the Ollama backup, 6 answer(s) set aside for citing more than 8 facts; Critic: 1 answer(s) from the Ollama backup, 0 answer(s) set aside for citing more than 8 facts.

**Small test of an optional mode: privacy mode on (24 Oct 2026, not part of the recorded evaluation)**

| Step         | Model that served it                  | Calls | Receipts verified | Median s | p95 s | Median tokens in | Median tokens out |
| ------------ | ------------------------------------- | ----: | ----------------: | -------: | ----: | ---------------: | ----------------: |
| Safety guard | Nemotron 3.5 Lightning 30B (local)    |    20 |                20 |      0.3 |   0.3 |              351 |                19 |
| Screener     | Nemotron 3.5 Lightning 30B (local)    |    15 |                15 |      2.1 |   4.5 |              830 |               188 |
| Decision     | Nemotron 3 Ultra 550B (cloud)         |    31 |                31 |       30 |  37.4 |             3878 |               709 |
| Decision     | Nemotron 3.5 Lightning 30B (local)    |     4 |                 4 |      8.2 |  10.5 |             4074 |               464 |
| Decision     | Ollama backup (Lightning, no receipt) |     3 |                 0 |     16.5 |    23 |             4048 |              1500 |
| Critic       | Nemotron 3 Ultra 550B (cloud)         |    28 |                28 |     18.9 |  32.9 |             2220 |               156 |
| Critic       | Nemotron 3.5 Lightning 30B (local)    |     1 |                 1 |      3.6 |   3.6 |             2922 |               215 |
| Challenger   | Nemotron 3 Ultra 550B (cloud)         |     5 |                 5 |     29.5 |  46.5 |             2143 |               322 |

Fallbacks: Decision: 3 answer(s) from the Ollama backup, 4 answer(s) set aside for citing more than 8 facts.

**Small study of model choice: decision, critic and challenger on Lightning (not part of the recorded evaluation)**

| Step         | Model that served it                  | Calls | Receipts verified | Median s | p95 s | Median tokens in | Median tokens out |
| ------------ | ------------------------------------- | ----: | ----------------: | -------: | ----: | ---------------: | ----------------: |
| Safety guard | Nemotron 3.5 Lightning 30B (local)    |    20 |                20 |      0.3 |  29.1 |              351 |                19 |
| Screener     | Nemotron 3.5 Lightning 30B (local)    |    15 |                15 |      2.4 |   6.7 |              830 |               188 |
| Decision     | Nemotron 3.5 Lightning 30B (local)    |    46 |                46 |      8.9 |  58.1 |             3803 |               443 |
| Decision     | Ollama backup (Lightning, no receipt) |    18 |                 0 |       11 |  44.5 |             3841 |               518 |
| Critic       | Nemotron 3.5 Lightning 30B (local)    |    33 |                33 |      4.8 |  46.9 |             2173 |               275 |
| Critic       | Ollama backup (Lightning, no receipt) |    12 |                 0 |     23.8 |  37.2 |             2053 |              1395 |
| Challenger   | Nemotron 3.5 Lightning 30B (local)    |     2 |                 2 |       58 |    82 |             3081 |               400 |
| Challenger   | Ollama backup (Lightning, no receipt) |     2 |                 0 |     36.2 |  51.4 |             1927 |              1500 |

Fallbacks: Decision: 18 answer(s) from the Ollama backup, 0 answer(s) set aside for citing more than 8 facts; Critic: 12 answer(s) from the Ollama backup, 0 answer(s) set aside for citing more than 8 facts; Challenger: 2 answer(s) from the Ollama backup, 0 answer(s) set aside for citing more than 8 facts.
<!-- receipt-stats:end -->

## Verify every receipt yourself

```bash
npm ci
npm run evidence:verify      # every signature of the exported runs, every call has a receipt, trace model = receipt model
```

The case view's **Verify receipt** button checks one call of a live review the same way. How a receipt is signed and how to pin the key: [MODELS.md](MODELS.md#verifying-a-receipt).

## Honest limits

- **Lane names.** The two cloud lanes in Nightshift are still named `nemotron-3-super-120b-a1` from before the Super endpoint was retired; they serve Ultra 550B, and every receipt names the model that answered ([MODELS.md](MODELS.md#why-the-cloud-lane-names-say-super-120b)).
- **Nightshift's memory in the recorded runs.** It was on, so whether text read on the laptop reached the cloud that way cannot be checked for those runs; it is off now.
- **Exact model pinning is not available.** Nightshift 1.2.1 lets the router choose inside a lane; a run with the exact model fixed per step needs a newer build, so "mostly Ultra" is a measurement, not a guarantee.
- **The Ollama backup has no receipt.** When Nightshift cannot answer, the local Ollama copy of Lightning may; those answers are labelled `ollama` and are counted in the fallbacks above.
- **One run each.** Model answers vary between runs; the small studies above are labelled and are not part of the recorded evaluation.
