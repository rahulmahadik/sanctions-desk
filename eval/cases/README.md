# Exam case files

- `exam.json`: the 70 cases used for the main exam.
- `heldout.json`: 26 "beyond the rules" cases (18 that carry risk, 8 that should be cleared). The deciding evidence is in free text (a payment reference, a customer note, a listed party's remarks), in an alias or transliteration pattern the name rules were not written for, or in documents that disagree.

## Held-out set: freeze points

The case definitions and expected labels in `heldout.json` were written and committed before any run on them. The system was not tuned on them. The set was frozen in two steps, both before any run:

| Freeze | Commit | Cases | What it holds |
| --- | --- | --- | --- |
| 1 | `61415b6863f755e6e5036792d7a838e259b70305` | HO-001 to HO-018 | 18 cases where free text, an unusual alias pattern or disagreeing documents point to a real risk. Every label is cautious. |
| 2 | `e66e9d3b8a09d28cbdb630d78f8ce412e19f796d` | HO-019 to HO-026 | 8 cases where specific, checkable free text (a verified document with another birth date, a parent's name that conflicts with the listed remarks, a payment reference naming another, unlisted party) correctly clears a match that looks strong. Label: close; escalating counts as a miss. |

Why the second step: with only cautious labels, the set cannot tell a careful system from one that escalates everything. The first 18 cases are unchanged by the second step (check with `git diff 61415b6863f755e6e5036792d7a838e259b70305 -- eval/cases/heldout.json`, which shows only added cases). To check that nothing changed after the second freeze: `git diff e66e9d3b8a09d28cbdb630d78f8ce412e19f796d -- eval/cases/heldout.json` (empty means unchanged).

Results are reported in both directions: **risks caught** (recall on the 18 cautious cases) and **clears correctly made** (the share of the 8 clear cases that are closed; the rest is the over-escalation rate), with the escalate-all baseline on the same set, which catches every risk and makes no clear.

The cases are not loaded into Zetaris or the bank database until the main exam variants have finished. Rows for them are built from their own seed and id marker (`CUST-H0001`, `ALR-H0001`, ...), so the main synthetic rows do not change when they are added.
