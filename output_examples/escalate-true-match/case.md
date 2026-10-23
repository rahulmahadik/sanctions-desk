# Name, birth date and nationality all agree

> Synthetic customers, payments and owners; the listed parties are public sanctions-list entries. The desk recommends; a person decides.

Meets the approved definition of a true match. Exam case EX-016 (tm_exact_0); expected outcome: escalate l2.

## Recommendation

**Escalate to level 2** · confidence 95%

The customer's full name, date of birth (1962-10-23), and nationality (MX) exactly match the listed party's primary name, date of birth (day precision), and nationality. This meets the true_match definition, requiring escalation to Level 2. No document identifiers are present for either party.

**What would change this**
- If a document number matched, it would further confirm the true match but not change the escalation recommendation.
- If the date of birth conflicted (different day) or nationality differed, the true_match definition would not be met, potentially leading to NEED_MORE_INFO or CLOSE_FALSE_POSITIVE depending on other factors.
- If the name similarity score fell below the policy threshold (0.85), the true_match definition would not be met.

## Path

Code's first finding from the structured fields was **Escalate to level 2**, and the structured evidence settles the case, so the agents confirmed and explained it.

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
10. **evidence** (find list identifier): 3 rows
11. **evidence** (find business definition): 6 rows
12. **evidence** (definitions): counterparty_match@1, effective_ownership_threshold@1, false_positive@2, strong_identifier@1, true_match@1
13. **evidence** (identifier overlap): no identifier matches
14. **evidence** (data quality): record passes this rule
15. **evidence** (data quality): record passes this rule
16. **policy guard** (screen inbound): no instruction-like text
17. **screener** (screen text): no customer note, payment reference or list remark to read
18. **matching** (compare party): strong: name 1.00 (exact) vs primary "FLORES APODACA Salome"; date of birth: exact; country: match
19. **triage** (difficulty): clear (strong; date of birth exact; country match)
20. **memory** (recall): no earlier decision about this pair
21. **triage** (path): confirm: the structured evidence settles it (an approved match definition is met, or a document number agrees with the listed party)
22. **triage** (route): earlier clearance still valid: fast path, no reasoning
23. **decision** (cloud payload): sent 17 fields, 5370 characters, hash 10b01f5caf6cd178; free text withheld
24. **decision** (recommend): ESCALATE_L2: The customer's full name, date of birth (1962-10-23), and nationality (MX) exactly match the listed party's primary name, date of birth (day precision), and nationality. This meets the true_match defi
25. **critic** (verify facts): 8 verified, 0 issues
26. **critic** (cloud payload): sent 17 fields, 5373 characters, hash 4675015b5097e9c9; free text withheld
27. **critic** (judge): approved
28. **policy guard** (apply policy): ESCALATE_L2 stands
29. **reporter** (seal record): record rec-eval-sys2b-routed-EX-016 sealed

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
| confidence floor   | pass     | confidence 0.95                                                                                            |
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
- **What data it rests on:** semantic layer 4efa3ddddfbe; 21 read-only queries; list snapshots OFAC ofac-sdn-2026-10-21-0d805bf5
- **Who could see what:** policy version 6; role_evidence_agent ran 21 queries (own token; masked: id_number)
- **What it cost to produce:** 3 model calls (1 local, 2 cloud), 8073 tokens in and 711 out, 21 data queries; 0.0048 USD under the configured unit costs

## Which model answered each step

| Step         | Asked for       | Answered by                                  | Lane  | App                      | Reasoning         | Receipt                          |
| ------------ | --------------- | -------------------------------------------- | ----- | ------------------------ | ----------------- | -------------------------------- |
| policy guard | meterless/fast  | local-runtime/nemotron-3.5-lightning-30b-a3b | local | sanctions-desk-guard     | none              | valid pinned (rcpt_req_mwgw0ayc) |
| decision     | meterless/deep  | nvidia/nemotron-3-ultra-550b-a55b            | cloud | sanctions-desk-reasoning | none              | valid pinned (rcpt_req_n12mmhv1) |
| critic       | meterless/judge | nvidia/nemotron-3-ultra-550b-a55b            | cloud | sanctions-desk-reasoning | budget 400 tokens | valid pinned (rcpt_req_n6aux0ai) |

## The record

Sealed 2026-10-23T20:21:07.340Z with hash `7bbc49499e2477513e2e023c3dcecc162b713f660e4ba1cbde3903844f7bcd24` (verified: the hash matches the contents). Data and policy as of 2026-10-23T20:21:07.340Z.
- [Decision record](decision-record.json)
- [Decision trace](decision-trace.json)
- [Run events](run-events.jsonl)
