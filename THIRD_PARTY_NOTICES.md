# Third-party notices

sanctions-desk is licensed under Apache-2.0 (see `LICENSE`).

## Meterless engines

The memory, entity-graph and long-run engines are implemented against the public Meterless engine
specifications (`AGENTS.md` in each engine folder), using the Meterless reference implementations as a
guide.
- Source: https://github.com/Meterless/Meterless
- Licence: Apache License 2.0
- Engines: H-MEM, World Model, Markovian
- Changes: re-implemented in TypeScript against this project's own storage. Any file derived from a
  Meterless reference file carries the header "Derived from Meterless <engine> reference, Apache-2.0"
  and states what was changed.

## Public data sources

| Data                                  | Publisher         | Terms                                           |
| ------------------------------------- | ----------------- | ----------------------------------------------- |
| OFAC SDN and consolidated lists       | US Treasury, OFAC | Public domain / CC0 per the OFAC data catalogue |
| UN Security Council consolidated list | United Nations    | Public list, no key required                    |
| GLEIF LEI records and relationships   | GLEIF             | Open data (CC0)                                 |

All customer, payment and ownership data in this project is synthetic and labelled as such.

## npm dependencies

Runtime and development dependencies are listed in `package.json` and `package-lock.json`. Each is used
under its own open-source licence.
