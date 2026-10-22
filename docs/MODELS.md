# Models: roles, routing and how to verify an answer

Every model call goes through one function, `generator`, which talks to **Meterless Nightshift** first (an OpenAI-compatible local runtime that also reaches cloud models), to a local **Ollama** model second, and, in sample mode only, to a clearly labelled rules-based stand-in. Nothing else in the code names a provider.

## What each model does

| Step                   | Model setting (`config/policy.default.json`) | Reasoning                | What it does                                                                                                                                                     | Where it ran in the live exam                                                               |
| ---------------------- | -------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Safety guard, inbound  | `fast`                                       | off                      | Reads the free text that came out of the data (names, notes, payment references) and flags anything that tries to instruct the reviewer. Answers in strict JSON. | Local Nemotron 3.5 Lightning                                                                |
| Safety guard, outbound | `fast`                                       | off                      | Checks a draft meant for a customer against the written tipping-off policy. Answers in strict JSON.                                                              | Local Nemotron 3.5 Lightning                                                                |
| Decision               | `deep`                                       | on, bounded (500 tokens) | Reads the evidence and the approved definitions and recommends one of four outcomes with cited facts.                                                            | Cloud Nemotron 3 Ultra when the runtime routes there, otherwise local; see `eval/REPORT.md` |
| Critic                 | `judge`                                      | on, bounded (400 tokens) | Checks the recommendation for claims the evidence does not support. The cited facts are re-read from the data by code first.                                     | Cloud Nemotron 3 Ultra when the runtime routes there, otherwise local                       |

Triage, evidence reading, matching, ownership, memory and the policy guard are plain code: they call no model. They are listed in the trace like any other step.

**Name matching is deterministic first.** Names are compared with a fold of accents and look-alike letters, token-set Jaro-Winkler scores, a consonant skeleton for spelling variants, initials and legal-form words. Nightshift lists an embedding class and the model `nvidia/nemotron-3-embed-1b`, but this runtime build serves no embedding route (`class_carrier_unsupported`), so embeddings are not used. The matching code does not depend on them.

## How a call is routed

- The code always asks for a **pinned mode** (`meterless/fast`, `meterless/deep`, `meterless/judge`). `meterless/auto` is rejected by the configuration schema.
- A retired mode (HTTP 410, `class_no_route`, or a cloud "Function not found") is retried once on the next configured mode, then the call falls back to Ollama.
- The runtime decides where an answer is computed. Chat requests are served as the runtime's `auto` mode whatever was asked, so every call records both what was **requested** and what **answered** (`model_requested`, `model_routed`, `route_kind` local or cloud, and the mode the runtime says it served).
- Two behaviours of the runtime shaped the prompts: an answer that starts with a `{` prefill is served by the local model in seconds, and prompts worded as a rejection take a much slower route. Decision and Critic therefore ask for brief reasoning with the JSON last on their first try, and fall back to the fast prefill path on the retry.
- Reasoning is bounded because the runtime stops waiting for a slow model after about 45 seconds.

## The model ledger

Every recommendation carries a ledger of the model calls behind it: step, requested and routed model, local or cloud, reasoning on or off with its budget, tokens in and out, latency and the signed receipt.

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

The decision and the critic are Nemotron answers: Nemotron 3 Ultra 550B when the runtime sends them to the cloud lane, Nemotron 3.5 Lightning 30B on the local lane. The safety guard is Nemotron 3.5 Lightning. The ledger shows, for each recommendation, which of them answered each step. Nothing here is hard-coded to a model name: the lanes are configuration.
