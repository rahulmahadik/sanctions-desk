# Small study of model choice, not part of the recorded evaluation

**Small study of model choice, not part of the recorded evaluation.** Held-out v4 (12 cases) and 8 of the 70 exam cases (4 risks, 4 clears), one live run per arm on 24 Oct 2026, Nightshift warmed up and not restarted. The default arm is the privacy-mode-off run of the same day.

| Arm | Risk cases wrongly closed | Clears made | Outcomes identical to the default | Errors | Reasoning calls (receipts verified) | Median s per reasoning call | Median s per case | Answers set aside for more than 8 facts | Backup answers (no receipt) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Decision, critic and challenger on Nemotron 3 Ultra (cloud), the default | 0 of 10 | 3 of 10 | 20 of 20 | 0 | 75 (75) | 27.4 | 110 | 6 | 6 |
| Decision, critic and challenger on Nemotron 3.5 Lightning (local) | 0 of 10 | 1 of 10 | 10 of 20 | 4 | 81 (81) | 8.3 | 385 | 0 | 32 |

Which model served the reasoning calls (receipts): Ultra arm (default): Nemotron 3 Ultra 550B (cloud) 62, Nemotron 3.5 Lightning 30B (local) 13; Lightning arm: Nemotron 3.5 Lightning 30B (local) 81.
