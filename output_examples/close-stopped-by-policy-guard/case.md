# Payment reference names a watched place

> Synthetic customers, payments and owners; the listed parties are public sanctions-list entries. The desk recommends; a person decides.

The name alone would not hold the payment; the route touches a watched jurisdiction, so a person decides. Exam case EX-064 (pj_reference_text); expected outcome: escalate l2.

## Recommendation

**Escalate to level 2** · confidence 60% (capped at 60%: jurisdiction)

The counterparty name matches exactly but the counterparty country NL is not among the listed party's address countries (CN, IN, RU). The comparison block flags false_positive as true, and per rules for payment alerts this recommendation applies. No needed field is missing that would require NEED_MORE_INFO. Policy check: watched jurisdiction: IR (payment reference mentions "Tehran").

**What would change this**

- counterparty country matching one of the listed party's address countries (CN, IN, or RU)

## Path

Code's first finding from the structured fields was **Close as a false positive**, but the structured evidence does not settle the case or there is free text to weigh, so the agents reasoned over all of it.

## How the desk got there

1. **triage** (plan): path: customer review; the critic may send the recommendation back up to 3 times
2. **evidence** (read semantic layer): screening_usl v4efa3ddddfbe: 14 tables
3. **evidence** (find alert): 1 rows
4. **evidence** (find customer): 1 rows
5. **evidence** (find payment): 1 rows
6. **evidence** (find customer identifier): 1 rows
7. **evidence** (find list entry): 2 rows
8. **evidence** (find list alias): 26 rows
9. **evidence** (find list dob): 0 rows
10. **evidence** (find list country): 8 rows
11. **evidence** (find list identifier): 8 rows
12. **evidence** (find business definition): 6 rows
13. **evidence** (definitions): counterparty_match@1, effective_ownership_threshold@1, false_positive@2, strong_identifier@1, true_match@1
14. **evidence** (identifier overlap): no identifier matches
15. **evidence** (data quality): record passes this rule
16. **evidence** (data quality): record passes this rule
17. **evidence** (data quality): record passes this rule
18. **evidence** (data quality): record passes this rule
19. **evidence** (data quality): record passes this rule
20. **policy guard** (screen inbound): no instruction-like text
21. **matching** (compare party): weak: name 1.00 (exact) vs primary "STATE CORPORATION BANK FOR DEVELOPMENT AND FOREIGN ECONOMIC AFFAIRS VNESHECONOMBANK"; date of birth: missing_customer; country: conflict
22. **triage** (difficulty): contested (weak; date of birth missing_customer; country conflict)
23. **memory** (recall): no earlier decision about this pair
24. **triage** (path): reason: the structured evidence points to CLOSE_FALSE_POSITIVE, but there is free text to weigh: the payment reference
25. **decision** (recommend): CLOSE_FALSE_POSITIVE: The counterparty name matches exactly but the counterparty country NL is not among the listed party's address countries (CN, IN, RU). The comparison block flags false_positive as true, and per rules f
26. **critic** (verify facts): 5 verified, 0 issues
27. **critic** (judge): approved
28. **policy guard** (apply policy): CLOSE_FALSE_POSITIVE raised to ESCALATE_L2
29. **reporter** (seal record): record rec-eval-routed-EX-064 sealed

## What people did

Status: waiting for a person to decide.

No person has acted on this recommendation yet.

## Checks

| Check | Result | Detail |
|---|---|---|
| definition version | pass | counterparty_match@1, effective_ownership_threshold@1, false_positive@2, strong_identifier@1, true_match@1 |
| data quality | pass | no failing data-quality rule on the customer record |
| strong match | pass | comparison rates the match as weak |
| identifier match | pass | no identifier match |
| missing data | pass | date of birth: missing_customer |
| possible match | pass | no unresolved possible match |
| confidence floor | pass | confidence 0.95 |
| evidence standard | pass | no free text relied on |
| true match met | pass | true match definition not met |
| ownership | pass | not an ownership alert |
| jurisdiction | block | watched jurisdiction: IR (payment reference mentions "Tehran") |
| injection | pass | no instruction-like text in the data |
| human in the loop | pass | recommendation only; a person decides and nothing is sent or blocked automatically |
| critic | approved | 1 round |

## The decision trace

- **Which approved definition applied:** counterparty match v1, effective ownership threshold v1, false positive v2, strong identifier v1, true match v1
- **What data it rests on:** semantic layer 4efa3ddddfbe; 22 read-only queries; list snapshots OFAC ofac-consolidated-2026-10-19-dc3f61dc
- **Who could see what:** policy version 5; role_evidence_agent ran 22 queries (own token; masked: id_number)
- **What it cost to produce:** 3 model calls (1 local, 2 cloud), 11937 tokens in and 689 out, 22 data queries; 0.0065 USD under the configured unit costs

## Which model answered each step

| Step | Asked for | Answered by | Lane | App | Reasoning | Receipt |
|---|---|---|---|---|---|---|
| policy guard | meterless/fast | local-runtime/nemotron-3.5-lightning-30b-a3b | local | sanctions-desk-guard | none | valid pinned (rcpt_req_26fcegh5) |
| decision | meterless/deep | nvidia/nemotron-3-ultra-550b-a55b | cloud | sanctions-desk-reasoning | budget 500 tokens | valid pinned (rcpt_req_t9gx190b) |
| critic | meterless/judge | nvidia/nemotron-3-ultra-550b-a55b | cloud | sanctions-desk-reasoning | budget 400 tokens | valid pinned (rcpt_req_w1li6vf1) |

## The record

Sealed 2026-10-23T16:02:24.849Z with hash `c2d235499ba668f081288353939f22d066086ad739798dec16a3ae7c03f77dfb` (verified: the hash matches the contents). Data and policy as of 2026-10-23T16:02:24.849Z.

- [Decision record](decision-record.json)
- [Decision trace](decision-trace.json)
- [Run events](run-events.jsonl)
