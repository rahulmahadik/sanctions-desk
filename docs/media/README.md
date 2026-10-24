# Media

Everything here was made from the running desk in sample mode (saved real Zetaris answers and the labelled rules-based stand-in for the models), light theme. Each page's text was checked for local paths, user names, e-mail addresses and tokens before it was saved.

| File | What it shows |
| --- | --- |
| `architecture.svg`, `architecture.png` | The agents, Zetaris as the only data path, local and cloud Nemotron through Nightshift, the raise-only policy guard and the human decision |
| `screenshots/01-alert-queue.png` | Home: the summary strip (open alerts, recommendations waiting for a person, closes stopped by a check, models used), the list-change panel, the alert list sorted by severity |
| `screenshots/02-case-evidence.png` | A case (ALR-0073): the recommendation banner, the decision panel, the decision trace, the risk signals and the evidence |
| `screenshots/03-decision-panel.png` | The decision panel: approve or override with a reason |
| `screenshots/04-routing-and-receipts.png` | Requested model, routed model and receipt id per call (in sample mode the stand-in makes no model call, so no receipt) |
| `screenshots/05-policy-studio.png` | Policy studio and the autonomy card |
| `screenshots/06-governance.png` | Governance view |
| `screenshots/07-exam-results.png` | Test scores: every held-out round with its baselines, then the 70-case exam |
| `screenshots/08-help.png` | Help |
| `screenshots/09-risk-signals.png` | A risk signal with its source field and the exact span highlighted in the payment reference ("Tehran") |
| `screenshots/10-list-change.png` | Earlier decisions whose listed entry changed, with the list snapshot then and now |
| `screenshots/11-heldout-rounds.png` | The held-out table on its own |
| `screenshots/12-agent-map.png` | The review steps after a review: the screener flagged the case |

Re-take them with the desk running in sample mode (`SAMPLE_MODE=true docker compose up --build`, then review ALR-0004, ALR-0073 and ALR-0058 once):

```bash
npm run screenshots -- --alert ALR-0073 --out docs/media/screenshots
```

## Demo case: a link hidden in a payment reference

Alert **ALR-0073** (exam case EX-064): a payment whose counterparty name equals a listed bank's, with the onward city named only in the payment reference, "Machine parts, onward delivery to Tehran".

```bash
SAMPLE_MODE=true npm run -s case -- input_examples/run-ALR-0073.json
```

In sample mode the local screener step flags `sanctioned_jurisdiction_link` at `payment.payment_reference:34-40` ("Tehran", grounded), the decision is ESCALATE_L2, the critic approves and the policy guard keeps it; the analyst approves with the evidence shown. In the recorded live run of the first system, the decision first recommended a close at 0.95, the critic approved it, and the policy guard blocked it on the watched jurisdiction: see the README's [One real trace](../../README.md#one-real-trace).

## Demo clip: a decision re-opened after a list change

The desk does not re-run a case on an earlier list. What it shows, in sample mode:

1. Home page: press **Check earlier decisions against the list as it is now**. Five earlier closes are listed for review because their listed entry changed, with the list snapshot then and now; DSP-0007 (Yiu-chung Tam) points at **ALR-0058**.
2. Open **ALR-0058** and press **Review this alert**. The answer is Escalate; the memory step reports the earlier clearance as stale.
3. Scroll to **Replay** and drag the slider back to the memory step: "1 earlier decision(s): CLOSE_FALSE_POSITIVE (stale)".
