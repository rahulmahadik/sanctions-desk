## Which Nemotron model does what, and why

The decision step is answered by whichever Nemotron model the Nightshift router picks for the call (Nemotron 3 Ultra 550B in the cloud, or Nemotron 3.5 Lightning 30B on this machine); the safety guard is meant to be bound to the local model in the cockpit, but this run did not record its binds. The comparison below groups each case by the model that answered its final decision call, from the sealed records. **The router, not this study, chooses the model, so the groups are not a controlled experiment**: if harder cases go to one model more often, the groups differ for that reason too. A group with few cases says little.

Scored against the labels at the time of the run (23 Oct 2026); under the current label of EX-043 this run's close of EX-043 is a false close.

### main exam, full system (2026-10-23T04-52-42-248Z-routed.json)

| Decision answered by                       | Cases | Exact | Acceptable | False closes | Wrong citations caught | Median s |  Mean cost |
| ------------------------------------------ | ----: | ----: | ---------: | -----------: | ---------------------: | -------: | ---------: |
| answered by Nemotron 3 Ultra (cloud)       |    67 |    42 |         64 |            0 |                     54 |       51 | 0.0094 USD |
| answered by Nemotron 3.5 Lightning (local) |     1 |     1 |          1 |            0 |                      0 |       57 | 0.0118 USD |
