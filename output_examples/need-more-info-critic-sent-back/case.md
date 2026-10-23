# No date of birth on file

> Synthetic customers, payments and owners; the listed parties are public sanctions-list entries. The desk recommends; a person decides.

The match can be neither confirmed nor ruled out; the data-quality rule fails. Exam case EX-030 (md_no_dob_0); expected outcome: need more info.

## Recommendation

**Need more information** · confidence 95%

The customer's name matches the listed party exactly, but the customer's date of birth is missing while the listed party has a day-precision date of birth (1965-11-23). Nationality matches (TN). Because a key field (DOB) is missing for an individual, the alert cannot be closed as a false positive and requires additional information.

**What would change this**
- Customer date of birth provided and matching 1965-11-23 would make true_match true, leading to ESCALATE_L2 or RECOMMEND_BLOCK.
- Customer date of birth provided and conflicting with 1965-11-23 (beyond day precision) would make false_positive true if nationality also differed, allowing CLOSE_FALSE_POSITIVE.
- A matching document number (e.g., passport) would satisfy true_match even with missing DOB, leading to ESCALATE_L2 or RECOMMEND_BLOCK.

## Path

Code's first finding from the structured fields was **Need more information**, and the structured evidence settles the case, so the agents confirmed and explained it.

## How the desk got there

1. **triage** (plan): path: customer review; the critic may send the recommendation back up to 3 times
2. **evidence** (read semantic layer): screening_usl v4efa3ddddfbe: 14 tables
3. **evidence** (find alert): 1 rows
4. **evidence** (find customer): 1 rows
5. **evidence** (find customer identifier): 0 rows
6. **evidence** (find list entry): 1 rows
7. **evidence** (find list alias): 1 rows
8. **evidence** (find list dob): 1 rows
9. **evidence** (find list country): 4 rows
10. **evidence** (find list identifier): 1 rows
11. **evidence** (find business definition): 6 rows
12. **evidence** (definitions): counterparty_match@1, effective_ownership_threshold@1, false_positive@2, strong_identifier@1, true_match@1
13. **evidence** (identifier overlap): no identifier matches
14. **evidence** (data quality): record fails this rule
15. **evidence** (data quality): record passes this rule
16. **policy guard** (screen inbound): no instruction-like text
17. **screener** (screen text): no customer note, payment reference or list remark to read
18. **matching** (compare party): possible: name 1.00 (exact) vs primary "Tarek Ben Habib Ben Al-Toumi MAAROUFI"; date of birth: missing_customer; country: match
19. **triage** (difficulty): contested (possible; date of birth missing_customer; country match)
20. **memory** (recall): no earlier decision about this pair
21. **triage** (path): confirm: the structured evidence settles it (the record fails a data-quality rule, so the data cannot be relied on yet)
22. **triage** (route): earlier clearance still valid: fast path, no reasoning
23. **decision** (cloud payload): sent 17 fields, 5378 characters, hash b330662ac9324e86; free text withheld
24. **decision** (recommend): NEED_MORE_INFO: The customer's date of birth is missing, preventing verification of the true_match definition which requires DOB agreement to the day. Nationality matches (TN), so false_positive cannot apply. With a
25. **critic** (verify facts): 5 verified, 1 issues
26. **critic** (cloud payload): sent 17 fields, 6040 characters, hash 9cb63654739304ee; free text withheld
27. **critic** (judge): rejected: cited fact does not hold: unknown table "data_quality". Cite only rows of these tables: account (key account_id), alert (key alert_id), beneficial_owner (key ownership_id), business_definition (key definition_key), customer (key customer_id), customer_alias (key alias_id), customer_identifier (key i
28. **critic** (send back): cited fact does not hold: unknown table "data_quality". Cite only rows of these tables: account (key account_id), alert (key alert_id), beneficial_owner (key ownership_id), business_definition (key definition_key), customer (key customer_id), customer_alias (key alias_id), customer_identifier (key i
29. **decision** (cloud payload): sent 17 fields, 6093 characters, hash 34dd86cf979d917d; free text withheld
30. **decision** (recommend): NEED_MORE_INFO: The customer's name matches the listed party exactly, but the customer's date of birth is missing while the listed party has a day-precision date of birth (1965-11-23). Nationality matches (TN). Becau
31. **critic** (verify facts): 5 verified, 0 issues
32. **critic** (cloud payload): sent 17 fields, 5424 characters, hash 4e514efa00098663; free text withheld
33. **critic** (judge): approved
34. **policy guard** (apply policy): NEED_MORE_INFO stands
35. **reporter** (seal record): record rec-eval-sys2b-routed-EX-030 sealed

## What people did

Status: waiting for a person to decide.

No person has acted on this recommendation yet.

## Checks

| Check              | Result   | Detail                                                                                                     |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------------------- |
| definition version | pass     | counterparty_match@1, effective_ownership_threshold@1, false_positive@2, strong_identifier@1, true_match@1 |
| data quality       | block    | customer record fails dob_present_for_individuals                                                          |
| strong match       | pass     | comparison rates the match as possible                                                                     |
| identifier match   | pass     | no identifier match                                                                                        |
| missing data       | pass     | date of birth: missing_customer                                                                            |
| possible match     | pass     | no unresolved possible match                                                                               |
| confidence floor   | pass     | confidence 0.95                                                                                            |
| evidence standard  | pass     | not closing                                                                                                |
| screener           | pass     | no free text to read                                                                                       |
| true match met     | pass     | true match definition not met                                                                              |
| ownership          | pass     | not an ownership alert                                                                                     |
| jurisdiction       | pass     | no watched jurisdiction                                                                                    |
| injection          | pass     | no instruction-like text in the data                                                                       |
| human in the loop  | pass     | recommendation only; a person decides and nothing is sent or blocked automatically                         |
| critic             | approved | 2 rounds                                                                                                   |

## The decision trace

- **Which approved definition applied:** counterparty match v1, effective ownership threshold v1, false positive v2, strong identifier v1, true match v1
- **What data it rests on:** semantic layer 4efa3ddddfbe; 23 read-only queries; list snapshots OFAC ofac-sdn-2026-10-21-0d805bf5
- **Who could see what:** policy version 6; role_evidence_agent ran 23 queries (own token; masked: id_number)
- **What it cost to produce:** 5 model calls (1 local, 4 cloud), 14901 tokens in and 1382 out, 23 data queries; 0.0093 USD under the configured unit costs

## Which model answered each step

| Step         | Asked for       | Answered by                                  | Lane  | App                      | Reasoning         | Receipt                          |
| ------------ | --------------- | -------------------------------------------- | ----- | ------------------------ | ----------------- | -------------------------------- |
| policy guard | meterless/fast  | local-runtime/nemotron-3.5-lightning-30b-a3b | local | sanctions-desk-guard     | none              | valid pinned (rcpt_req_dj3ngoux) |
| decision     | meterless/deep  | nvidia/nemotron-3-ultra-550b-a55b            | cloud | sanctions-desk-reasoning | none              | valid pinned (rcpt_req_moixn9ni) |
| critic       | meterless/judge | nvidia/nemotron-3-ultra-550b-a55b            | cloud | sanctions-desk-reasoning | budget 400 tokens | valid pinned (rcpt_req_jmkg0inp) |
| decision     | meterless/deep  | nvidia/nemotron-3-ultra-550b-a55b            | cloud | sanctions-desk-reasoning | none              | valid pinned (rcpt_req_x1rvfs7p) |
| critic       | meterless/judge | nvidia/nemotron-3-ultra-550b-a55b            | cloud | sanctions-desk-reasoning | budget 400 tokens | valid pinned (rcpt_req_2m50jiv2) |

## The record

Sealed 2026-10-23T20:49:34.835Z with hash `d3c4627bc7420fe204aa4ac499bd9b0a00f4a9962c63b30eb27257e6fbe900fa` (verified: the hash matches the contents). Data and policy as of 2026-10-23T20:49:34.835Z.
- [Decision record](decision-record.json)
- [Decision trace](decision-trace.json)
- [Run events](run-events.jsonl)
