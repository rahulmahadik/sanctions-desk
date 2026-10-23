# A Portuguese customer note says the customer is the executive director of a listed company

> Synthetic customers, payments and owners; the listed parties are public sanctions-list entries. The desk recommends; a person decides.

The customer's name has nothing in common with the listed company; the note, in Portuguese, says the customer has been its executive director since 2020 and is paid by it into this account. Exam case HO3-002 (ho3_note_director_portuguese); expected outcome: escalate l2.

## Recommendation

**Escalate to level 2** · confidence 90%

The customer is an individual (Rui Baltazar Teixeira, PT nationality, DOB 1979-03-30) while the listed party is an entity (LLC BALTECH, RU address). Name similarity is 0.607, below the 0.85 threshold. No date of birth or identifiers exist for the listed party. The screener detected risk signals 'relationship_to_listed_party' (confidence 0.9) and 'sanctioned_jurisdiction_link' (confidence 0.5) in free text, both at or above the 0.5 policy threshold, and the note lacks documentary evidence (missing check reference, document number, date). Per policy, free text risk signals at or above the confidence threshold prevent closure and require escalation.

**What would change this**
- If the customer note contained documentary evidence meeting the standard (check reference, document number, date) that resolved the risk signals, the alert could potentially be closed.
- If the screener risk signals were reclassified below the 0.5 confidence threshold, the free text would not block closure.
- If the listed party had a date of birth matching the customer's to the day and a matching nationality, true_match could be met, leading to RECOMMEND_BLOCK.
- If the name similarity score were at or above 0.85 and the party types aligned, the match would be stronger.

## Path

Code's first finding from the structured fields was **Escalate to level 2**, but the structured evidence does not settle the case or there is free text to weigh, so the agents reasoned over all of it.

## How the desk got there

1. **triage** (plan): path: customer review; the critic may send the recommendation back up to 3 times
2. **evidence** (read semantic layer): screening_usl v4efa3ddddfbe: 14 tables
3. **evidence** (find alert): 1 rows
4. **evidence** (find customer): 1 rows
5. **evidence** (find customer identifier): 0 rows
6. **evidence** (find list entry): 1 rows
7. **evidence** (find list alias): 8 rows
8. **evidence** (find list dob): 0 rows
9. **evidence** (find list country): 1 rows
10. **evidence** (find list identifier): 2 rows
11. **evidence** (find business definition): 6 rows
12. **evidence** (definitions): counterparty_match@1, effective_ownership_threshold@1, false_positive@2, strong_identifier@1, true_match@1
13. **evidence** (identifier overlap): no identifier matches
14. **evidence** (data quality): record passes this rule
15. **evidence** (data quality): record passes this rule
16. **policy guard** (screen inbound): no instruction-like text
17. **screener** (screen text): 2 risk signal(s), 0 grounded at or above 0.5, 2 not grounded: relationship_to_listed_party 0.9 at customer.notes:15-30 (not grounded); sanctioned_jurisdiction_link 0.5 at list_entry.remarks:0-86 (not grounded); documentary: customer.notes claim (lacks a check reference, a document number, a date); injection not found
18. **matching** (compare party): weak: name 0.61 (token_set) vs primary "LLC BALTECH"; date of birth: missing_list; country: conflict; party type differs (person vs company)
19. **triage** (difficulty): contested (weak; date of birth missing_list; country conflict)
20. **memory** (recall): no earlier decision about this pair
21. **triage** (path): reason: the structured evidence does not settle it (the match cannot be ruled out with the data available)
22. **decision** (cloud payload): sent 17 fields, 7496 characters, hash 36112a77552230b8; free text withheld
23. **decision** (recommend): ESCALATE_L2: The customer is an individual (Rui Baltazar Teixeira, PT nationality, DOB 1979-03-30) while the listed party is an entity (LLC BALTECH, RU address). Name similarity is 0.607, below the 0.85 threshold.
24. **critic** (verify facts): 6 verified, 0 issues
25. **critic** (cloud payload): sent 17 fields, 6453 characters, hash a9b23e6536567961; free text withheld
26. **critic** (judge): approved
27. **policy guard** (apply policy): ESCALATE_L2 stands
28. **reporter** (seal record): record rec-eval-heldout3-sys3-routed-HO3-002 sealed

## What people did

Status: waiting for a person to decide.

No person has acted on this recommendation yet.

## Checks

| Check              | Result   | Detail                                                                                                                                                                                                                                                                                                                                    |
| ------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| definition version | pass     | counterparty_match@1, effective_ownership_threshold@1, false_positive@2, strong_identifier@1, true_match@1                                                                                                                                                                                                                                |
| data quality       | pass     | no failing data-quality rule on the customer record                                                                                                                                                                                                                                                                                       |
| strong match       | pass     | comparison rates the match as weak                                                                                                                                                                                                                                                                                                        |
| identifier match   | pass     | no identifier match                                                                                                                                                                                                                                                                                                                       |
| missing data       | pass     | date of birth: missing_list                                                                                                                                                                                                                                                                                                               |
| possible match     | pass     | no unresolved possible match                                                                                                                                                                                                                                                                                                              |
| confidence floor   | pass     | confidence 0.9                                                                                                                                                                                                                                                                                                                            |
| evidence standard  | pass     | not closing                                                                                                                                                                                                                                                                                                                               |
| screener grounding | flag     | 2 signal(s) not grounded in the text they point at; recorded, not blocking: relationship to listed party (confidence 0.9, customer.notes:15-30): the span holds no relationship to listed party term of the policy; sanctioned jurisdiction link (confidence 0.5, list_entry.remarks:0-86): the span names no watched place of the policy |
| screener           | pass     | no grounded risk signal in the free text                                                                                                                                                                                                                                                                                                  |
| true match met     | pass     | true match definition not met                                                                                                                                                                                                                                                                                                             |
| ownership          | pass     | not an ownership alert                                                                                                                                                                                                                                                                                                                    |
| jurisdiction       | pass     | no watched jurisdiction                                                                                                                                                                                                                                                                                                                   |
| injection          | pass     | no instruction-like text in the data                                                                                                                                                                                                                                                                                                      |
| human in the loop  | pass     | recommendation only; a person decides and nothing is sent or blocked automatically                                                                                                                                                                                                                                                        |
| critic             | approved | 1 round                                                                                                                                                                                                                                                                                                                                   |

## The decision trace

- **Which approved definition applied:** counterparty match v1, effective ownership threshold v1, false positive v2, strong identifier v1, true match v1
- **What data it rests on:** semantic layer 4efa3ddddfbe; 19 read-only queries; list snapshots OFAC ofac-consolidated-2026-10-19-dc3f61dc
- **Who could see what:** policy version 7; role_evidence_agent ran 19 queries (own token; masked: id_number)
- **What it cost to produce:** 4 model calls (2 local, 2 cloud), 12061 tokens in and 1285 out, 19 data queries; 0.0065 USD under the configured unit costs

## Which model answered each step

| Step         | Asked for       | Answered by                                  | Lane  | App                      | Reasoning         | Receipt                          |
| ------------ | --------------- | -------------------------------------------- | ----- | ------------------------ | ----------------- | -------------------------------- |
| policy guard | meterless/fast  | local-runtime/nemotron-3.5-lightning-30b-a3b | local | sanctions-desk-guard     | none              | valid pinned (rcpt_req_cegga305) |
| screener     | meterless/fast  | local-runtime/nemotron-3.5-lightning-30b-a3b | local | sanctions-desk-guard     | none              | valid pinned (rcpt_req_228ikvby) |
| decision     | meterless/deep  | nvidia/nemotron-3-ultra-550b-a55b            | cloud | sanctions-desk-reasoning | budget 500 tokens | valid pinned (rcpt_req_spjxbug5) |
| critic       | meterless/judge | nvidia/nemotron-3-ultra-550b-a55b            | cloud | sanctions-desk-reasoning | budget 400 tokens | valid pinned (rcpt_req_fmjizxe6) |

## The record

Sealed 2026-10-23T23:22:34.593Z with hash `d19d1859e7a692bb90ee8bcb8084338be7f0ce5101dafece31adb576e6168c34` (verified: the hash matches the contents). Data and policy as of 2026-10-23T23:22:34.593Z.
- [Decision record](decision-record.json)
- [Decision trace](decision-trace.json)
- [Run events](run-events.jsonl)
