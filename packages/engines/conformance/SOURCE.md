# Conformance suites (vendored)

The three runners in this folder are the official conformance suites of the Meterless engines, copied without
change so that this repository can check its own engines without any other checkout.

| Suite | File | Checks |
| --- | --- | --- |
| H-MEM | `hmem/runner.ts`, `hmem/vectors/vectors.json` | 13 |
| World Model | `world-model/runner.ts` | 8 |
| Markovian | `markovian/runner.ts` | 8 |
| Scout Intent | `scout-intent/runner/index.ts`, `config/`, `fixtures/`, `regression-set/v1/` (from `engines/scout-intent/evals/`) | eval gate on 32 examples |

- Source: the Meterless engines repository, `engines/<engine>/conformance/` (Apache License 2.0; the licence text is in
  `LICENSE` beside this file).
- Version copied: commit `1742dec56a66e58eef9dda2d2b865823758ca8cd` (19 October 2026).
- Modifications: none. The files are excluded from this repository's formatter and linter so that they stay
  identical to the source.
- How they are used: each runner loads an implementation from an environment variable (`HMEM_IMPL`,
  `WORLD_MODEL_IMPL`, `MARKOVIAN_IMPL`). `npm run test:engines` points them at `packages/engines/src/*`, and
  `packages/engines/test/conformance.test.ts` runs the same thing as part of `npm test` and in CI.
- To run against a newer upstream copy: `METERLESS_ENGINES_DIR=/path/to/meterless-engines npm run test:engines`.
