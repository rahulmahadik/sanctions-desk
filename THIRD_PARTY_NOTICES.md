# Third-party notices

sanctions-desk is licensed under Apache-2.0 (see `LICENSE`).

## Meterless engines (planned, milestone M4)

The memory, entity-graph and long-run engines in `packages/engines/` will be implemented from the
public Meterless engine specifications (`AGENTS.md` in each engine folder) using the Meterless
reference implementations as a guide.

- Source: https://github.com/Meterless/Meterless
- Licence: Apache License 2.0
- Engines: H-MEM, World Model, Markovian
- Changes: re-implemented in TypeScript against our own storage; each derived file carries a header
  "Derived from Meterless <engine> reference, Apache-2.0" and states what was changed.

Nothing from that repository has been copied into this project yet.

## Public data sources (planned, milestone M1)

| Data | Publisher | Terms |
|---|---|---|
| OFAC SDN and consolidated lists | US Treasury, OFAC | Public domain / CC0 per the OFAC data catalogue |
| UN Security Council consolidated list | United Nations | Public list, no key required |
| GLEIF LEI records and relationships | GLEIF | Open data; terms to be confirmed before the deck |

All customer, payment and ownership data in this project is synthetic and labelled as such.

## npm dependencies

Runtime and development dependencies are listed in `package.json` and `package-lock.json`.
