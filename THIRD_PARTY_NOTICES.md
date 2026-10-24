# Third-party notices

Sanctions Desk is licensed under Apache-2.0 (see `LICENSE`).

## Meterless engines

The memory, entity-graph and long-run engines in `packages/engines` are derived from the Meterless
reference implementations (Apache-2.0) and follow the public Meterless engine specifications
(`AGENTS.md` in each engine folder).
- Source: https://github.com/Meterless/Meterless
- Licence: Apache License 2.0
- H-MEM (`packages/engines/src/hmem`): derived from the Meterless H-MEM reference implementation (Apache-2.0).
- World Model (`packages/engines/src/world-model`): derived from the Meterless World Model reference
  implementation (Apache-2.0).
- Markovian (`packages/engines/src/markovian`): derived from the Meterless Markovian reference
  implementation (Apache-2.0).
- Changes: ported to strict TypeScript for this repository's compiler and lint settings, split into smaller
  modules, and the World Model uses `node:crypto` for SHA-256. Each derived file carries the header
  "Derived from the Meterless <engine> reference implementation, Apache-2.0". Behaviour is checked with the
  official conformance runners (`npm run test:engines`) and with this repository's own tests.
- The official conformance suites are copied without change into `packages/engines/conformance/` (see `NOTICE`,
  `packages/engines/conformance/SOURCE.md` and the licence text beside them) and run against these engines by
  `npm run test:engines`, by `npm test` and in CI.
- The domain adapters in `packages/engines/src/domain` are original to this project.

## Public data sources

| Data                                  | Publisher         | Terms                                                                                                                                             |
| ------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| OFAC SDN and consolidated lists       | US Treasury, OFAC | Public domain / CC0 per the OFAC data catalogue                                                                                                   |
| UN Security Council consolidated list | United Nations    | Public list, no key required                                                                                                                      |
| GLEIF LEI records and relationships   | GLEIF             | CC0 1.0. "The data available through the Access Service are provided under the CC0 licence" (https://www.gleif.org/en/meta/lei-data-terms-of-use) |

All customer, payment and ownership data in this project is synthetic and labelled as such.

## npm dependencies

Runtime and development dependencies are listed in `package.json` and `package-lock.json`. Each is used
under its own open-source licence.
