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
- Scout Intent (`packages/engines/src/scout-intent`): written for this project from the public Meterless Scout Intent
  specification (Apache-2.0), which publishes no reference code; its official eval harness is copied without change into
  `packages/engines/conformance/scout-intent/`.
- The domain adapters in `packages/engines/src/domain` are original to this project.

## Public data sources

| Data                                  | Publisher         | Terms                                                                                                                                             |
| ------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| OFAC SDN and consolidated lists       | US Treasury, OFAC | Public domain / CC0 per the OFAC data catalogue                                                                                                   |
| UN Security Council consolidated list | United Nations    | Public list, no key required                                                                                                                      |
| GLEIF LEI records and relationships   | GLEIF             | CC0 1.0. "The data available through the Access Service are provided under the CC0 licence" (https://www.gleif.org/en/meta/lei-data-terms-of-use) |

All customer, payment and ownership data in this project is synthetic and labelled as such.

## Fonts on the documentation site

The site serves its own copies of two fonts, so no page calls a font service:
- **Inter** (variable, Latin subset), Copyright 2016 The Inter Project Authors, SIL Open Font License 1.1: `site/fonts/inter-latin-variable.woff2`, licence in `site/fonts/OFL-Inter.txt`.
- **JetBrains Mono** (weights 400 and 500, Latin subset), Copyright 2020 The JetBrains Mono Project Authors, SIL Open Font License 1.1: `site/fonts/jetbrains-mono-latin-400-normal.woff2` and `-500-normal.woff2`, licence in `site/fonts/OFL-JetBrainsMono.txt`.

The font files were taken unmodified from the Fontsource packages `@fontsource-variable/inter` 5.3.0 and `@fontsource/jetbrains-mono` 5.3.0.

## npm dependencies

Runtime and development dependencies are listed in `package.json` and `package-lock.json`. Each is used
under its own open-source licence.
