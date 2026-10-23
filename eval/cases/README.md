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

## Held-out v2

- `heldout2.json`: 19 cases, HO2-001 to HO2-019, group `beyond_rules_v2`. Date: 23 October 2026.
- sha256 of `eval/cases/heldout2.json`: `5b338bd72e54f1f2a00b3b6b25b9dd76f0afdf7eca25c3fea40748d02466f9a8`

This set was written by a separate author from the v1 case files and the written definitions, after the v1 results were known and before any run of the changed system; no system output for v2 existed when it was frozen. It will not be changed after this hash is recorded; `packages/agents/test/heldout2-standard.test.ts` pins the hash and fails if the file changes; it also pins a hash of the rows the cases point at (`a2a0eba3d0edc67adf832b181cc5fcefc235ec448d6e42545868ccad562138ad`, the notes, references and fields the labels were written against). Labels apply the approved definitions and the documentary evidence standard exactly as written (policy version 5, `false_positive@2`, `counterparty_match@1`); each case has a one-sentence reason in `note`. Customers and payments are synthetic; the listed side is real public entries from the committed list sample, none of which the first held-out set used.

The set has the same three families as the first, with new names, new wording and the text in other places (customer notes, payment references, the listed entry's remarks), some of it in Spanish, German or French:

| Family | Cases | Expected | Why it is there |
| --- | --- | --- | --- |
| Risk stated only in free text | HO2-001 to HO2-007 (a ship's IMO number and an agent's name in payment references, an alias in a Spanish reference, a Spanish maiden name, a German spouse link, a French branch location, a founder named only in the listed remarks) | ESCALATE_L2 (NEED_MORE_INFO acceptable; for HO2-005 and HO2-007 that is the only other acceptable answer); a close is a miss | Tests whether risk that no structured field carries, and that the first set showed was invisible to the decision step, is now seen, in more than one language. |
| Risk where plain rules would close | HO2-016 and HO2-017 (a power of attorney for the listed person in a customer note; the listed remarks naming the customer as the listed person's father) | ESCALATE_L2 (NEED_MORE_INFO acceptable); a close is a miss | The structured fields alone meet the false-positive definition (birth date present and conflicting, nationality differs, no document matches), so only the free text shows the risk. |
| Clears backed by documentary evidence | HO2-008, HO2-011, HO2-012, HO2-018, HO2-019 | CLOSE_FALSE_POSITIVE; an escalation is a miss | No birth date on record, an exact or strong-alias name match, another nationality, no document match, and a note that meets the standard and states a labelled birth date that conflicts with every listed date. HO2-011 carries near-miss wording (a bar named after a weapons maker) that must not raise risk, as does HO2-009 (a street name that resembles a listed group). Keeps the set from rewarding a system that escalates everything. |
| Notes that look documentary but are only claims | HO2-013 to HO2-015 (no check reference; the counterparty recorded as unknown; a year of birth but no date) | NEED_MORE_INFO (ESCALATE_L2 acceptable); a close is a miss | Each fails the standard for exactly one reason, which a test checks, so a close that relies on it breaks the rule. |
| Documentary text, but no usable counterparty country | HO2-009 and HO2-010 | NEED_MORE_INFO (ESCALATE_L2 acceptable); a close is a miss | See the changes below. |

Changes made before the final freeze. **No system output for v2 existed when any of them was made**: no v2 result file and no v2 trace existed (checked when each change was made). The same list, with its triggers, is in `heldout2-changes.json`, which the report reads.

| Cases | Change | Trigger | Reason |
| --- | --- | --- | --- |
| HO2-009, HO2-010 | Relabelled from CLOSE_FALSE_POSITIVE to NEED_MORE_INFO (ESCALATE_L2 acceptable, a close is a miss) | independent review (held-out v2 label check) and policy consistency | The written policy says a counterparty with no usable country cannot be cleared (approved definition counterparty_match@1, and the failing payment rule counterparty_country_valid), so a close would mean ignoring a failing data-quality rule. |
| HO2-016, HO2-017 | Added: risks where the structured fields alone meet the false-positive definition and the risk is only in free text | independent review (the set was thinner than it looked: four of its seven risks reach an acceptable answer from a missing birth date alone) | So the set tests false closes where plain rules would close. |
| HO2-018, HO2-019 | Added: clears the written policy allows (no birth date on record, a documentary note with a labelled birth date that conflicts) | independent review (two of the original clears were not reachable under the written policy) | So the set can measure correct clears. |
| HO2-017 | The listed remarks name the customer by full name only, not with the customer's date of birth as first specified | spec deviation | The remarks are real public list text and cannot carry a synthetic customer's date of birth; no remark in the committed list sample names a person together with a date of birth. The customer's own structured fields still meet the false-positive definition. |
| all | Date corrected to 23 October 2026; the statement about independence reworded | independent review (date and wording) | The set was committed on 23 October 2026, after the v1 results were known; it was written by a separate author from the v1 case files and the written definitions, which is what the wording now says. |
| all | A second pinned hash over the rows the cases point at (notes, references and fields) | author's own check | The case file does not hold the note text, so an edit to a note would not change the case-file hash. |

**Final freeze:** the commit before the first v2 run. Its hash is written here and in `heldout2-changes.json` when that run starts: _not yet recorded_.

The rows are built from their own seed and id marker (`CUST-J0001`, `ALR-J0001`, ...) after the first set's rows. `npm run data:synthetic -- --include-heldout2` writes them into `data/synthetic/` after the first set's rows, and `npm run heldout2:load` loads them into the bank database (dry run unless `--apply` is given). Without the flag every existing output is unchanged; a test checks the main and first-set outputs byte for byte against the committed files.
