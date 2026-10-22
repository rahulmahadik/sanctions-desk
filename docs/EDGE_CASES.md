# Edge cases

Each edge case below has an expected outcome and is checked by an exam case, a test, or both. The list lives in `eval/edge-cases.json`; a test checks that every exam case and test named here exists. Regenerate this page with `npm run docs:edge-cases`.

## Names

| Edge case                                                               | Expected                                                               | Checked by                                                                                   |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| The same person written with a different spelling or script             | Escalate when birth date and nationality agree; close when they do not | `tm_variant`<br>`tl_*`<br>`packages/data/test/similarity.test.ts › transliteration variants` |
| Family name written first                                               | Treated as the same name; judged on the other fields                   | `fp_name_order`<br>`packages/data/test/similarity.test.ts › reordered tokens`                |
| A first name given as an initial                                        | An initial stands for any name that starts with it                     | `fp_initials`<br>`packages/data/test/similarity.test.ts › initial`                           |
| A title in front of a name                                              | The title is not part of the name                                      | `fp_honorific`<br>`packages/data/test/compare.test.ts › drops a leading title`               |
| Accents added or removed                                                | Accents do not change the match                                        | `fp_diacritics`<br>`packages/data/test/similarity.test.ts › folding`                         |
| Hyphens and punctuation in names                                        | Punctuation does not change the match                                  | `fp_hyphen`<br>`packages/data/test/text.test.ts › normaliseName`                             |
| Only a common surname is shared                                         | Close as a false positive when birth date and nationality differ       | `fp_surname_only_*`<br>`fp_dob_exact_name_*`                                                 |
| Look-alike Cyrillic or Greek letters inside a Latin name                | Seen through, flagged, and escalated like the real name                | `tm_homoglyph`<br>`packages/data/test/similarity.test.ts › look-alike`                       |
| Legal-form words and spelling of a company name (Ltd, Limited, L.L.C.)  | Compared on the distinctive part of the name                           | `md_company_no_registration`<br>`packages/data/test/compare.test.ts › companyCore`           |
| A listed party with only a birth year, or a customer with no birth date | Year-only conflicts close; a missing date asks for more information    | `fp_year_only_*`<br>`md_no_dob_*`<br>`packages/data/test/compare.test.ts › compareDob`       |
| Same name, clearly different birth date                                 | Close as a false positive when nationality also differs                | `fp_*`<br>`packages/data/test/compare.test.ts › false positive definition`                   |
| A false positive for a customer who lives in a watched jurisdiction     | Policy sends it to a person anyway                                     | `fp_jurisdiction`<br>`packages/agents/test/policy-guard.test.ts › watched jurisdiction`      |

## Ownership

| Edge case                               | Expected                                             | Checked by                                                                                                          |
| --------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| A listed person owns exactly 50 percent | Counts as control; escalate                          | `ho_direct_50`<br>`packages/engines/test/ownership.test.ts › exactly`                                               |
| 49.9 percent                            | Below the threshold; close                           | `ob_49_9`<br>`packages/engines/test/ownership.test.ts › 49.9`                                                       |
| Two listed owners with 25 percent each  | They add up to 50; escalate (24 plus 25 stays below) | `ho_split_25_25`<br>`ob_split_below`<br>`packages/engines/test/ownership.test.ts › adds up different listed owners` |
| Ownership through holding companies     | Percentages multiply along a chain                   | `ho_two_level`<br>`ob_chain_42`<br>`packages/engines/test/ownership.test.ts › chain`                                |
| A chain longer than the policy allows   | Escalate; never guess                                | `ho_depth_limit`<br>`packages/engines/test/ownership.test.ts › depth`                                               |
| Companies that own each other           | The loop is reported and the check still finishes    | `ho_circular`<br>`packages/engines/test/ownership.test.ts › circular`                                               |
| The register gives no percentage        | Unknown, never zero; ask for more information        | `ob_missing_pct`<br>`packages/engines/test/ownership.test.ts › unknown`                                             |

## Lists and memory

| Edge case                                       | Expected                                                                    | Checked by                                                                                                     |
| ----------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A listed entry changes after a case was cleared | The clearance is stale; the case is re-opened                               | `pcc_*`<br>`apps/api/test/review.test.ts › list-change replay`                                                 |
| A listed party is removed from the list         | An escalation that rested on it becomes a candidate for release by a person | `apps/api/test/review.test.ts › removed one for release`<br>`packages/engines/test/rescreen.test.ts › removed` |
| A new alert for a pair that was cleared before  | The earlier clearance is used as context if the entry is unchanged          | `pcu_*`<br>`packages/agents/test/pipeline.test.ts › fast path`                                                 |
| Two memories disagree                           | Conflicts are detected and resolved with a ledger entry                     | `packages/engines/test/hmem.test.ts › conflict`                                                                |
| A person overrides what memory says             | The override wins and is written to the trust ledger                        | `packages/engines/test/pointer-memory.test.ts › override`                                                      |

## Data and systems

| Edge case                                                 | Expected                                                                                          | Checked by                                                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zetaris is slow, down or returns nothing                  | A structured, recoverable error; no invented decision                                             | `packages/zetaris/test/client.test.ts › network failures`<br>`packages/shared/test/http.test.ts › timeout`<br>`apps/api/test/app.test.ts › data service is unreachable` |
| The payments service is down                              | Payment alerts fail with a structured error; customer alerts are unaffected                       | `apps/api/test/app.test.ts › data service is unreachable`                                                                                                               |
| A model returns an empty answer, an error or invalid JSON | One retry on the fast path, then a structured error; a critic that cannot answer approves nothing | `packages/agents/test/model-call.test.ts › falls back`<br>`packages/agents/test/pipeline.test.ts › cannot answer`                                                       |
| The policy changes while a run is in progress             | The run keeps the version it started with                                                         | `apps/api/test/policy-and-events.test.ts › new policy version for runs started after a publish`                                                                         |
| The same alert is reviewed twice at once                  | The second request is refused                                                                     | `apps/api/test/review.test.ts › same alert twice at once`                                                                                                               |
| Very long references and notes                            | Cut to a fixed length in prompts, and said so                                                     | `packages/agents/test/steps.test.ts › long text in a prompt`                                                                                                            |

## Security

| Edge case                                                | Expected                                           | Checked by                                                                    |
| -------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------- |
| Instructions hidden in a name, note or payment reference | Read as data, flagged, and never a reason to close | `inj_*`<br>`packages/agents/test/safety.test.ts › screenInbound`              |
| A draft that tells a customer they are being screened    | Refused                                            | `to_*`<br>`packages/agents/test/safety.test.ts › screenOutbound`              |
| A policy change without a second approver                | Refused                                            | `packages/shared/test/policy-store.test.ts › approver`                        |
| A secret appears in a request or a model answer          | Redacted before anything is written                | `inj_payment_reference_1`<br>`apps/api/test/app.test.ts › rt-never-in-output` |
