# Evaluation

How the desk is measured, what each variant is, and how to run it. The results themselves are in [eval/REPORT.md](../eval/REPORT.md), built from the files in `eval/results/`.

## The headline measure

One measure is used everywhere (the report, the README and the interface), computed by `packages/agents/src/headline.ts` from the cases of an exam run:

| Part                                 | Meaning                                                                                                                                                                                        | Measured or assumed                                                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Closed with evidence                 | Alerts the desk recommended closing as false positives, with the facts cited. A person still confirms each one.                                                                                | Measured                                                                                                                                                                    |
| Escalated                            | Every other recommendation (escalate, block, need more information).                                                                                                                           | Measured                                                                                                                                                                    |
| False-close rate                     | Of the cases where closing is wrong (the true matches and every other risk case), the share the desk recommended closing. Target: 0. Reported for all risk cases and for the true-match group. | Measured                                                                                                                                                                    |
| Analyst minutes saved per 100 alerts | 100 × (share of alerts closed _rightly_) × (minutes per alert − minutes to confirm a close)                                                                                                    | **Assumption**: `report.minutesPerAlert` (15) and `report.minutesToConfirmClose` (2) in `config/default.json`. Escalated alerts get no credit. A wrong close earns nothing. |

## The exam

70 cases built from real public list entries and synthetic customers, payments and owners, in twelve groups: false positives, true matches, transliteration, missing data, hidden ownership at and above 50 percent, ownership below 50 percent, earlier clearances that still hold, earlier clearances that no longer hold, injection, tipping-off drafts, payment routes through watched jurisdictions, and cases where plain name matching is likely to fail (reversed names, aliases, partial birth dates, a birth-date match with another nationality, a watched place named only in the payment reference). Each case has one right answer, acceptable alternatives and answers that must never be given. Edge cases are listed in [EDGE_CASES.md](EDGE_CASES.md).

## Variants

| Variant        | What it is                                                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routed`       | The full system: Nemotron models through Nightshift (Nightshift's router decides which model serves each call), safety guard, decision, critic, challenger, memory, policy guard                                                |
| `single`       | One recommendation: no critic, no challenger, no memory                                                                                                                                                                         |
| `no_memory`    | The full system with memory off, run on the earlier-cleared cases                                                                                                                                                               |
| `local`        | The full system asking for the fast mode only, with no reasoning budget. Nightshift still decides which model serves it, so this is not a guarantee of local answers                                                            |
| `rules`        | The **deterministic pipeline**: our own matching, ownership and policy code with a labelled rules stand-in in place of a language model. It reads the same evidence as the full system, so it shows what the code alone settles |
| `fuzzy`        | The **name-match rules baseline**, which stands for typical screening: a name score at or above 0.90 escalates, below closes, with no ownership, data-quality or evidence reasoning                                             |
| `escalate_all` | Every alert goes to a person                                                                                                                                                                                                    |

## Running

```bash
npm run exam -- --variant routed          # one variant, once; writes eval/results/<time>-<variant>.json
npm run bench -- --variant routed --runs 3 --batch 20     # unattended repeated or random-batch runs
npm run exam:report                       # rebuild eval/REPORT.md and the headline in the README
npm run json:rate                         # how often a model answer could not be used as JSON, from the traces
```

`npm run bench` runs the exam, or random batches of alert cases, any number of times without attention. It writes the usual result file of every run and a summary (`eval/results/bench-*.md` and `.json`): mean and range of accuracy, false-close rate and median time, the model calls by the model that served them, and the model cost, with tokens served by the local model counted and priced at zero. Options: `--runs N`, `--batch K`, `--seed N` (repeat the same random batches), `--name`, `--case-timeout-min`, `--dry-run`, and several variants separated by commas.

Runs that were limited to some cases (a tag, `--kinds`, `--groups` or `--limit`) are kept apart: the report uses only complete runs.

## Reading the numbers

- Each variant in the report is **one run**. Model answers vary between runs.
- The runtime may answer a repeated prompt from its cache; evaluation runs use their own app id so that live use does not warm it, but a second run of the same variant can still be faster and cheaper than the first.
- A case where no model gave a usable decision is escalated with the reason "model decision unavailable". It is counted in the totals and reported separately (provider failure or unusable answer), together with the accuracy without those cases.

## Definition changes

Every change to what the system treats as evidence is listed here with the policy version that introduced it, so a result can be read against the rules in force when it was produced.

| Policy version | Change | Made | Effect on labels |
| --- | --- | --- | --- |
| 2 | **Documentary evidence standard.** A customer note or payment reference counts as documentary evidence only when it carries a check reference, a document number and a date (and, for a payment, a named counterparty). Anything less is a claim and leads to NEED_MORE_INFO. A qualifying note that states a date of birth supplies it when the customer has none on record. | After the main exam runs and before the held-out run | None. Held-out labels are unchanged (freeze commits in `eval/cases/README.md`). |
| 3 | **The standard's wording moved into the approved definitions.** `false_positive@2` is a new row in the semantic layer's `business_definition` table (version 1 is untouched and still listed); the policy now points at it (`evidenceStandard.definition`) instead of repeating the text. A close is refused if the semantic layer does not hold that version as the newest approved one. | After the main exam runs and before the held-out run | None. |

The definition was clarified before the held-out run, and the held-out cases were frozen again afterwards, before any run (third freeze, listed in `eval/cases/README.md`): the four cases whose text is only a claim were relabelled to NEED_MORE_INFO with the reason "labels written before the evidence standard was made explicit; under policy v2 these notes are claims", and four clear cases with documentary text were added. All eight clear cases are then reachable under the standard.

The rule is enforced by the policy guard (`evidence_standard`), which reads the note from the evidence rows rather than from the model's quotation, and it is recorded in every sealed decision record as a guard verdict beside the policy version. Tests cover both sides: `packages/agents/test/evidence-standard.test.ts`, `policy-guard.test.ts`, `documentary-matching.test.ts` and `heldout-standard.test.ts`.
