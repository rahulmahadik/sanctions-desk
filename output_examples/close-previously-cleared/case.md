# Cleared before; the listed entry has not changed

> Synthetic customers, payments and owners; the listed parties are public sanctions-list entries. The desk recommends; a person decides.

An earlier clearance still holds: the entry's content hash is the same. Exam case EX-045 (pcu_0); expected outcome: close false positive.

## Recommendation

**Close as a false positive** · confidence 95%

The customer and listed party share an exact name match (score 1.000), but the customer's date of birth (1977-06-25) conflicts with the listed date of birth (1958-11-11) at day precision, the customer's nationality (SG) differs from the listed nationality (HK), and no document numbers match. These conditions satisfy the false_positive definition. An earlier review reached the same conclusion and the listed entry has not changed since.

**What would change this**
- If the customer's date of birth matched the listed date of birth (1958-11-11)
- If the customer's nationality was HK (matching the listed nationality)
- If a document number (passport or national ID) matched between customer and listed party

## Path

Code's first finding from the structured fields was **Close as a false positive**, and the structured evidence settles the case, so the agents confirmed and explained it.

## How the desk got there

1. **triage** (plan): path: customer review; the critic may send the recommendation back up to 3 times
2. **evidence** (read semantic layer): screening_usl v4efa3ddddfbe: 14 tables
3. **evidence** (find alert): 1 rows
4. **evidence** (find customer): 1 rows
5. **evidence** (find customer identifier): 0 rows
6. **evidence** (find list entry): 1 rows
7. **evidence** (find list alias): 3 rows
8. **evidence** (find list dob): 1 rows
9. **evidence** (find list country): 3 rows
10. **evidence** (find list identifier): 2 rows
11. **evidence** (find business definition): 6 rows
12. **evidence** (definitions): counterparty_match@1, effective_ownership_threshold@1, false_positive@2, strong_identifier@1, true_match@1
13. **evidence** (identifier overlap): no identifier matches
14. **evidence** (data quality): record passes this rule
15. **evidence** (data quality): record passes this rule
16. **policy guard** (screen inbound): no instruction-like text
17. **screener** (screen text): no customer note, payment reference or list remark to read
18. **matching** (compare party): weak: name 1.00 (exact) vs primary "Teresa CHENG"; date of birth: conflict; country: conflict
19. **triage** (difficulty): clear (weak; date of birth conflict; country conflict)
20. **memory** (recall): 1 earlier decision(s): CLOSE_FALSE_POSITIVE (fresh)
21. **triage** (path): confirm: the structured evidence settles it (the approved definition of a false positive is met and no identifier matches)
22. **triage** (route): earlier clearance still valid: fast path, no reasoning
23. **decision** (cloud payload): sent 17 fields, 5654 characters, hash b7b5bcd8e5a711a6; free text withheld
24. **decision** (recommend): CLOSE_FALSE_POSITIVE: The customer and listed party share an exact name match (score 1.000), but the customer's date of birth (1977-06-25) conflicts with the listed date of birth (1958-11-11) at day precision, the customer
25. **critic** (verify facts): 6 verified, 0 issues
26. **critic** (cloud payload): sent 17 fields, 5810 characters, hash 8aad8b5f59dbe612; free text withheld
27. **critic** (judge): approved
28. **challenger** (challenge start): challenging a close: the name similarity 1 is at least 0.95
29. **challenger** (cloud payload): sent 16 fields, 5532 characters, hash c6da713eb3eb35ea; free text withheld
30. **challenger** (challenge result): no credible argument: The exact name match is outweighed by a definitive day-precision DOB conflict (1977 vs 1958), a nationality mismatch (SG vs HK), and zero identifier overlap. No data-quality issues or aliases bridge these gaps.
31. **policy guard** (apply policy): CLOSE_FALSE_POSITIVE stands
32. **reporter** (seal record): record rec-eval-sys2b-routed-EX-045 sealed

## What people did

Status: waiting for a person to decide.

No person has acted on this recommendation yet.

## Checks

| Check              | Result   | Detail                                                                                                     |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------------------- |
| definition version | pass     | counterparty_match@1, effective_ownership_threshold@1, false_positive@2, strong_identifier@1, true_match@1 |
| data quality       | pass     | no failing data-quality rule on the customer record                                                        |
| strong match       | pass     | comparison rates the match as weak                                                                         |
| identifier match   | pass     | no identifier match                                                                                        |
| missing data       | pass     | date of birth: conflict                                                                                    |
| possible match     | pass     | no unresolved possible match                                                                               |
| confidence floor   | pass     | confidence 0.95                                                                                            |
| evidence standard  | pass     | no free text relied on                                                                                     |
| screener           | pass     | no free text to read                                                                                       |
| true match met     | pass     | true match definition not met                                                                              |
| ownership          | pass     | not an ownership alert                                                                                     |
| jurisdiction       | pass     | no watched jurisdiction                                                                                    |
| injection          | pass     | no instruction-like text in the data                                                                       |
| human in the loop  | pass     | recommendation only; a person decides and nothing is sent or blocked automatically                         |
| challenger         | pass     | ran (the name similarity 1 is at least 0.95); no credible true-match argument                              |
| critic             | approved | 1 round                                                                                                    |

## The decision trace

- **Which approved definition applied:** counterparty match v1, effective ownership threshold v1, false positive v2, strong identifier v1, true match v1
- **What data it rests on:** semantic layer 4efa3ddddfbe; 19 read-only queries; list snapshots OFAC ofac-consolidated-2026-10-19-dc3f61dc
- **Who could see what:** policy version 6; role_evidence_agent ran 19 queries (own token; masked: id_number)
- **What it cost to produce:** 4 model calls (1 local, 3 cloud), 11565 tokens in and 1048 out, 19 data queries; 0.0071 USD under the configured unit costs

## Which model answered each step

| Step         | Asked for       | Answered by                                  | Lane  | App                      | Reasoning         | Receipt                          |
| ------------ | --------------- | -------------------------------------------- | ----- | ------------------------ | ----------------- | -------------------------------- |
| policy guard | meterless/fast  | local-runtime/nemotron-3.5-lightning-30b-a3b | local | sanctions-desk-guard     | none              | valid pinned (rcpt_req_71ofeb3x) |
| decision     | meterless/deep  | nvidia/nemotron-3-ultra-550b-a55b            | cloud | sanctions-desk-reasoning | none              | valid pinned (rcpt_req_vi3jro4l) |
| critic       | meterless/judge | nvidia/nemotron-3-ultra-550b-a55b            | cloud | sanctions-desk-reasoning | budget 400 tokens | valid pinned (rcpt_req_8n89tl5g) |
| challenger   | meterless/deep  | nvidia/nemotron-3-ultra-550b-a55b            | cloud | sanctions-desk-reasoning | budget 500 tokens | valid pinned (rcpt_req_lmkl5mif) |

## The record

Sealed 2026-10-23T21:09:06.379Z with hash `4aada95e0935993ce700a511459967166a1906ac5fe732f76257505ebf81e297` (verified: the hash matches the contents). Data and policy as of 2026-10-23T21:09:06.379Z.
- [Decision record](decision-record.json)
- [Decision trace](decision-trace.json)
- [Run events](run-events.jsonl)
