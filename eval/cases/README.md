# Exam case files

- `exam.json`: the 70 cases used for the main exam.
- `heldout.json`: 30 "beyond the rules" cases (18 that carry risk, 4 that need more information, 8 that should be cleared). The deciding evidence is in free text (a payment reference, a customer note, a listed party's remarks), in an alias or transliteration pattern the name rules were not written for, or in documents that disagree.

## Held-out set: freeze points

The case definitions and expected labels in `heldout.json` were written and committed before any run on them. The system was not tuned on them. The set was frozen in three steps, all before any run, and each step is dated by its commit.

| Freeze | Commit | Cases | What changed and why |
| --- | --- | --- | --- |
| 1 | `61415b6863f755e6e5036792d7a838e259b70305` | HO-001 to HO-018 | 18 cases where free text, an unusual alias pattern or disagreeing documents point to a real risk. Every label is cautious. |
| 2 | `e66e9d3b8a09d28cbdb630d78f8ce412e19f796d` | HO-019 to HO-026 | 8 cases added where specific free text clears a match that looks strong (label: close; escalating is a miss). Added because a set of only cautious labels cannot tell a careful system from one that escalates everything. |
| 3 | `0886c4571da03fa2404f6c57d682dbc99bfd3afa` | HO-023 to HO-026 relabelled; HO-027 to HO-030 added | Policy version 2 made the documentary evidence standard explicit (a check reference, a document number and a date; a named counterparty for payments). HO-023 to HO-026 were relabelled to NEED_MORE_INFO (ESCALATE_L2 acceptable, a close is a miss) because the labels were written before the evidence standard was made explicit; under policy v2 these notes are claims. Four new clear cases, HO-027 to HO-030, carry notes or payment references that meet the standard and are labelled as closes. |

HO-001 to HO-022 are byte-identical across all three freezes; a test checks them against recorded hashes. The rows of HO-023 to HO-026 are unchanged; only their labels and notes changed. After freeze 3 the set has 30 cases: 18 that carry risk, 4 that need more information because the text is only a claim, and 8 that should be closed because the text is documentary. All 8 closes are reachable under the standard.

To check that nothing changed after the third freeze: `git diff 0886c4571da03fa2404f6c57d682dbc99bfd3afa -- eval/cases/heldout.json` (empty means unchanged).

Results are reported in both directions: **risks caught** (recall on the 18 risk cases) and **clears correctly made** (the share of the 8 clear cases that are closed; the rest is the over-escalation rate), with the escalate-all baseline on the same set, which catches every risk and makes no clear.

The cases are not loaded into Zetaris or the bank database until the main exam variants have finished. Rows for them are built from their own seed and id marker (`CUST-H0001`, `ALR-H0001`, ...), so the main synthetic rows do not change when they are added.
