# Third-party notices

sanctions-desk is licensed under Apache-2.0 (see `LICENSE`).

## Meterless engines

Planned. The memory, entity-graph and long-run engines will be derived from the Meterless reference
implementations (Apache-2.0) and implemented against the public Meterless engine specifications
(`AGENTS.md` in each engine folder).
- Source: https://github.com/Meterless/Meterless
- Licence: Apache License 2.0
- Engines: H-MEM, World Model, Markovian
- Changes: re-implemented in TypeScript against this project's own storage. Any file derived from a
  Meterless reference file will carry the header "Derived from Meterless <engine> reference, Apache-2.0"
  and state what was changed.

No Meterless source code is included in this repository yet.

## Public data sources

| Data                                  | Publisher         | Terms                                           |
| ------------------------------------- | ----------------- | ----------------------------------------------- |
| OFAC SDN and consolidated lists       | US Treasury, OFAC | Public domain / CC0 per the OFAC data catalogue |
| UN Security Council consolidated list | United Nations    | Public list, no key required                    |
| GLEIF LEI records and relationships   | GLEIF             | Licence to be confirmed                         |

All customer, payment and ownership data in this project is synthetic and labelled as such.

## npm dependencies

Runtime and development dependencies are listed in `package.json` and `package-lock.json`. Each is used
under its own open-source licence.
