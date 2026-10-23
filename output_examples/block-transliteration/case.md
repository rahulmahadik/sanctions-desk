# Same person, name written in arabic script

> Synthetic customers, payments and owners; the listed parties are public sanctions-list entries. The desk recommends; a person decides.

Exact non-Latin alias with a matching birth date and nationality. Exam case EX-025 (tl_arabic_same); expected outcome: escalate l2.

## Recommendation

**Recommend a block (needs two approvals)** · confidence 98%

The customer and listed party have an exact name match (score 1.000), the date of birth agrees to the day (1968-05-29), and the customer's nationality (LB) matches a listed nationality (LB). These three conditions satisfy the true_match definition, and no identifiers conflict.

**What would change this**
- A different date of birth for the listed party that conflicts with the customer's DOB beyond the listed precision
- A different nationality for the customer that is not a nationality or citizenship of the listed party
- A matching document number that contradicts the match

## Path

Code's first finding from the structured fields was **Escalate to level 2**, and the structured evidence settles the case, so the agents confirmed and explained it.

## How the desk got there

1. **triage** (plan): path: customer review; the critic may send the recommendation back up to 3 times
2. **evidence** (read semantic layer): screening_usl v4efa3ddddfbe: 14 tables
3. **evidence** (find alert): 1 rows
4. **evidence** (find customer): 1 rows
5. **evidence** (find customer identifier): 0 rows
6. **evidence** (find list entry): 1 rows
7. **evidence** (find list alias): 5 rows
8. **evidence** (find list dob): 1 rows
9. **evidence** (find list country): 4 rows
10. **evidence** (find list identifier): 2 rows
11. **evidence** (find business definition): 6 rows
12. **evidence** (definitions): counterparty_match@1, effective_ownership_threshold@1, false_positive@2, strong_identifier@1, true_match@1
13. **evidence** (identifier overlap): no identifier matches
14. **evidence** (data quality): record passes this rule
15. **evidence** (data quality): record passes this rule
16. **policy guard** (screen inbound): no instruction-like text
17. **screener** (screen text): no customer note, payment reference or list remark to read
18. **matching** (compare party): strong: name 1.00 (exact) vs aka "رامي كامل يعقوب باقر"; date of birth: exact; country: match
19. **triage** (difficulty): clear (strong; date of birth exact; country match)
20. **memory** (recall): no earlier decision about this pair
21. **triage** (path): confirm: the structured evidence settles it (an approved match definition is met, or a document number agrees with the listed party)
22. **triage** (route): earlier clearance still valid: fast path, no reasoning
23. **decision** (cloud payload): sent 17 fields, 5700 characters, hash c977ec20618afc03; free text withheld
24. **decision** (recommend): RECOMMEND_BLOCK: The customer and listed party have an exact name match (score 1.000), the date of birth agrees to the day (1968-05-29), and the customer's nationality (LB) matches a listed nationality (LB). These thr
25. **critic** (verify facts): 6 verified, 0 issues
26. **critic** (cloud payload): sent 17 fields, 5690 characters, hash e41cb16c69d960b1; free text withheld
27. **critic** (judge): approved
28. **policy guard** (apply policy): RECOMMEND_BLOCK stands
29. **reporter** (seal record): record rec-eval-sys2b-routed-EX-025 sealed

## What people did

Status: waiting for a person to decide.

No person has acted on this recommendation yet.

## Checks

| Check              | Result   | Detail                                                                                                     |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------------------- |
| definition version | pass     | counterparty_match@1, effective_ownership_threshold@1, false_positive@2, strong_identifier@1, true_match@1 |
| data quality       | pass     | no failing data-quality rule on the customer record                                                        |
| strong match       | pass     | comparison rates the match as strong                                                                       |
| identifier match   | pass     | no identifier match                                                                                        |
| missing data       | pass     | date of birth: exact                                                                                       |
| possible match     | pass     | no unresolved possible match                                                                               |
| confidence floor   | pass     | confidence 0.98                                                                                            |
| evidence standard  | pass     | not closing                                                                                                |
| screener           | pass     | no free text to read                                                                                       |
| true match met     | pass     | true match: escalated                                                                                      |
| ownership          | pass     | not an ownership alert                                                                                     |
| jurisdiction       | pass     | no watched jurisdiction                                                                                    |
| injection          | pass     | no instruction-like text in the data                                                                       |
| human in the loop  | pass     | recommendation only; a person decides and nothing is sent or blocked automatically                         |
| critic             | approved | 1 round                                                                                                    |

## The decision trace

- **Which approved definition applied:** counterparty match v1, effective ownership threshold v1, false positive v2, strong identifier v1, true match v1
- **What data it rests on:** semantic layer 4efa3ddddfbe; 19 read-only queries; list snapshots OFAC ofac-sdn-2026-10-21-0d805bf5
- **Who could see what:** policy version 6; role_evidence_agent ran 19 queries (own token; masked: id_number)
- **What it cost to produce:** 3 model calls (1 local, 2 cloud), 8224 tokens in and 653 out, 19 data queries; 0.0048 USD under the configured unit costs

## Which model answered each step

| Step         | Asked for       | Answered by                                  | Lane  | App                      | Reasoning         | Receipt                          |
| ------------ | --------------- | -------------------------------------------- | ----- | ------------------------ | ----------------- | -------------------------------- |
| policy guard | meterless/fast  | local-runtime/nemotron-3.5-lightning-30b-a3b | local | sanctions-desk-guard     | none              | valid pinned (rcpt_req_p9w3445p) |
| decision     | meterless/deep  | nvidia/nemotron-3-ultra-550b-a55b            | cloud | sanctions-desk-reasoning | none              | valid pinned (rcpt_req_d95xhk4m) |
| critic       | meterless/judge | nvidia/nemotron-3-ultra-550b-a55b            | cloud | sanctions-desk-reasoning | budget 400 tokens | valid pinned (rcpt_req_ak8kfoxu) |

## The record

Sealed 2026-10-23T20:39:42.461Z with hash `6b73f177ac0cb4b6e816d6a55c2c1292321a5f675243d6c746a9e06d779c9937` (verified: the hash matches the contents). Data and policy as of 2026-10-23T20:39:42.461Z.
- [Decision record](decision-record.json)
- [Decision trace](decision-trace.json)
- [Run events](run-events.jsonl)
