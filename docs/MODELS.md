# Models: roles, routing and how to verify an answer

Every model call goes through one function, `generator`, which talks to **Meterless Nightshift** first (an OpenAI-compatible local runtime that also reaches cloud models), to a local **Ollama** model second, and, in sample mode only, to a clearly labelled rules-based stand-in. Nothing else in the code names a provider.

## What each model does

| Step                   | Mode we ask for (`config/policy.default.json`) | Reasoning budget (ours) | What it does                                                                                                                                                                                                                                                                                                                                           | Where it ran in the live exam                                                               |
| ---------------------- | ---------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Safety guard, inbound  | `fast`                                         | none                    | Reads the free text that came out of the data (names, notes, payment references) and flags anything that tries to instruct the reviewer. Answers in strict JSON.                                                                                                                                                                                       | Local Nemotron 3.5 Lightning                                                                |
| Safety guard, outbound | `fast`                                         | none                    | Checks a draft meant for a customer against the written tipping-off policy. Answers in strict JSON.                                                                                                                                                                                                                                                    | Local Nemotron 3.5 Lightning                                                                |
| Decision               | `deep`                                         | 500 tokens              | Reads the evidence and the approved definitions and recommends one of four outcomes with cited facts.                                                                                                                                                                                                                                                  | Cloud Nemotron 3 Ultra when the runtime routes there, otherwise local; see `eval/REPORT.md` |
| Critic                 | `judge`                                        | 400 tokens              | Checks the recommendation for claims the evidence does not support. The cited facts are re-read from the data by code first.                                                                                                                                                                                                                           | Cloud Nemotron 3 Ultra when the runtime routes there, otherwise local                       |
| Challenger             | `deep`                                         | 500 tokens              | Runs only on a close that could slip through (confidence below the policy line, a name similarity at or above it, or a failing data-quality rule). Argues the strongest honest case that the customer is the listed party; a credible argument turns the close into an escalation with its reason shown. If it cannot answer, the close does not stand | Cloud Nemotron 3 Ultra when the runtime routes there, otherwise local                       |

Decision, critic and challenger ask for **schema-constrained JSON** (`response_format` of type `json_schema`, strict): the model reasons in an `analysis` field that comes first and the answer is held to the schema, so there is no reasoning text to cut off before the JSON. Nightshift honours it on the fast and deep modes (tried first against `json_object`, which was not reliable on the deep mode, and against `guided_json`, which it ignored). The old way, reasoning then JSON last, remains behind `structuredOutput: false` in the policy. If a try gives no usable answer it is repeated on the fast mode and then on the Ollama backup; if every try fails, the decision step escalates the case with the reason "model decision unavailable", and the report counts provider failures and unusable answers separately.

Triage, evidence reading, matching, ownership, memory and the policy guard are plain code: they call no model. They are listed in the trace like any other step.

**Name matching is deterministic first.** Names are compared with a fold of accents and look-alike letters, token-set Jaro-Winkler scores, a consonant skeleton for spelling variants, initials and legal-form words. Nightshift lists an embedding class and the model `nvidia/nemotron-3-embed-1b`, but this runtime build serves no embedding route (`class_carrier_unsupported`), so embeddings are not used. The matching code does not depend on them.

## How a call is routed

- The code always asks for a **pinned mode** (`meterless/fast`, `meterless/deep`, `meterless/judge`). `meterless/auto` is rejected by the configuration schema. We do not route by difficulty and we do not pin the cloud.
- **Which model serves a mode is Nightshift's decision.** Its learned router chooses: in every receipt the mode served is the runtime's own `auto` under the routing policy `learned-router` (for `fast` and `deep` the receipt marks the request as replaced, `mode_coerced` true; `judge` already resolves to `auto`). So each call records both what was **requested** and what **answered** (`model_requested` and `model_routed`, with `route_kind` local or cloud as the receipt reports it, and the mode the runtime says it served).
- A retired mode (HTTP 410, `class_no_route`, or a cloud "Function not found") is retried once on the next configured mode, then the call falls back to Ollama.
- A try that gives no usable answer is repeated on the fast mode and then on the Ollama backup, with a short pause after a provider failure.
- **The reasoning budget is ours, not a model parameter.** It is a token limit for the answer plus an instruction to put brief reasoning in the answer's `analysis` field. Nothing is sent to Nightshift to switch thinking on, and the runtime stops waiting for a slow model after about 45 seconds, which is why the budget is small.

## The model ledger

Every recommendation carries a ledger of the model calls behind it: step, the mode asked for and the model that answered (cloud or local), reasoning budget, tokens in and out, latency and the signed receipt.

```bash
npm run ledger -- --case ALR-0004      # or:  npm run ledger -- <run id>
```

or over HTTP: `GET /cases/:alertId/trace`. Costs use the unit costs in `config/default.json` (`costs`), which are assumptions for comparing routes, not prices.

## Verifying a receipt

Nightshift signs a receipt for every answer (Ed25519 over the sorted-key JSON of its body). The full signed receipt is stored next to the trace in `logs/receipts/<receipt id>.json`, and its status is in the ledger:

| Status                  | Meaning                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `valid_pinned`          | The signature is valid and the key is one you pinned.                                                                    |
| `valid_unpinned`        | The signature is valid but the key came from the same response: it shows the receipt was not altered, not who signed it. |
| `invalid` / `malformed` | The receipt does not check out.                                                                                          |

To pin the runtime's key: `npm run receipt:pubkey` prints the public key (and nothing secret). Put it in `METERLESS_RECEIPT_PUBLIC_KEY`, or for this machine only in the git-ignored `config/local.json`:

```json
{ "nightshift": { "receiptPublicKeys": ["<printed key>"] } }
```

Pinning the key printed by the runtime trusts it on first use. Compare it with a key you obtained another way if that matters to you.

## Where NVIDIA's models contribute

The decision, the critic and the challenger are Nemotron answers. Which Nemotron model answers is Nightshift's choice, so the split is measured from the receipts and shown in [the exam report](../eval/REPORT.md#where-the-model-calls-were-answered) and in the README: in the final full routed run, read from the receipts, the decision calls were 100% Nemotron 3 Ultra 550B (cloud), the critic calls 93.6% Ultra and 6.4% Lightning, the challenger 100% Ultra, and the safety guard 97.1% Lightning (local) and 2.9% Ultra ([the report](../eval/REPORT.md#where-the-model-calls-were-answered) has the counts). The ledger shows, for each recommendation, which of them answered each step. Nothing here is hard-coded to a model name: the modes are configuration.
