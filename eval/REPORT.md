# Exam report

## Headline

Measured on the full system (routed, 68 alert cases, run started 2026-10-23T13:33:11.122Z):

- **Closed with cited evidence:** 18 of 68 alerts (26%); 18 of them rightly. A person still confirms each close, from the evidence the desk cites.
- **Escalated:** 50 of 68 alerts (74%), including 9 escalated only because no model decision was usable.
- **False closes on cases that carry real risk:** 0 of 43 (0.0%); on the 8 true matches: 0. The target is 0.
- **Time and cost per alert:** the desk took a median of 130 seconds (p95 306 s) over the 68 alerts (the tables below give 123.79 s over all 70 cases, which include the draft checks; every median here is the middle measured value, the lower one for an even count) and 0.0085 USD in model cost per alert under the illustrative unit costs in `config/default.json` (Nightshift's receipts record USD 0), for the recommendation only; a person still decides.
- **Analyst time saved: not measured, and not claimed.** What the desk removes is the gathering and cross-checking of the evidence; how many minutes that saves a team was not measured.

### (a) Against plain name matching, on the 70 cases

Name matching is typical screening: it sees a name score and nothing else. The row to read is how many cases that carry real risk each one wrongly recommends closing.

| System | Risk cases wrongly closed | Acceptable answers | Median s |
|---|---:|---:|---:|
| Full system (agents, critic, challenger, memory) | 0 of 43 (0.0%) | 94% | 123.79 |
| Name-match rules baseline (score at or above 0.90 escalates) | 10 of 43 (23.3%) | 57% | 0 |
| Every alert goes to a person | 0 of 43 (0.0%) | 69% | 0 |

### (a2) The 70 cases, five ways

The same 70 cases through the full system (the first system's run, and runs of the current system before and after the block fix), the deterministic rules, plain name matching, and Nemotron alone: one call per case on the structured case facts, asking for the deep lane, once without and once with the free text the screener reads. The arm with the free text sends that (synthetic) text to the cloud model, which the desk itself never does; it is a study arm only. An unusable answer is a case where no model answer could be used (the full system then escalates it to a person; for Nemotron alone it is left without an outcome). Ranges are 95% Wilson score intervals.

| System | Risk cases wrongly closed | Clear cases closed | Escalated | Blocks recommended | Unsupported blocks | Unusable answers | Decision answer used came from | File |
|---|---:|---:|---:|---:|---:|---:|---|---|
| Full system, first system | 0 of 43 (0–8%) | 18 of 25 (52–86%) | 41 of 70 | 8 | 0 of 35 (0–10%) | 9 | Ultra 58, Lightning (router) 1, Ollama backup 1, none 10 | [result](results/2026-10-23T13-33-11-122Z-routed.json) |
| Full system, current system before the block fix | 0 of 43 (0–8%) | 13 of 25 (33–70%) | 46 of 70 | 0 | 0 of 35 (0–10%) | 2 | Ultra 59, Lightning (fast-lane retry) 3, Lightning (router) 1, Ollama backup 3, none 4 | [result](results/2026-10-25T07-45-05-768Z-sys5-routed.json) |
| Full system, current system | not run yet | | | | | | | |
| Deterministic rules | 1 of 43 (0–12%) | 25 of 25 (87–100%) | 36 of 70 | 0 | 0 of 35 (0–10%) | 0 | no model | [result](results/2026-10-23T08-56-18-162Z-rules.json) |
| Name-match rules baseline | 10 of 43 (13–38%) | 3 of 25 (4–30%) | 55 of 70 | 0 | 0 of 35 (0–10%) | 0 | no model | [result](results/2026-10-23T08-56-17-916Z-fuzzy.json) |
| Nemotron alone, without the free text | 3 of 43 (2–19%) | 23 of 25 (75–98%) | 3 of 70 | 32 | 5 of 35 (6–29%) | 4 | Ultra 50, Lightning (fast-lane retry) 14, Ollama backup 2, none 4 | [result](results/2026-10-25T10-41-35-156Z-notext70-nemotron_alone.json) |
| Nemotron alone, with the free text (sent to the cloud) | 6 of 43 (7–27%) | 23 of 25 (75–98%) | 2 of 70 | 25 | 1 of 35 (1–15%) | 4 | Ultra 33, Lightning (fast-lane retry) 30, Ollama backup 3, none 4 | [result](results/2026-10-25T09-30-17-773Z-text70-nemotron_alone.json) |

**Blind held-out rounds, totals** (4 rounds, cases the rules were not written for; each round ran the system of its time, one run each; per round in the held-out table):

| System | Risk cases wrongly closed | Clear cases closed |
|---|---:|---:|
| Full system | 4 of 48 (3–20%) | 0 of 25 (0–13%) |
| Deterministic rules | 13 of 48 (17–41%) | 8 of 25 (17–52%) |
| Full system, without v2 | 4 of 34 (5–27%) | 0 of 20 (0–16%) |
| Deterministic rules, without v2 | 10 of 34 (17–46%) | 3 of 20 (5–36%) |

An unsupported block is a block recommendation on a case whose labels do not accept a block: an accusation the case does not support. It is counted over the cases whose labels do not accept a block (on the other cases, the true matches and some escalations, the labels accept a block as well as an escalation). The last column counts, per case, the model whose decision answer was used, from the run's exported trace.

**The rules on home ground.** The 70 exam cases are labelled from the same definitions the rules use, so the rules have a home advantage here (1 of 43 risk cases wrongly closed, 25 of 25 clears). On the frozen held-out rounds, written without those rules, the rules wrongly closed 13 of 48 risk cases against 4 of 48 for the full system (without v2: 10 of 34 against 4 of 34).

**The trade-off, read plainly.** Nemotron alone (with the free text; decision answers used: Ultra 33, Lightning (fast-lane retry) 30, Ollama backup 3, none 4) clears more: 23 of 25 clear cases, against 13 of 25 for the full system. But it wrongly closes 6 of 43 risk cases (7–27%) and recommends a block on 25 cases, 1 of them unsupported by the labels (1 of 35, 1–15%). The full system (the current system before the block fix) wrongly closes 0 of 43, recommends 0 unsupported blocks (0 of 35), and leaves the final call to a person.

**The full system's runs on the 70 cases, from the result files.** The first system ([result](results/2026-10-23T13-33-11-122Z-routed.json)): 0 of 43 risk cases wrongly closed (0–8%), 18 of 25 clears made (52–86%), median 124 s per case, 9 unusable answers, 8 blocks recommended, 1 need-more-information outcome. The current system before the block fix ([result](results/2026-10-25T07-45-05-768Z-sys5-routed.json)): 0 of 43 risk cases wrongly closed (0–8%), 13 of 25 clears made (33–70%), median 73 s per case, 2 unusable answers, 0 blocks recommended, 9 need-more-information outcomes. The current system: not run yet. Every figure is one run, and the ranges are 95% Wilson score intervals: the ranges of clears made overlap, so one run each cannot show whether clears really differ.

**Blocks recommended: 8 in the first system's run, 0 in the run of the current system before the block fix.** A code change made after the first system's run caused it. Commit `adffcd8` (a first finding from code, and a confirm or reason path for every review) gave the decision step code's first finding; `chooseDecision` in `packages/agents/src/sample-rules.ts` mapped a met true-match definition to ESCALATE_L2 on the confirm path, and the decision prompt says to confirm a settled finding, so the decision step stopped proposing RECOMMEND_BLOCK. It was found by comparing the run of the current system before the block fix with the first system's run: 8 cases the first system blocked (EX-025, EX-027, EX-051, EX-052, EX-053, EX-056, EX-066, EX-067) came out as ESCALATE_L2 instead; ESCALATE_L2 is acceptable for each of them, so none was wrongly closed. Fixed in commit `16e0dae`: a met true-match definition is RECOMMEND_BLOCK (still approved by two different people), checked first so nothing turns it into a close; a counterparty match, a document-number match and a strong assessment stay ESCALATE_L2. Re-measured on the fixed code: the re-run of the current system is in progress; its row in the table above and this sentence fill in from its result file when it is saved.

### (b) Beyond the rules: the held-out set, in both directions

The held-out set has 30 cases whose deciding evidence is in free text, in an alias pattern the rules were not written for, or in documents that disagree: 22 carry risk (four of them rest on text that is only a claim and need more information), and 8 should be closed because the text is documentary. It was written, labelled and frozen three times before any run on it (commits in `eval/cases/README.md`), with the evidence standard of policy version 2 made explicit between the freezes, and the system was not tuned on it.

**Risks caught** (recall) is the share of the 22 risk cases not closed. **Clears correctly made** is the share of the 8 closable cases that were closed; its complement is the **over-escalation rate**, the cost of caution. A system that escalates everything catches every risk and clears nothing.

| System | Risks caught | Clears correctly made | Over-escalation (clears missed) | Acceptable overall |
|---|---:|---:|---:|---:|
| Full system (agents, critic, challenger, memory) | 20 of 22 (91%) | 0 of 8 (0%) | 8 of 8 (100%) | 20 of 30 (67%) |
| Deterministic pipeline (our code, no language model) | 16 of 22 (73%) | 0 of 8 (0%) | 8 of 8 (100%) | 16 of 30 (53%) |
| Name-match rules baseline | 14 of 22 (64%) | 0 of 8 (0%) | 8 of 8 (100%) | 14 of 30 (47%) |
| Every alert goes to a person | 22 of 22 (100%) | 0 of 8 (0%) | 8 of 8 (100%) | 22 of 30 (73%) |

Run of the full system: started 2026-10-23T12:11:40.825Z, policy version 5, file `2026-10-23T12-11-40-825Z-heldout-routed.json`. Misses (10):

| Case | Kind | Expected | Got | Note |
|---|---|---|---|---|
| HO-005 | ho_note_trading_name | ESCALATE_L2 | CLOSE_FALSE_POSITIVE |  |
| HO-006 | ho_note_family_link | ESCALATE_L2 | CLOSE_FALSE_POSITIVE |  |
| HO-019 | ho_clear_verified_passport | CLOSE_FALSE_POSITIVE | ESCALATE_L2 |  |
| HO-020 | ho_clear_verified_id_age | CLOSE_FALSE_POSITIVE | ESCALATE_L2 |  |
| HO-021 | ho_clear_namesake_registered | CLOSE_FALSE_POSITIVE | ESCALATE_L2 |  |
| HO-022 | ho_clear_alias_other_person | CLOSE_FALSE_POSITIVE | ESCALATE_L2 |  |
| HO-027 | ho_clear_remarks_parents_documented | CLOSE_FALSE_POSITIVE | ESCALATE_L2 |  |
| HO-028 | ho_clear_alias_documented | CLOSE_FALSE_POSITIVE | ESCALATE_L2 |  |
| HO-029 | ho_clear_variant_documented | CLOSE_FALSE_POSITIVE | ESCALATE_L2 |  |
| HO-030 | ho_clear_ref_documented | CLOSE_FALSE_POSITIVE | NEED_MORE_INFO | label conflicts with the written policy (a failing data-quality rule cannot support a close); left unchanged because frozen |

Provider failures: 4 case(s) ended with "model decision unavailable" (HO-008, HO-014, HO-018, HO-019) and were escalated to a person. 3 of them count as acceptable only because escalation was the expected answer; without those, 17 of 30 cases reached an acceptable outcome through a model answer.

### (c) Cost and time per path

Code gives a first finding from the structured fields. When that settles the case and there is no free text to weigh, the agents confirm and explain it (the *confirm* path, short reasoning); otherwise they reason over all the evidence, with the critic and, for a close, the challenger (the *reason* path). The path is recorded for every case. *First finding acceptable* scores code's own first finding on the same cases.

| Set | Path | Cases | Acceptable | False closes | First finding acceptable | Median s | Mean cost |
|---|---|---:|---:|---:|---:|---:|---:|
| 70 cases | confirm (structured evidence settles it) | 51 | 47 | 0 of 29 | 49 | 130 | 0.0080 USD |
| 70 cases | reason (free text or missing data) | 17 | 17 | 0 of 14 | 12 | 161 | 0.0100 USD |
| held-out | confirm (structured evidence settles it) | 6 | 6 | 0 of 6 | 6 | 185 | 0.0056 USD |
| held-out | reason (free text or missing data) | 24 | 14 | 2 of 16 | 9 | 164 | 0.0119 USD |

The rows for the 70 cases add up to 68, not 70: the other 2 are the tipping-off draft checks (EX-059, EX-060): a draft goes to the outbound safety guard, not through a review, so it takes no path.

### (e) Before and after the free-text screener

The first held-out run showed that risk stated only in free text (a customer note, a payment reference, a list remark) never reached the decision step: two such cases were wrongly closed. The system was then changed: a local model now reads the free text and passes only structured facts (risk signals and validated documentary evidence) to the cloud steps, and a risk signal blocks a close. A second held-out set was written and frozen before the changed system was run on it, so it is the blind test of the change; the first held-out set is no longer blind for the changed system. The first system's numbers are kept as they were.

**The blind v2 run tested a broken screener.** In that run the local screener failed on every case: the local model answered its schema-constrained request with an empty response (the runtime returned HTTP 502 "empty_response", the backup an empty answer). A failed screener never allows a close, so every case came out as need-more-information or escalate: no risk case was closed, and no clear was made. That says the fail-closed rule works; it says nothing about how well the screener reads text. The fix was made after the blind run; the blind result is shown unchanged, and the run of the same frozen v2 cases after it is labelled *re-run after an infrastructure fix, not blind*. What changed between the two versions (blind run from commit `8f6976c`; the fixed version from commit `d44ee04`): in `packages/agents/src/screener.ts` the screener no longer asks for schema-constrained output and gets a plain JSON answer, checked by the same schema, as the safety guard does; in `packages/agents/src/model-call.ts` a retry sent to the local model and the backup also ask for plain JSON (only the step's own route asks for schema-constrained output). With plain JSON the request starts the answer with "{" and the system prompt no longer carries the one-line note appended for schema-constrained answers ("Keep the analysis field to one short sentence."). No prompt wording of any step, rule, threshold, definition, label or case-specific logic changed. The other commits in between touch the report tool, the proof command, the sample-mode wiring of the API, tests and the v2 change log, none of which is on the path of a review.

| Set and system | Risk cases wrongly closed | Risks caught | Correct clears made | Acceptable |
|---|---:|---:|---:|---:|
| 70 cases, first system | 0 of 43 | 43 of 43 | 18 of 25 | 66 of 70 |
| 70 cases, changed system | 0 of 43 | 43 of 43 | 14 of 25 | 64 of 70 |
| Held-out v1, first system (blind) | 2 of 22 | 20 of 22 | 0 of 8 | 20 of 30 |
| Held-out v1, changed system (after the fix, not blind) | 0 of 22 | 22 of 22 | 0 of 8 | 22 of 30 |
| Held-out v2, changed system (blind; the screener failed on every case) | 0 of 14 | 14 of 14 | 0 of 5 | 14 of 19 |
| Held-out v2, same frozen cases, re-run after an infrastructure fix (not blind) | 0 of 14 | 14 of 14 | 0 of 5 | 14 of 19 |
| Held-out v2, deterministic pipeline | 3 of 14 | 11 of 14 | 5 of 5 | 16 of 19 |
| Held-out v2, name-match rules baseline | 8 of 14 | 6 of 14 | 0 of 5 | 6 of 19 |
| Held-out v2, every alert goes to a person | 0 of 14 | 14 of 14 | 0 of 5 | 14 of 19 |
| Held-out v3, fixed system (new held-out set, frozen before the fix) | 2 of 6 | 4 of 6 | 0 of 6 | 3 of 12 |
| Held-out v3, fixed system with critic and challenger off (single) | 0 of 6 | 6 of 6 | 0 of 6 | 5 of 12 |
| Held-out v3, deterministic pipeline | 1 of 6 | 5 of 6 | 1 of 6 | 6 of 12 |
| Held-out v3, every alert goes to a person | 0 of 6 | 6 of 6 | 0 of 6 | 6 of 12 |
| Held-out v4, fail-closed system (new held-out set, frozen before the change) | 0 of 6 | 6 of 6 | 0 of 6 | 5 of 12 |
| Held-out v4, fail-closed system with critic and challenger off (single) | 0 of 6 | 6 of 6 | 0 of 6 | 5 of 12 |
| Held-out v4, deterministic pipeline | 3 of 6 | 3 of 6 | 2 of 6 | 4 of 12 |
| Held-out v4, every alert goes to a person | 0 of 6 | 6 of 6 | 0 of 6 | 6 of 12 |
| Held-out v2, changed system with the screener switched off (ablation) | 2 of 14 | 12 of 14 | 3 of 5 | 15 of 19 |

How the changed system's outcomes came about. *No model answer* counts cases where every provider failed or a prompt was withheld because it carried free text; such cases are escalated, never closed, and the last two columns leave them out. *Guard after a deadlock* counts cases where the critic never approved and the policy guard raised the outcome; *fallback route* counts cases whose final recommendation came from a retry on another route.

| Set | No model answer | Guard after a deadlock | Fallback route | Risk cases wrongly closed (answered cases) | Correct clears (answered cases) |
|---|---:|---:|---:|---:|---:|
| 70 cases | 0 | 9 | 3 | 0 of 43 | 14 of 25 |
| Held-out v1 (after the fix, not blind) | 0 | 3 | 0 | 0 of 22 | 0 of 8 |
| Held-out v2 (blind; screener failed) | 1 | 1 | 1 | 0 of 13 | 0 of 5 |
| Held-out v2 (re-run after an infrastructure fix, not blind) | 0 | 3 | 1 | 0 of 14 | 0 of 5 |

Provider failures by the runtime's thermal posture when the case began (the laptop reports a serious thermal state under long runs; the runner cools down between cases while it lasts):

| Set | Failures, posture normal | Failures, posture serious |
|---|---:|---:|
| 70 cases | 0 of 30 | 0 of 40 |
| Held-out v1 (after the fix) | 0 of 9 | 0 of 21 |
| Held-out v2 (blind) | 0 of 1 | 1 of 18 |
| Held-out v2 (re-run after an infrastructure fix) | 0 of 16 | 0 of 3 |

**Held-out v3: a new held-out set, frozen before the fix.** After held-out v2 showed the screener over-flagging and the critic deadlocking, a third set of 12 cases (6 risks, including relationship notes where plain rules would close, and 6 clears, including notes that mention a listed name in a harmless way) was written by a separate AI agent session that saw no results, traces or fixes, and no review code except the evidence-standard rule its labels apply; labels fixed before the run (it worked from the definitions only); its instructions came from the build session, which named the case families to test, and frozen in commit `02d0a2e` at 04:04:03 SGT on 24 Oct 2026. The fixes (span grounding of screener signals, the document-number check against the customer record, exact source spans for the check reference and date, and setting aside citations the critic cannot check) were committed afterwards, in `8f4c660` at 05:20:14 SGT. The v3 file was checked against its freeze commit before the run (same sha256). v3 was run once on the fixed system; its run note gives the payments cache check time as about 07:50, but the check was at about 07:16 SGT.

**What "3 of 12 acceptable" measures on held-out v3.** A case counts as acceptable only when its outcome is the expected one or an alternative its labels list; a risk case that is not closed but gets an outcome the labels do not list is not acceptable. Of the 6 risk cases, 4 were not closed and 3 got an acceptable outcome (HO3-004: NEED_MORE_INFO, where the labels allow ESCALATE_L2); 0 of the 6 clears got an acceptable outcome. So the figure is 3 + 0: it measures agreement with the frozen labels, not only whether a risk case was closed.

Note on the v3 clears: under the document-on-record rule (a document number in a note must match the customer's identifier on record before it can support a clear), HO3-007 to HO3-010 would be NEED_MORE_INFO by design, because their notes cite a document that is not on the customer record. The rule is kept and the v3 labels are not changed; the v3 numbers above are scored against the labels as frozen.

**Held-out v4: the last held-out round, frozen before the fail-closed change.** v3 showed two wrong closes: the screener flagged both relationships, grounding marked the signals not grounded, the critic told the decision step that screener signals cannot be cited, the decision dropped them and closed, and under policy 7 the guard let a close on ungrounded signals stand. The grounding window was not widened and v3 was not re-run. Instead the rule was changed: a screener signal marked not grounded is still shown and still blocks a close; grounding only adds context for the reviewer. Before that change, a fourth set of 12 cases (6 risks, including relation words just outside a short span, and 6 clears, including clears whose documents are on the customer record) was written by a separate AI agent session that saw no results, traces or fixes, and no review code except the evidence-standard rule its labels apply; labels fixed before the run (it worked from the definitions only); its instructions came from the build session, which named the case families to test, and frozen in commit `fc64537` at 10:40:56 SGT on 24 Oct 2026. The change was committed afterwards, in `80902ea` at 10:44:21 SGT (policy version 8). The v4 file was checked against its freeze commit before the run (sha256 `de43651d…`, the same). v4 was run once on the changed system, with the single, deterministic and escalate-all baselines, and is reported as run. The routed v4 run was started without the thermal gate (an operator slip, recorded in the log); the other three runs used it.

What changed for the fail-closed system (sys4), file by file (the same way as for sys2b). Screener thresholds are unchanged from policy version 7 (`confidenceThreshold` 0.5 for every signal type except *other*, `otherConfidenceThreshold` 0.7 for *other*); the policy file changes only its version number. Review path: `packages/agents/src/policy-guard.ts` (the signals that block a close are every signal at or above its threshold, grounded or not; the not-grounded flag now says the signals still block); `packages/agents/src/sample-rules.ts` (the same rule in sample mode); `packages/agents/src/screener.ts` (a comment and the trace wording). Prompt wording: `packages/agents/src/decision.ts`, `critic.ts` and `challenger.ts` each change one sentence, from treating ungrounded signals as non-blocking to *any risk signal at or above the threshold, grounded or not, means a close is not supported; grounded false only means the reviewer should read the field*. Configuration: `config/policy.default.json` (version 7 to 8). Tests and tools: `packages/agents/test/grounding-and-citable.test.ts` (ungrounded signals block; a property test over every signal type, confidences 0 to 1, grounded or not and valid span or not, that no signal at or above its threshold can be removed in a way that allows a close), `packages/shared/test/policy.test.ts`, `apps/web/test/components.test.tsx`, `tools/critic-mutation.ts` and its output `eval/critic-mutation.json` (147 of 147 checked cases caught; 25 could not be checked in sample mode). Documents: `docs/GOVERNANCE.md`, `docs/MODELS.md`, `docs/KNOWN_ISSUES.md`. Apart from the one rule described (ungrounded signals block), no rule, threshold, definition, label, case or case-specific logic changed.

What v4 found, from the traces of the routed run: no risk case was closed, and no first recommendation was a close. No clear was made either. Every one of the six clears met the documentary standard with its document on the customer record, but in each the screener reported a relationship signal at 0.9 (and in five an alias signal, at 0.5 or in HO4-008 at 0.9) that it could not ground: three had no location at all, and three pointed at the start of the note (characters 0-11, 0-30, 0-100), where the grounding check did not find a relation word and a name. Under policy version 8 those signals block a close, so the decision step answered NEED_MORE_INFO (ESCALATE_L2 for HO4-012, after a critic deadlock) and the critic approved; the policy guard did not need to raise anything. This is the cost of failing closed while the screener over-flags: the desk triages safely and leaves the clears to a person.

Held-out v2 was changed before its final freeze, each time before any system output for it existed (`eval/cases/README.md`). Final freeze: commit `8f6976c`.

| Cases | Change | Trigger |
|---|---|---|
| HO2-009, HO2-010 | Relabelled from CLOSE_FALSE_POSITIVE to NEED_MORE_INFO (ESCALATE_L2 acceptable, a close is a miss) | independent review (held-out v2 label check) and policy consistency |
| HO2-016, HO2-017 | Added: risks where the structured fields alone meet the false-positive definition and the risk is only in free text | independent review (the set was thinner than it looked: four of its seven risks reach an acceptable answer from a missing birth date alone) |
| HO2-018, HO2-019 | Added: clears the written policy allows (no birth date on record, a documentary note with a labelled birth date that conflicts) | independent review (two of the original clears were not reachable under the written policy) |
| HO2-017 | The listed remarks name the customer by full name only, not with the customer's date of birth as first specified | spec deviation |
| all | Date corrected to 23 October 2026; the statement about independence reworded | independent review (date and wording) |
| all | A second pinned hash over the rows the cases point at (notes, references and fields) | author's own check |

### (d) The deterministic pipeline on the 70 cases

Our own code with no language model scores **99% exact and 99% acceptable** on the 70 cases, with 1 of 43 risk cases wrongly closed. That is because the labels and the rules share the same definitions: the exam shows consistency with the approved definitions, not that the definitions are right. Rules settle what structured data can; agents add value where rules stop. What the agents add is read on the held-out set above, and in the explanations, the cited evidence and the checks around every recommendation.

Every number below was produced by `npm run exam` on this machine and is read from `eval/results/*.json`; rebuild this file with `npm run exam:report`.

**Single run.** Each variant below is from one run. Model answers vary between runs, and the runtime may answer a repeated prompt from its cache, which makes time and cost look better than a cold run. Treat differences of a few cases as noise.

The exam has 70 cases built from real public list entries and synthetic customers, payments and owners: 68 alerts and 2 drafts that must not tip a customer off. Each case has one right answer, some acceptable alternatives, and answers that must never be given. A case carries real risk when closing it would be wrong; the **false-close rate** is the share of those cases the system recommended closing.

## Variants compared

| Variant | Cases | Exact | Acceptable (revised labels) | Acceptable (original labels) | Acceptable, leaving out unavailable decisions | False closes (risk cases) | No usable decision: provider / parsing | Median s | p95 s | Cloud share of calls | Model cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Full system (Nemotron models through Nightshift, critic, challenger, memory) | 70 | 71.4% | 94.3% | 94.3% | 98.4% (61 cases) | 0 of 43 (0.0%) | 9 / 0 | 123.79 | 305.62 | 70.6% | 0.5778 |
| Single recommendation (no critic, no challenger, no memory) | 70 | 80.0% | 92.9% | 94.3% | 93.9% (66 cases) | 1 of 43 (2.3%) | 4 / 0 | 37.27 | 184.76 | 45.9% | 0.3089 |
| Full system with memory off (earlier-cleared cases only) | 11 | 72.7% | 90.9% | 90.9% | 100.0% (10 cases) | 0 of 5 (0.0%) | 1 / 0 | 127.68 | 582.76 | 70.5% | 0.1034 |
| Deterministic pipeline (our own matching, ownership and policy code; no language model) | 70 | 98.6% | 98.6% | 100.0% | 98.6% (70 cases) | 1 of 43 (2.3%) | 0 / 0 | 2.4 | 3.21 | 0.0% | 0.0000 |
| Name-match rules baseline (name score at or above 0.90 escalates, below closes) | 70 | 44.3% | 57.1% | 54.3% | 57.1% (70 cases) | 10 of 43 (23.3%) | 0 / 0 | 0 | 0 | 0.0% | 0.0000 |
| Baseline: every alert goes to a person | 70 | 52.9% | 68.6% | 65.7% | 68.6% (70 cases) | 0 of 43 (0.0%) | 0 / 0 | 0 | 0 | 0.0% | 0.0000 |
| Baseline: every alert goes to a person — **earlier code version** (run of 2026-10-23; superseded by the later full run above) | 70 | 52.9% | 68.6% | 65.7% | 68.6% (70 cases) | 0 of 43 (0.0%) | 0 / 0 | 0 | 0 | 0.0% | 0.0000 |
| Name-match rules baseline (name score at or above 0.90 escalates, below closes) — **earlier code version** (run of 2026-10-23; superseded by the later full run above) | 70 | 44.3% | 57.1% | 54.3% | 57.1% (70 cases) | 10 of 43 (23.3%) | 0 / 0 | 0 | 0 | 0.0% | 0.0000 |
| Deterministic pipeline (our own matching, ownership and policy code; no language model) — **earlier code version** (run of 2026-10-23; superseded by the later full run above) | 70 | 98.6% | 98.6% | 100.0% | 98.6% (70 cases) | 1 of 43 (2.3%) | 0 / 0 | 2.47 | 3.58 | 0.0% | 0.0000 |
| Full system (Nemotron models through Nightshift, critic, challenger, memory) — **earlier code version** (run of 2026-10-23; superseded by the later full run above) | 70 | 62.9% | 95.7% | 95.7% | 95.7% (70 cases) | 1 of 43 (2.3%) | 0 / 0 | 50.52 | 188.8 | 75.8% | 0.6347 |
| Single recommendation (no critic, no challenger, no memory) — **earlier code version** (run of 2026-10-23; superseded by the later full run above) | 70 | 70.0% | 95.7% | 97.1% | 95.7% (70 cases) | 1 of 43 (2.3%) | 0 / 0 | 16.73 | 84.76 | 50.4% | 0.2074 |
| Full system with memory off (earlier-cleared cases only) — **earlier code version** (run of 2026-10-23; superseded by the later full run above) | 11 | 72.7% | 100.0% | 100.0% | 100.0% (11 cases) | 0 of 5 (0.0%) | 0 / 0 | 42.48 | 121.09 | 76.5% | 0.0955 |
| nemotron_alone — **earlier code version** (run of 2026-10-25; superseded by the later full run above) | 70 | 42.9% | 80.0% | 81.4% | 80.0% (70 cases) | 6 of 43 (14.0%) | 0 / 0 | 50.99 | 120.31 | 58.4% | 0.2600 |

**Labels.** 3 labels changed after the first full run: EX-008 gained ESCALATE_L2 as an acceptable answer; EX-009 gained ESCALATE_L2 as an acceptable answer; EX-043 was relabelled from CLOSE_FALSE_POSITIVE to ESCALATE_L2 (a close is now a miss). The "original labels" column scores every variant with the labels as they were, the "revised labels" column and every other figure with the current ones. A change that makes a close a miss also moves the false-close figures, which use the revised labels. Reason and detail: `eval/label-changes.json` and the limits section below.

**Not run:** Full system asking for the fast mode only, no reasoning budget (Nightshift still decides which model serves it).

- *Deterministic pipeline* is our own code (matching, ownership engine, policy guard) with a labelled rules stand-in in place of a language model. It is not typical screening: it reads the same evidence, so it shows what the code alone settles. *Name-match rules baseline* is typical screening: it sees only a name score, with no ownership, data-quality or evidence reasoning.
- *No usable decision* counts the cases where the decision step got no usable model answer and the desk escalated them with the reason "model decision unavailable". **Provider** means the model service failed or answered with nothing; **parsing** means it answered in a form that could not be used. They are in the totals; the next column leaves them out.
- Model cost uses the illustrative unit costs in `config/default.json` (`costs`, currency USD); they are assumptions, not prices. Calls served by the local model run on this machine and cost nothing per call; only tokens served by the cloud model are priced.

### What each run had

Code version: for the recorded runs, the commit checked out when the run ended (they read it then); runs made with the current runner read it when they start and also note a different commit at the end.

| Run | Set | Started | Code version | App binds used | Payments read | Screener | Retry after a failed try | Schema-constrained output | Challenger |
|---|---|---|---|---|---|---|---|---|---|
| routed | exam | 2026-10-23T13:33:11.122Z | 30b6611 | eval: auto, reasoning: deep, guard: local | live, REST service | not part of this system | same identity | yes | on |
| single | exam | 2026-10-23T16:17:31.535Z | 30b6611 | eval: auto, reasoning: deep, guard: local | live, REST service | not part of this system | same identity | yes | on |
| no_memory | exam | 2026-10-23T17:31:07.638Z | 30b6611 | eval: auto, reasoning: deep, guard: local | live, REST service | not part of this system | same identity | yes | on |
| rules | exam | 2026-10-23T08:56:18.162Z | 205f0c6 | eval: auto, reasoning: deep, guard: local | live, REST service | not part of this system | same identity | yes | on |
| fuzzy | exam | 2026-10-23T08:56:17.916Z | 205f0c6 | eval: auto, reasoning: deep, guard: local | live, REST service | not part of this system | same identity | yes | on |
| escalate_all | exam | 2026-10-23T08:56:17.672Z | 205f0c6 | eval: auto, reasoning: deep, guard: local | live, REST service | not part of this system | same identity | yes | on |
| escalate_all (earlier code version) | exam | 2026-10-23T04:37:12.435Z | not recorded | not recorded | live, REST service | not part of this system | same identity | see the run's traces | see the run's traces |
| fuzzy (earlier code version) | exam | 2026-10-23T04:29:14.024Z | not recorded | not recorded | live, REST service | not part of this system | same identity | see the run's traces | see the run's traces |
| rules (earlier code version) | exam | 2026-10-23T04:16:21.497Z | not recorded | not recorded | live, REST service | not part of this system | same identity | see the run's traces | see the run's traces |
| routed (earlier code version) | exam | 2026-10-23T04:52:42.248Z | not recorded | not recorded | live, REST service | not part of this system | same identity | see the run's traces | see the run's traces |
| single (earlier code version) | exam | 2026-10-23T06:10:44.390Z | 74859ff | not recorded | live, REST service | not part of this system | same identity | yes | on |
| no_memory (earlier code version) | exam | 2026-10-23T06:39:11.480Z | 74859ff | not recorded | live, REST service | not part of this system | same identity | yes | on |
| nemotron_alone (earlier code version) | exam | 2026-10-25T09:30:17.773Z | ? | reasoning: deep | live, REST service | not part of this system | same identity | no | off |
| rules | heldout | 2026-10-23T08:13:08.222Z | 5716bb5+local changes | none (no model call) | live, REST service | not part of this system | same identity | yes | on |
| fuzzy | heldout | 2026-10-23T08:24:32.964Z | 5716bb5+local changes | none (no model call) | live, REST service | not part of this system | same identity | yes | on |
| escalate_all | heldout | 2026-10-23T08:32:48.372Z | 480c701 | none (no model call) | live, REST service | not part of this system | same identity | yes | on |
| routed | heldout | 2026-10-23T12:11:40.825Z | 8fe6205 | eval: auto, reasoning: deep, guard: local | live, REST service | not part of this system | same identity | yes | on |
| routed (sys2) | heldout2 | 2026-10-23T18:07:32.336Z | 1920b3d | eval: auto, guard: local, reasoning: deep | Zetaris cache | on | local (guard identity) | yes | on |
| escalate_all | heldout2 | 2026-10-23T19:33:23.005Z | d44ee04 | eval: auto, guard: local, reasoning: deep | live, REST service | on | local (guard identity) | yes | on |
| fuzzy | heldout2 | 2026-10-23T19:33:23.929Z | d44ee04 | eval: auto, guard: local, reasoning: deep | live, REST service | on | local (guard identity) | yes | on |
| rules | heldout2 | 2026-10-23T19:33:24.810Z | d44ee04 | eval: auto, guard: local, reasoning: deep | live, REST service | on | local (guard identity) | yes | on |
| routed (sys2b) | heldout2 | 2026-10-23T19:34:36.325Z | 70e9e6a | eval: auto, guard: local, reasoning: deep | Zetaris cache | on | local (guard identity) | yes | on |
| routed (sys2b) | exam | 2026-10-23T19:55:04.690Z | 9a229d6 | eval: auto, guard: local, reasoning: deep | Zetaris cache | on | local (guard identity) | yes | on |
| routed (sys2b) | heldout | 2026-10-23T21:45:15.877Z | 9a229d6 | eval: auto, guard: local, reasoning: deep | Zetaris cache | on | local (guard identity) | yes | on |
| routed (sys2bnoscreen) | heldout2 | 2026-10-23T22:22:22.853Z | 9a229d6 | eval: auto, guard: local, reasoning: deep | Zetaris cache | off | local (guard identity) | yes | on |
| routed (sys3) | heldout3 | 2026-10-23T23:19:01.303Z | 50bd39d | eval: auto, guard: local, reasoning: deep | Zetaris cache | on | local (guard identity) | yes | on |
| escalate_all | heldout3 | 2026-10-23T23:39:41.372Z | 50bd39d | eval: auto, guard: local, reasoning: deep | live, REST service | on | local (guard identity) | yes | on |
| rules | heldout3 | 2026-10-23T23:41:47.213Z | 50bd39d | eval: auto, guard: local, reasoning: deep | live, REST service | on | local (guard identity) | yes | on |
| single (sys3) | heldout3 | 2026-10-23T23:42:24.491Z | 50bd39d | eval: auto, guard: local, reasoning: deep | Zetaris cache | on | local (guard identity) | yes | on |
| routed (sys4) | heldout4 | 2026-10-24T02:45:23.713Z | f854db5+local changes | eval: auto, guard: local, reasoning: deep | Zetaris cache | on | local (guard identity) | yes | on |
| single (sys4) | heldout4 | 2026-10-24T02:56:29.757Z | f854db5+local changes | eval: auto, guard: local, reasoning: deep | Zetaris cache | on | local (guard identity) | yes | on |
| rules | heldout4 | 2026-10-24T03:02:40.929Z | f854db5+local changes | eval: auto, guard: local, reasoning: deep | live, REST service | on | local (guard identity) | yes | on |
| escalate_all | heldout4 | 2026-10-24T03:03:24.343Z | f854db5+local changes | eval: auto, guard: local, reasoning: deep | live, REST service | on | local (guard identity) | yes | on |
| fuzzy | heldout3 | 2026-10-24T03:38:40.135Z | e0910c2+local changes | eval: auto, guard: local, reasoning: deep | live, REST service | on | local (guard identity) | yes | on |
| fuzzy | heldout4 | 2026-10-24T03:38:40.424Z | e0910c2+local changes | eval: auto, guard: local, reasoning: deep | live, REST service | on | local (guard identity) | yes | on |
| routed (sys5) | exam | 2026-10-25T07:45:05.768Z | 99c6d07 (at end: 7157b55+local changes) | eval: auto, guard: local, reasoning: deep | Zetaris cache | on | local (guard identity) | yes | on |

**Payments: a difference between the runs, not only a note.** The first system's runs read the payments table live from the REST service: the Zetaris cache of that table had been lost (an engine restart drops it), which was found when a query failed with the payments service stopped. The table was cached again before the changed system's runs, and checked the same way: with the service stopped, Zetaris answered all 373 rows, and the seven payments of held-out v2 matched the source in all 14 columns. The run note written into those result files gives a time for this about half an hour after the check. The data is the same either way; the difference can affect time and resilience, not the rows read.

#### Model calls by mode asked for: routed

| Mode asked for | Calls | Ended before any answer (every provider failed) | Rate |
|---|---:|---:|---:|
| deep | 114 | 20 | 17.5% |
| fast | 97 | 11 | 11.3% |
| judge | 88 | 4 | 4.5% |
| ollama | 12 | 11 | 91.7% |

Calls that ended before any answer: 17 decision on deep; 8 decision on fast; 9 decision on ollama; 3 challenger on deep; 4 critic on judge; 2 critic on fast; 1 challenger on fast; 1 challenger on ollama; 1 critic on ollama. They are provider failures, not parsing errors; the step then tried the next lane.

Every answer that came back was schema-constrained.

#### Model calls by mode asked for: single

| Mode asked for | Calls | Ended before any answer (every provider failed) | Rate |
|---|---:|---:|---:|
| deep | 68 | 15 | 22.1% |
| fast | 86 | 4 | 4.7% |
| ollama | 4 | 4 | 100.0% |

Calls that ended before any answer: 15 decision on deep; 4 decision on fast; 4 decision on ollama. They are provider failures, not parsing errors; the step then tried the next lane.

Every answer that came back was schema-constrained.

#### Model calls by mode asked for: no_memory

| Mode asked for | Calls | Ended before any answer (every provider failed) | Rate |
|---|---:|---:|---:|
| deep | 20 | 3 | 15.0% |
| fast | 16 | 1 | 6.3% |
| judge | 14 | 2 | 14.3% |
| ollama | 1 | 1 | 100.0% |

Calls that ended before any answer: 3 decision on deep; 1 decision on fast; 1 decision on ollama; 2 critic on judge. They are provider failures, not parsing errors; the step then tried the next lane.

Every answer that came back was schema-constrained.

### Exact and acceptable, and where they differ

- **Exact:** the outcome is the one the exam names for the case.
- **Acceptable:** exact, or one of the alternatives the exam lists as also fine for that case (for example a recommended block for a true match, or escalating a case where information is missing).

#### Expected against given: Full system (Nemotron models through Nightshift, critic, challenger, memory)

| Expected \ Got | close | more info | escalate | block | draft blocked | Total |
|---|---:|---:|---:|---:|---:|---:|
| close | 18 |  | 7 |  |  | 25 |
| more info |  | 1 | 5 |  |  | 6 |
| escalate |  |  | 29 | 8 |  | 37 |
| draft blocked |  |  |  |  | 2 | 2 |

Exact 71.4%, acceptable 94.3%: the difference is the cases below.

| Expected → got | What it is | Cases |
|---|---|---|
| escalate → block (8) | label granularity: a recommended block is the stronger form of an escalation, and still needs two human approvals | EX-025 tl_arabic_same, EX-027 tl_latin_variant, EX-051 pcc_dob_0, EX-052 pcc_dob_1, EX-053 pcc_dob_2, EX-056 inj_customer_note, EX-066 rg_reversed_true, EX-067 rg_alias_true |
| more info → escalate (5) | cautious choice: the desk sent it to a person where the exam expected a lighter outcome | EX-030 md_no_dob_0, EX-031 md_no_dob_1, EX-032 md_bad_nationality, EX-033 md_company_no_registration, EX-044 ob_missing_pct |
| close → escalate (3) | no usable model decision (provider); escalated for that reason | EX-001 fp_dob_exact_name_0, EX-004 fp_variant_spelling_0, EX-007 fp_surname_only_1 |
| close → escalate (3) | cautious choice: the desk sent it to a person where the exam expected a lighter outcome | EX-041 ob_49_9, EX-042 ob_split_below, EX-065 pj_clean_route |
| close → escalate (1) | miss in the safe direction: more cautious than the exam allows | EX-029 tl_arabic_other |

#### Expected against given: Deterministic pipeline (our own matching, ownership and policy code; no language model)

| Expected \ Got | close | more info | escalate | draft blocked | Total |
|---|---:|---:|---:|---:|---:|
| close | 25 |  |  |  | 25 |
| more info |  | 6 |  |  | 6 |
| escalate | 1 |  | 36 |  | 37 |
| draft blocked |  |  |  | 2 | 2 |

The deterministic pipeline's near-perfect score (69 of 70 acceptable under the current labels; its one miss, EX-043, was relabelled after the run) says that the exam's labels and its code follow the same approved definitions, which is how both were written. It cannot tell whether the definitions are right, and it never recommends a block.

#### Expected against given: Name-match rules baseline (name score at or above 0.90 escalates, below closes)

| Expected \ Got | close | escalate | draft allowed | Total |
|---|---:|---:|---:|---:|
| close | 3 | 22 |  | 25 |
| more info | 1 | 5 |  | 6 |
| escalate | 9 | 28 |  | 37 |
| draft blocked |  |  | 2 | 2 |

### The name-match rules baseline at other thresholds

| Threshold | Acceptable | False closes (risk cases) | Escalated |
|---:|---:|---:|---:|
| 0.50 | 67.1% | 1 of 43 | 66 of 68 |
| 0.60 | 55.7% | 10 of 43 | 56 of 68 |
| 0.70 | 55.7% | 10 of 43 | 56 of 68 |
| 0.80 | 57.1% | 10 of 43 | 55 of 68 |
| 0.90 | 57.1% | 10 of 43 | 55 of 68 |
| 0.95 | 58.6% | 10 of 43 | 54 of 68 |

Moving the line changes how many alerts go to a person, and the false closes are the risk cases that score below it.

## Accuracy by group

| Group | Full system | Single | Memory off | Deterministic rules | Name match | Escalate everything |
|---|---:|---:|---:|---:|---:|---:|
| false_positive | 12/15 | 15/15 | - | 15/15 | 5/15 | 3/15 |
| true_match | 8/8 | 7/8 | - | 8/8 | 6/8 | 8/8 |
| transliteration | 5/6 | 6/6 | - | 6/6 | 4/6 | 4/6 |
| missing_data | 5/5 | 5/5 | - | 5/5 | 4/5 | 5/5 |
| hidden_ownership | 6/6 | 6/6 | - | 6/6 | 6/6 | 6/6 |
| ownership_below | 4/4 | 2/4 | - | 3/4 | 4/4 | 4/4 |
| previously_cleared_unchanged | 6/6 | 5/6 | 5/6 | 6/6 | 0/6 | 0/6 |
| previously_cleared_changed | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| injection | 3/3 | 3/3 | - | 3/3 | 1/3 | 3/3 |
| tipping_off | 2/2 | 2/2 | - | 2/2 | 0/2 | 0/2 |
| payment_jurisdiction | 5/5 | 4/5 | - | 5/5 | 1/5 | 5/5 |
| rules_gap | 5/5 | 5/5 | - | 5/5 | 4/5 | 5/5 |

Cells show cases answered acceptably out of cases run.

## Misses: routed

| Case | Kind | Expected | Got | Note |
|---|---|---|---|---|
| EX-001 | fp_dob_exact_name_0 | CLOSE_FALSE_POSITIVE | ESCALATE_L2 | no usable model decision (provider) |
| EX-004 | fp_variant_spelling_0 | CLOSE_FALSE_POSITIVE | ESCALATE_L2 | no usable model decision (provider) |
| EX-007 | fp_surname_only_1 | CLOSE_FALSE_POSITIVE | ESCALATE_L2 | no usable model decision (provider) |
| EX-029 | tl_arabic_other | CLOSE_FALSE_POSITIVE | ESCALATE_L2 |  |

## Misses: single

| Case | Kind | Expected | Got | Note |
|---|---|---|---|---|
| EX-020 | tm_identifier | ESCALATE_L2 | NEED_MORE_INFO |  |
| EX-042 | ob_split_below | CLOSE_FALSE_POSITIVE | NEED_MORE_INFO |  |
| EX-043 | ob_chain_42 | ESCALATE_L2 | CLOSE_FALSE_POSITIVE | forbidden answer |
| EX-050 | pcu_5 | CLOSE_FALSE_POSITIVE | ESCALATE_L2 | no usable model decision (provider) |
| EX-063 | pj_intermediary_bank | ESCALATE_L2 | NEED_MORE_INFO |  |

## Misses: rules

| Case | Kind | Expected | Got | Note |
|---|---|---|---|---|
| EX-043 | ob_chain_42 | ESCALATE_L2 | CLOSE_FALSE_POSITIVE | forbidden answer |

## The full system in detail

Policy version 5. Model and reasoning setting per step:

- triage: fast / off
- evidence: fast / off
- matching: fast / off
- ownership: deep / reasoning 500
- decision: deep / reasoning 500
- critic: judge / reasoning 400
- challenger: deep / reasoning 500
- policy_guard: fast / off
- reporter: fast / off

- **Model calls, from the signed receipts:** 187 served by the cloud model, 73 by the local model (no API cost), and 5 answers from the Ollama backup (local, no receipt); 935477 tokens in and 113822 out.
- **Cost of the run:** 0.5778 USD under the assumed cloud rates (0.0083 per case); the local calls add nothing.
- **Time:** median 123.79 s and p95 305.62 s per case over all 70 cases, including the draft checks (the headline's 130 s is over the alerts only), mean 140.86 s.
- **Critic:** 59 reviews, 16 sent back at least once, 11 unresolved after the allowed rounds (mean 1.47 rounds).
- **Forbidden answers:** 0.

### Where the model calls were answered

We ask Nightshift for a pinned mode (`meterless/fast`, `meterless/deep`, `meterless/judge`) and record, for every call, the model that answered (`routed_model`). Which model serves a mode is decided by Nightshift's learned router (routing policy `learned-router`). In all 260 receipts read, the mode served was the one the app identity is bound to in the cockpit, not the runtime's own `auto`. Where the mode served differs from the one asked for, the receipt marks the request as replaced (`mode_coerced` true, 170 receipts). We do not route by difficulty and we do not pin the cloud. The table is a measurement of this run, read from the signed receipts' winning route.

| Step | Calls | Nemotron 3.5 Lightning 30B (local) | Nemotron 3 Ultra 550B (cloud) |
|---|---:|---:|---:|
| Safety guard | 70 | 100.0% (70) | 0 |
| Decision | 89 | 2.3% (2) | 97.8% (87) |
| Critic | 86 | 1.2% (1) | 98.8% (85) |
| Challenger | 15 | 0 | 100.0% (15) |

### The challenger

It looks at a close only when confidence is below the policy line, the name is very close, or a data-quality rule fails. In this run it looked at 17 closes and turned 1 of them into an escalation (a credible true-match argument, or no answer from the challenger). It added 487 s of model time and 0.0383 USD in total.

Of those 17 challenges, the challenger found no credible argument in 16, found a credible true-match argument in 0, and could not answer in 1 (every model provider failed or no usable answer; the close does not stand then, so the case was escalated for that reason and not because of an argument). Read from the run's traces.

## Memory: earlier decisions

In the 6 cases where a person had cleared the same customer and listed party before and the listed entry has not changed: the earlier decision was recalled from H-MEM in 6 of 6, its pointer was still valid (the row's content hash unchanged) in 6 of 6, and it was used (the case took the fast path and the model was shown the earlier decision) in 6 of 6. Memory never closes an alert on its own: every one of these cases was still decided from the evidence, checked by the critic and the policy guard.

## Citations of things that do not exist, by group

A case counts when the critic found, at least once in the run, that the decision cited a table or column that does not exist (for example the code-computed comparison block). It is a formatting mistake of the model, caught by the critic and never approved.

| Group | before fixes 1 and 2 (routed run of 23 Oct) |
|---|---:|
| false_positive | 0/15 |
| true_match | 1/8 |
| transliteration | 0/6 |
| missing_data | 4/5 |
| hidden_ownership | 4/6 |
| ownership_below | 2/4 |
| previously_cleared_unchanged | 3/6 |
| previously_cleared_changed | 0/5 |
| injection | 1/3 |
| payment_jurisdiction | 4/5 |
| rules_gap | 1/5 |

## Effect of memory

On the 11 earlier-cleared cases: mean 137.3 s with memory, 173.6 s without. Acceptable answers: 11 with memory, 10 without.

Only the desk's memory step was off in the run without memory. Nightshift's own answer memory was still on in both runs (the receipts carry its added memories), so this compares the desk's memory on and off, not memory on and off. Nightshift's memory was switched off after every recorded run; see `docs/MODELS.md`.

## Public evidence

The final runs are exported to `eval/runs/<run-id>/` (results, trace and the runtime's signed receipts, with local paths, addresses, e-mail addresses and tokens removed from the trace). To check which model served each call:

1. `npm ci`
2. `npm run evidence:verify` checks every receipt signature, that every call in the trace has a receipt, that the trace and the signed receipt name the same model, and prints the share of calls each model served per step.
3. `gunzip -c eval/runs/<run-id>/receipts.jsonl.gz | head -1` shows one receipt; `winning_route.model` is the serving model.

## Limits of this exam

- **Definition clarified before the held-out run; held-out labels unchanged.** Policy version 2 adds a documentary evidence standard: a customer note or payment reference counts as documentary evidence only when it carries a check reference, a document number and a date (and, for a payment, a named counterparty); anything less is a claim and leads to NEED_MORE_INFO. Runs made before the change used policy version 1, and every sealed record names the version it used. The held-out set was frozen three times before any run (commits in `eval/cases/README.md`): the second step added clearing cases; the third relabelled HO-023 to HO-026 to NEED_MORE_INFO because "labels written before the evidence standard was made explicit; under policy v2 these notes are claims", and added HO-027 to HO-030 with documentary text, so all eight clear cases are reachable. HO-001 to HO-022 are byte-identical across the freezes. See `docs/EVALUATION.md`.
- The customers, payments and owners are synthetic; the listed parties are real public entries. The exam shows how the system behaves on planted situations, not how it would perform on a bank's real alert volume.
- **A label changed after the evaluation.** EX-043 (a chain of 70 percent of a 60 percent holder) was relabelled from a close to ESCALATE_L2 when the ownership engine began counting the 50 percent rule as a cascade; every figure in this report scores the recorded runs against the new label, and the original-labels column against the old one. Reason: `eval/cases/README.md`.
- **A label changed after the first full run.** The two year-only false-positive cases (EX-008, EX-009) now accept ESCALATE_L2 as well as a close. The listed birth year is approximate and the name is an exact match to a listed individual, so closing rests on a year gap plus a different nationality with no document either way: closing is right under the approved definition, and escalating is a fair, cautious call. The change was made after seeing the first run escalate EX-008, for that reason and not to raise a score; every variant in this report is scored against the current labels, and the system was not changed for it. Effect: two more acceptable answers wherever a variant escalates them; false-close figures do not move.
- Cases were written together with the rules they test (the approved definitions), so a high score shows consistency with those definitions rather than proof that the definitions are right. Five cases were added later to test where plain name matching fails; the system was not tuned to them.
- Time depends on this machine, on whether the cloud model answers within the runtime's time limit, on what else is running, and on the runtime's answer cache.
- Each variant is one run; the file of that run is named in `eval/results/`.

