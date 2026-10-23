# Exam report

## Headline

Measured on the full system (routed, 68 alert cases, run started 2026-10-23T04:52:42.248Z):

- **Closed with cited evidence:** 21 of 68 alerts (31%); 21 of them rightly. A person still confirms each close, from the evidence the desk cites.
- **Escalated:** 47 of 68 alerts (69%), including 0 escalated only because no model decision was usable.
- **False closes on cases that carry real risk:** 0 of 42 (0.0%); on the 8 true matches: 0. The target is 0.
- **Analyst minutes saved per 100 alerts: about 401.** This one is an *estimate that rests on assumptions*, not a measurement: 15 minutes for an analyst to work an alert from scratch, 2 minutes to confirm a close from cited evidence, and no time credited for the alerts that are escalated. Only closes that were right count. Change the assumptions in `config/default.json` (`report`) and rebuild this file.

Every number below was produced by `npm run exam` on this machine and is read from `eval/results/*.json`; rebuild this file with `npm run exam:report`.

**Single run.** Each variant below is from one run. Model answers vary between runs, and the runtime may answer a repeated prompt from its cache, which makes time and cost look better than a cold run. Treat differences of a few cases as noise.

The exam has 70 cases built from real public list entries and synthetic customers, payments and owners: 68 alerts and 2 drafts that must not tip a customer off. Each case has one right answer, some acceptable alternatives, and answers that must never be given. A case carries real risk when closing it would be wrong; the **false-close rate** is the share of those cases the system recommended closing.

## Variants compared

| Variant | Cases | Exact | Acceptable (revised labels) | Acceptable (original labels) | Acceptable, leaving out unavailable decisions | False closes (risk cases) | No usable decision: provider / parsing | Median s | p95 s | Cloud share of calls | Model cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Full system (Nemotron models through Nightshift, critic, challenger, memory) | 70 | 64.3% | 97.1% | 95.7% | 97.1% (70 cases) | 0 of 42 (0.0%) | 0 / 0 | 50.52 | 188.8 | 75.8% | 0.6347 |
| Deterministic pipeline (our own matching, ownership and policy code; no language model) | 70 | 100.0% | 100.0% | 100.0% | 100.0% (70 cases) | 0 of 42 (0.0%) | 0 / 0 | 2.47 | 3.58 | 0.0% | 0.0000 |
| Name-match rules baseline (name score at or above 0.90 escalates, below closes) | 70 | 42.9% | 57.1% | 54.3% | 57.1% (70 cases) | 10 of 42 (23.8%) | 0 / 0 | 0 | 0 | 0.0% | 0.0000 |
| Baseline: every alert goes to a person | 70 | 51.4% | 68.6% | 65.7% | 68.6% (70 cases) | 0 of 42 (0.0%) | 0 / 0 | 0 | 0 | 0.0% | 0.0000 |

**Labels.** Two cases (EX-008, EX-009) gained ESCALATE_L2 as an acceptable answer after the first full run; the "original labels" column scores every variant with the labels as they were, the "revised labels" column with the current ones. Nothing else differs, and the false-close figures do not move. Reason and detail: `eval/label-changes.json` and the limits section below.

**Not run:** Single recommendation (no critic, no challenger, no memory); Full system with memory off (earlier-cleared cases only); Full system asking for the fast mode only, no reasoning budget (Nightshift still decides which model serves it).

- *Deterministic pipeline* is our own code (matching, ownership engine, policy guard) with a labelled rules stand-in in place of a language model. It is not typical screening: it reads the same evidence, so it shows what the code alone settles. *Name-match rules baseline* is typical screening: it sees only a name score, with no ownership, data-quality or evidence reasoning.
- *No usable decision* counts the cases where the decision step got no usable model answer and the desk escalated them with the reason "model decision unavailable". **Provider** means the model service failed or answered with nothing; **parsing** means it answered in a form that could not be used. They are in the totals; the next column leaves them out.
- Model cost uses the illustrative unit costs in `config/default.json` (`costs`, currency USD); they are assumptions, not prices. Calls served by the local model run on this machine and cost nothing per call; only tokens served by the cloud model are priced.

### What each run had

| Variant | Started | Code version | Schema-constrained output | Challenger | Pause after a provider failure | Challenger answer limit |
|---|---|---|---|---|---|---|
| routed | 2026-10-23T04:52:42.248Z | not recorded | see the run's traces | see the run's traces | none (started before it was added) | limited to four points; a longer list failed (started before the fix) |
| rules | 2026-10-23T04:16:21.497Z | not recorded | see the run's traces | see the run's traces | none (started before it was added) | limited to four points; a longer list failed (started before the fix) |
| fuzzy | 2026-10-23T04:29:14.024Z | not recorded | see the run's traces | see the run's traces | none (started before it was added) | limited to four points; a longer list failed (started before the fix) |
| escalate_all | 2026-10-23T04:37:12.435Z | not recorded | see the run's traces | see the run's traces | none (started before it was added) | limited to four points; a longer list failed (started before the fix) |

#### Model calls by mode asked for: routed

| Mode asked for | Calls | Ended before any answer (every provider failed) | Rate |
|---|---:|---:|---:|
| deep | 126 | 13 | 10.3% |
| fast | 101 | 1 | 1.0% |
| judge | 108 | 1 | 0.9% |
| nemotron-3.5-lightning:30b | 3 | 0 | 0.0% |
| ollama | 1 | 1 | 100.0% |

Calls that ended before any answer: 2 challenger on deep; 1 challenger on fast; 1 challenger on ollama; 11 decision on deep; 1 critic on judge. They are provider failures, not parsing errors; the step then tried the next lane.

Every answer that came back was schema-constrained.

### Exact and acceptable, and where they differ

- **Exact:** the outcome is the one the exam names for the case.
- **Acceptable:** exact, or one of the alternatives the exam lists as also fine for that case (for example a recommended block for a true match, or escalating a case where information is missing).

#### Expected against given: Full system (Nemotron models through Nightshift, critic, challenger, memory)

| Expected \ Got | close | more info | escalate | block | draft blocked | Total |
|---|---:|---:|---:|---:|---:|---:|
| close | 21 |  | 5 |  |  | 26 |
| more info |  | 1 | 5 |  |  | 6 |
| escalate |  |  | 21 | 15 |  | 36 |
| draft blocked |  |  |  |  | 2 | 2 |

Exact 64.3%, acceptable 97.1%: the difference is the cases below.

| Expected → got | What it is | Cases |
|---|---|---|
| escalate → block (15) | label granularity: a recommended block is the stronger form of an escalation, and still needs two human approvals | EX-016 tm_exact_0, EX-017 tm_exact_1, EX-018 tm_variant, EX-019 tm_homoglyph, EX-021 tm_non_latin, EX-024 tl_cyrillic_same, EX-025 tl_arabic_same, EX-026 tl_han_same, EX-027 tl_latin_variant, EX-051 pcc_dob_0, EX-052 pcc_dob_1, EX-053 pcc_dob_2, EX-056 inj_customer_note, EX-066 rg_reversed_true, EX-067 rg_alias_true |
| more info → escalate (5) | cautious choice: the desk sent it to a person where the exam expected a lighter outcome | EX-030 md_no_dob_0, EX-031 md_no_dob_1, EX-033 md_company_no_registration, EX-034 md_payment_country, EX-044 ob_missing_pct |
| close → escalate (3) | cautious choice: the desk sent it to a person where the exam expected a lighter outcome | EX-008 fp_year_only_0, EX-041 ob_49_9, EX-065 pj_clean_route |
| close → escalate (2) | real error, in the safe direction: the model cited something that does not exist three times and the critic would not approve it | EX-045 pcu_0, EX-049 pcu_4 |

#### Expected against given: Deterministic pipeline (our own matching, ownership and policy code; no language model)

| Expected \ Got | close | more info | escalate | draft blocked | Total |
|---|---:|---:|---:|---:|---:|
| close | 26 |  |  |  | 26 |
| more info |  | 6 |  |  | 6 |
| escalate |  |  | 36 |  | 36 |
| draft blocked |  |  |  | 2 | 2 |

The deterministic pipeline's perfect score says that the exam's labels and its code follow the same approved definitions, which is how both were written. It cannot tell whether the definitions are right, and it never recommends a block.

#### Expected against given: Name-match rules baseline (name score at or above 0.90 escalates, below closes)

| Expected \ Got | close | escalate | draft allowed | Total |
|---|---:|---:|---:|---:|
| close | 3 | 23 |  | 26 |
| more info | 1 | 5 |  | 6 |
| escalate | 9 | 27 |  | 36 |
| draft blocked |  |  | 2 | 2 |

### The name-match rules baseline at other thresholds

| Threshold | Acceptable | False closes (risk cases) | Escalated |
|---:|---:|---:|---:|
| 0.50 | 67.1% | 1 of 42 | 66 of 68 |
| 0.60 | 55.7% | 10 of 42 | 56 of 68 |
| 0.70 | 55.7% | 10 of 42 | 56 of 68 |
| 0.80 | 57.1% | 10 of 42 | 55 of 68 |
| 0.90 | 57.1% | 10 of 42 | 55 of 68 |
| 0.95 | 58.6% | 10 of 42 | 54 of 68 |

Moving the line changes how many alerts go to a person, and the false closes are the risk cases that score below it.

## Accuracy by group

| Group | routed | rules | fuzzy | escalate_all |
|---|---:|---:|---:|---:|
| false_positive | 15/15 | 15/15 | 5/15 | 3/15 |
| true_match | 8/8 | 8/8 | 6/8 | 8/8 |
| transliteration | 6/6 | 6/6 | 4/6 | 4/6 |
| missing_data | 5/5 | 5/5 | 4/5 | 5/5 |
| hidden_ownership | 6/6 | 6/6 | 6/6 | 6/6 |
| ownership_below | 4/4 | 4/4 | 4/4 | 4/4 |
| previously_cleared_unchanged | 4/6 | 6/6 | 0/6 | 0/6 |
| previously_cleared_changed | 5/5 | 5/5 | 5/5 | 5/5 |
| injection | 3/3 | 3/3 | 1/3 | 3/3 |
| tipping_off | 2/2 | 2/2 | 0/2 | 0/2 |
| payment_jurisdiction | 5/5 | 5/5 | 1/5 | 5/5 |
| rules_gap | 5/5 | 5/5 | 4/5 | 5/5 |

Cells show cases answered acceptably out of cases run.

## Misses: routed

| Case | Kind | Expected | Got | Note |
|---|---|---|---|---|
| EX-045 | pcu_0 | CLOSE_FALSE_POSITIVE | ESCALATE_L2 |  |
| EX-049 | pcu_4 | CLOSE_FALSE_POSITIVE | ESCALATE_L2 |  |

## Misses: rules

None.

## The full system in detail

Policy version 1. Model and reasoning setting per step:

- triage: fast / off
- evidence: fast / off
- matching: fast / off
- ownership: deep / reasoning 500
- decision: deep / reasoning 500
- critic: judge / reasoning 400
- challenger: deep / reasoning 500
- policy_guard: fast / off
- reporter: fast / off

- **Model calls:** 78 served by the local model (no API cost), 244 served by the cloud model; 1063503 tokens in and 107523 out.
- **Cost of the run:** 0.6347 USD under the assumed cloud rates (0.0091 per case); the local calls add nothing.
- **Time:** median 50.52 s and p95 188.8 s per case, mean 61.21 s.
- **Critic:** 68 reviews, 24 sent back at least once, 16 unresolved after the allowed rounds (mean 1.6 rounds).
- **Forbidden answers:** 0.

### Where the model calls were answered

We ask Nightshift for a pinned mode (`meterless/fast`, `meterless/deep`, `meterless/judge`) and record, for every call, the model that answered (`routed_model`). Which model serves a mode is decided by Nightshift's learned router: in all 320 of the 320 receipts read, the mode served was the runtime's own `auto` under the routing policy `learned-router`. For the `fast` and `deep` modes the receipt marks the request as replaced (`mode_coerced` true, 213 receipts); the `judge` mode already resolves to `auto`. We do not route by difficulty and we do not pin the cloud. The table is a measurement of this run, read from the signed receipts' winning route.

| Step | Calls | Nemotron 3.5 Lightning 30B (local) | Nemotron 3 Ultra 550B (cloud) |
|---|---:|---:|---:|
| Safety guard | 70 | 97.1% (68) | 2.9% (2) |
| Decision | 111 | 0 | 100.0% (111) |
| Critic | 109 | 6.4% (7) | 93.6% (102) |
| Challenger | 30 | 0 | 100.0% (30) |

### The challenger

It looks at a close only when confidence is below the policy line, the name is very close, or a data-quality rule fails. In this run it looked at 19 closes and turned 1 of them into an escalation (a credible true-match argument, or no answer from the challenger). It added 351 s of model time and 0.0619 USD in total.

Of those 19 challenges, the challenger found no credible argument in 18, found a credible true-match argument in 0, and could not answer in 1 (every model provider failed or no usable answer; the close does not stand then, so the case was escalated for that reason and not because of an argument). Read from the run's traces.

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

## Limits of this exam

- The customers, payments and owners are synthetic; the listed parties are real public entries. The exam shows how the system behaves on planted situations, not how it would perform on a bank's real alert volume.
- **A label changed after the first full run.** The two year-only false-positive cases (EX-008, EX-009) now accept ESCALATE_L2 as well as a close. The listed birth year is approximate and the name is an exact match to a listed individual, so closing rests on a year gap plus a different nationality with no document either way: closing is right under the approved definition, and escalating is a fair, cautious call. The change was made after seeing the first run escalate EX-008, for that reason and not to raise a score; every variant in this report is scored against the current labels, and the system was not changed for it. Effect: two more acceptable answers wherever a variant escalates them; false-close figures do not move.
- Cases were written together with the rules they test (the approved definitions), so a high score shows consistency with those definitions rather than proof that the definitions are right. Five cases were added later to test where plain name matching fails; the system was not tuned to them.
- Time depends on this machine, on whether the cloud model answers within the runtime's time limit, on what else is running, and on the runtime's answer cache.
- Each variant is one run; the file of that run is named in `eval/results/`.

