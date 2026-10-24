# Exam case files

- `exam.json`: the 70 cases used for the main exam.
- `heldout.json`: 30 "beyond the rules" cases (18 that carry risk, 4 that need more information, 8 that should be cleared). The deciding evidence is in free text (a payment reference, a customer note, a listed party's remarks), in an alias or transliteration pattern the name rules were not written for, or in documents that disagree.

## Main exam: label changes

| Date | Case | Change | Reason |
| --- | --- | --- | --- |
| 24 Oct 2026 | EX-043 (`ob_chain_42`, "Chain of 70 and 60 percent") | Relabelled from CLOSE_FALSE_POSITIVE (ESCALATE_L2 acceptable) to ESCALATE_L2, with a close now a miss | The label applied effective ownership (70% of 60% is 42%, below 50%). OFAC's 50 percent rule is a cascade: the holding company is 60% owned by the listed party, so it is blocked, and its 70% of the customer counts in full. The ownership engine now counts the rule that way. |

Recorded results are not rescored: each result file keeps the label it was scored against (the report reads `expected` from the result first). Under the new label, the first routed run (`2026-10-23T04-52-42-248Z`), the single-recommendation runs and the deterministic rules baseline closed EX-043; the headline routed run (`2026-10-23T13-33-11-122Z`) and the changed-system run escalated it. The change is in its own commit; `git log -- eval/cases/exam.json` shows it. sha256 of `eval/cases/exam.json` after the change: `08bb4637724bb6094dc747cd0fb8f1cac4e7ba997d5b1f234dfd0ece5c75113d`.

## Held-out set: freeze points

The case definitions and expected labels in `heldout.json` were written and committed before any run on them. The system was not tuned on them. The set was frozen in three steps, all before any run, and each step is dated by its commit.

| Freeze | Commit | Cases | What changed and why |
| --- | --- | --- | --- |
| 1 | `3d02960e76d253e44fc089e3c465b6a2e34a7006` | HO-001 to HO-018 | 18 cases where free text, an unusual alias pattern or disagreeing documents point to a real risk. Every label is cautious. |
| 2 | `7aca3a0131190d9358c2444d7de2602a795b3ec0` | HO-019 to HO-026 | 8 cases added where specific free text clears a match that looks strong (label: close; escalating is a miss). Added because a set of only cautious labels cannot tell a careful system from one that escalates everything. |
| 3 | `d65f5cc99f8ea270bd1c1b4ddc6baf4836da2238` | HO-023 to HO-026 relabelled; HO-027 to HO-030 added | Policy version 2 made the documentary evidence standard explicit (a check reference, a document number and a date; a named counterparty for payments). HO-023 to HO-026 were relabelled to NEED_MORE_INFO (ESCALATE_L2 acceptable, a close is a miss) because the labels were written before the evidence standard was made explicit; under policy v2 these notes are claims. Four new clear cases, HO-027 to HO-030, carry notes or payment references that meet the standard and are labelled as closes. |

HO-001 to HO-022 are byte-identical across all three freezes; a test checks them against recorded hashes. The rows of HO-023 to HO-026 are unchanged; only their labels and notes changed. After freeze 3 the set has 30 cases: 18 that carry risk, 4 that need more information because the text is only a claim, and 8 that should be closed because the text is documentary. All 8 closes are reachable under the standard.

To check that nothing changed after the third freeze: `git diff d65f5cc99f8ea270bd1c1b4ddc6baf4836da2238 -- eval/cases/heldout.json` (empty means unchanged).

Results are reported in both directions: **risks caught** (recall on the 18 risk cases) and **clears correctly made** (the share of the 8 clear cases that are closed; the rest is the over-escalation rate), with the escalate-all baseline on the same set, which catches every risk and makes no clear.

The cases are not loaded into Zetaris or the bank database until the main exam variants have finished. Rows for them are built from their own seed and id marker (`CUST-H0001`, `ALR-H0001`, ...), so the main synthetic rows do not change when they are added.

## Held-out v2

- `heldout2.json`: 19 cases, HO2-001 to HO2-019, group `beyond_rules_v2`. Date: 23 October 2026.
- sha256 of `eval/cases/heldout2.json`: `5b338bd72e54f1f2a00b3b6b25b9dd76f0afdf7eca25c3fea40748d02466f9a8`

This set was written by a separate AI agent session that saw no results, traces or fixes, and no review code except the evidence-standard rule its labels apply; labels fixed before the run. The session (the "separate author" in the change list below) was given its instructions by the build session, which named the families to test and said that v1 had shown risk stated only in free text being missed; it worked from the v1 case files and the written definitions, after the v1 results were known and before any run of the changed system; no system output for v2 existed when it was frozen. It will not be changed after this hash is recorded; `packages/agents/test/heldout2-standard.test.ts` pins the hash and fails if the file changes; it also pins a hash of the rows the cases point at (`a2a0eba3d0edc67adf832b181cc5fcefc235ec448d6e42545868ccad562138ad`, the notes, references and fields the labels were written against). Labels apply the approved definitions and the documentary evidence standard exactly as written (policy version 5, `false_positive@2`, `counterparty_match@1`); each case has a one-sentence reason in `note`. Customers and payments are synthetic; the listed side is real public entries from the committed list sample, none of which the first held-out set used.

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

**Final freeze:** commit `8f6976c`, the commit the first v2 run (changed system, 24 Oct 2026 02:07 SGT) started from; the run result records the same commit. Nothing in `heldout2.json` or the rows it points at changed after it.

The rows are built from their own seed and id marker (`CUST-J0001`, `ALR-J0001`, ...) after the first set's rows. `npm run data:synthetic -- --include-heldout2` writes them into `data/synthetic/` after the first set's rows, and `npm run heldout2:load` loads them into the bank database (dry run unless `--apply` is given). Without the flag every existing output is unchanged; a test checks the main and first-set outputs byte for byte against the committed files.

## Held-out v3

- `heldout3.json`: 12 cases, HO3-001 to HO3-012, group `beyond_rules_v3`. Date: 24 October 2026.
- sha256 of `eval/cases/heldout3.json`: `62ef25460bdc91e8ee7971d5f267e2f727ff8d0c860a24622b2c5df634b954a9`
- sha256 of the rows the cases point at (customers, identifiers, accounts, payments and alerts with the marker `K`, the notes, references and fields the labels were written against): `52e554497273286eb1da488729bb52d129a4a7f34c16cac20d9f0ca53425f594`

This set was written by a separate AI agent session that saw no results, traces or fixes, and no review code except the evidence-standard rule its labels apply; labels fixed before the run (the session worked from the written definitions only: the approved business definitions, the evidence standard section of the policy and its rule, and the case and data builders; its instructions came from the build session and named the families to test), before the fix it will test was written, and without reading any result or trace. No system output for v3 existed when it was frozen. It will not be changed after these hashes are recorded; `packages/agents/test/heldout3-standard.test.ts` pins both hashes and fails if the case file or the rows change. Labels apply the approved definitions and the documentary evidence standard exactly as written (`false_positive@2`, `counterparty_match@1`, `effective_ownership_threshold@1`); each case has a one-sentence reason in `note`. Customers and payments are synthetic; the listed side is real public entries from the committed list sample, none of which the first or second held-out set used.

The set has six risks and six clears:

| Family | Cases | Expected | Why it is there |
| --- | --- | --- | --- |
| Relationship to a listed party stated in free text, where plain rules would close | HO3-001 (the listed person is the customer's father and funds the account), HO3-003 (shares held as nominee for the listed person), HO3-005 (an Italian note: the customer is the listed person's business partner) | ESCALATE_L2 only; a close is a miss | The structured fields alone meet the false-positive definition (birth date present and conflicting to the day, nationality differs, no document matches), so only the text shows the risk. |
| Relationship to a listed party stated in free text | HO3-002 (a Portuguese note: the customer is the executive director of a listed company), HO3-004 (a payment reference: the counterparty is a company owned by the listed person, no percentage given) | ESCALATE_L2 only; a close is a miss | No structured field links the customer or the counterparty to the listed party. |
| Relationship stated in free text, resting on a press report | HO3-006 (a Dutch note: the customer is trustee of a foundation whose sole beneficiary, according to a press report, is the listed person) | ESCALATE_L2 (NEED_MORE_INFO acceptable); a close is a miss | The link is a claim, not a document, so asking for more is an honest answer beside escalation. |
| Clears whose text names the listed person in a name check | HO3-007 (a customer note), HO3-012 (a payment reference) | CLOSE_FALSE_POSITIVE; nothing else is acceptable | The listed person is named only as the subject of a check ("name check against the listed person: different date of birth, different passport"), which is not a relationship. |
| Clears with harmless words next to a name | HO3-008 ("father's name" printed on a passport), HO3-009 ("director of studies" at a school), HO3-010 ("nominee for the award"), HO3-011 ("the sister company of our Dublin branch office") | CLOSE_FALSE_POSITIVE; nothing else is acceptable | Words that sound like a relationship (father, director, nominee, sister company) must not count as one. |

Every clear is reachable under the written policy, and every clear's text is in English and meets the documentary standard (a check reference, a document number and a date; for a payment, a named counterparty). The four customer clears have no failing data-quality rule other than the missing birth date, which the note answers with a labelled birth date that conflicts with the only listed date; the nationality differs and no document matches. The two payment clears have a named counterparty and a usable counterparty country that is not linked to the listed party, so the counterparty match definition is not met. No risk text meets the documentary standard. A test checks all of this.

The rows are built from their own seed and id marker (`CUST-K0001`, `ALR-K0001`, ...) after the second set's rows. `npm run data:synthetic -- --include-heldout3` writes them into `data/synthetic/` after both earlier sets' rows, and `npm run heldout3:load` loads them into the bank database (dry run unless `--apply` is given). Without the flag every existing output is unchanged; a test checks the existing outputs byte for byte.

**Final freeze:** recorded at the first v3 run.

## Held-out v4

- `heldout4.json`: 12 cases, HO4-001 to HO4-012, group `beyond_rules_v4`. Date: 24 October 2026.
- sha256 of `eval/cases/heldout4.json`: `de43651d416be5afb432498e114852fe113c0532146cc7d926ca212efd7753ed`
- sha256 of the rows the cases point at (customers, identifiers, accounts, payments and alerts with the marker `L`, the notes, references and fields the labels were written against): `1744fe66c69a6618ead4c482b93d142ffac568bd3568d34f5ae35726f07a2571`

This set was written by a separate AI agent session that saw no results, traces or fixes, and no review code except the evidence-standard rule its labels apply; labels fixed before the run (the session worked from the written definitions only: the approved business definitions, the evidence standard section of the policy and its rule, the registered data-quality rules and the case and data builders; its instructions came from the build session and named the families to test), without reading any result, trace or decision record, and without reading the fix it will test. No system output for v4 existed when it was frozen. It will not be changed after these hashes are recorded; `packages/agents/test/heldout4-standard.test.ts` pins both hashes and fails if the case file or the rows change. Labels apply the approved definitions and the documentary evidence standard exactly as written (`false_positive@2`, `counterparty_match@1`, `effective_ownership_threshold@1`); each case has a one-sentence reason in `note`. Customers and payments are synthetic; the listed side is real public entries from the committed list sample, none of which the main exam or an earlier held-out set used.

The set has six risks and six clears:

| Family | Cases | Expected | Why it is there |
| --- | --- | --- | --- |
| Relationship to a listed party stated in free text, where plain rules would close | HO4-001 (the account is run for the customer's uncle, the listed person), HO4-002 (a German note: the customer holds company shares as nominee for the listed person), HO4-003 (the customer's former name is exactly the listed name) | ESCALATE_L2 only; a close is a miss | The structured fields alone meet the false-positive definition (birth date present and conflicting to the day, nationality differs, no document matches), so only the text shows the risk. |
| Relationship to a listed party stated in free text | HO4-004 (the customer has been a director, since 2019, of a listed company), HO4-005 (a French payment reference: the counterparty is controlled by the listed person through a holding company, no percentage given), HO4-006 (the listed person is the sole signatory on a company customer's account under a power of attorney) | ESCALATE_L2 only; a close is a miss | No structured field links the customer or the counterparty to the listed party. |
| Relation word a few words away from the listed name | HO4-001 ("run for her uncle, <name>, who lives abroad"), HO4-002, HO4-004 ("director (since 2019) of <company>"), HO4-005, HO4-006 | as above | The relationship is stated plainly, but not in one short phrase. |
| Clears with harmless words next to a name | HO4-007 ("father's name as printed on the passport"), HO4-008 ("director of studies"), HO4-009 ("nominee for an award"), HO4-010 ("our sister branch"), HO4-012 ("a company owned by the customer himself") | CLOSE_FALSE_POSITIVE; nothing else is acceptable | Words that sound like a relationship (father, director, nominee, sister, owned by) must not count as one. |
| Clear whose note names the listed person only as checked and not matching | HO4-011 | CLOSE_FALSE_POSITIVE; nothing else is acceptable | Naming a listed person in a recorded name check is not a relationship. |

Every clear is a customer alert, reachable under the written policy, and its note is in English and meets the documentary standard (a check reference, a document number and a date). No clear has a failing data-quality rule other than the missing birth date, which the note answers with a labelled birth date that conflicts with every listed date; the nationality is not a listed nationality and no document matches. The document number in each clear's note is also one of that customer's identifier rows (`customer_identifier`, same number), so the document is on the customer record. No risk text meets the documentary standard. A test checks all of this.

The rows are built from their own seed and id marker (`CUST-L0001`, `ALR-L0001`, ...) after the third set's rows, for the default seed only, like the third set. `npm run data:synthetic -- --include-heldout4` writes them into `data/synthetic/` after all three earlier sets' rows, and `npm run heldout4:load` loads them into the bank database (dry run unless `--apply` is given). Without the flag every existing output is unchanged; a test checks the existing outputs byte for byte.

**Final freeze:** commit `fc6453713a62ee9f7b029d7525715690ae8a0cd9` (24 Oct 2026 10:40:56 SGT), the one that adds this section and `heldout4.json` (its message starts "Freeze held-out v4"). Any later change to a case gets its own commit, a new hash and its reason in this section. To check that nothing changed after it: `git diff fc6453713a62ee9f7b029d7525715690ae8a0cd9 -- eval/cases/heldout4.json packages/data/src/synthetic/heldout4.ts` (empty means unchanged).
