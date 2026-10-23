# Exam case files

- `exam.json`: the 70 cases used for the main exam.
- `heldout.json`: 18 "beyond the rules" cases. The deciding evidence is in free text (a payment reference, a customer note, a listed party's remarks), in an alias or transliteration pattern the name rules were not written for, or in documents that disagree.

## Held-out set: freeze point

The case definitions and expected labels in `heldout.json` were written and committed before any run on them. The system was not tuned on them.

- Freeze commit: `61415b6863f755e6e5036792d7a838e259b70305`
- Check that the file has not changed since: `git diff 61415b6863f755e6e5036792d7a838e259b70305 -- eval/cases/heldout.json` (empty means unchanged)

What the set can and cannot show: all 18 expected labels are cautious ones (17 escalate, 1 ask for more information; a close is never acceptable). It measures whether the system finds what the rules miss and does not close it. It does not measure over-escalation.

The cases are not loaded into Zetaris or the bank database until the main exam variants have finished. Rows for them are built from their own seed and id marker (`CUST-H0001`, `ALR-H0001`, ...), so the main synthetic rows do not change when they are added.
