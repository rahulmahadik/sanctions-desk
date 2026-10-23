# User guide

The review desk helps a sanctions analyst work screening alerts. For each alert it reads the evidence from the bank's data, compares the customer with the listed party under approved definitions, recommends one of four outcomes, and shows its evidence. **A person makes every decision** unless the policy has switched on automatic closing for the certain cases (see [Autonomy](#autonomy)). The desk never blocks an account, writes to a source system or contacts a customer.

This guide follows the flow in the order you meet it. The same walk-through is on the **Help** page of the desk itself.

## Start it

Needs Docker, nothing else, for sample mode (saved real answers, a labelled stand-in model, no credentials):

```bash
SAMPLE_MODE=true docker compose up --build        # the desk on http://localhost:3001, the API on http://localhost:8000
```

To run it live against Zetaris and Nightshift, follow [Run it live](../README.md#run-it-live) in the README.

## Who you are

Open the desk. In the top bar choose a **Demo user**. Demo users exist only in sample mode, so a visitor can try the whole decision flow without any setup:

| User            | Role                         | Can do                                                                                                                                          |
| --------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| _Visitor_       | viewer                       | read everything, run a review                                                                                                                   |
| `analyst_demo`  | analyst                      | review alerts; approve or override a recommendation with a reason; reopen an automatic close                                                    |
| `approver_demo` | approver (sanctions officer) | everything an analyst can; give the second approval of a block; override towards a less cautious outcome; propose policy changes; stop autonomy |
| `admin_demo`    | policy admin                 | publish a policy change written by someone else; switch autonomy back on                                                                        |

With a live deployment there are no demo users: each person has their own token, kept as a hash in a users file outside the repository. Make one with `npm run users:add -- --file ~/.sanctions-desk/users.json --id olga --role approver`, point `DESK_USERS_FILE` at the file, and the desk asks for the token when you open it. With sign-in on, every route except `/health` needs a token; a viewer can read but not act; an approver cannot approve their own decision; every action is logged under the user's id.

## The alert queue

![The alert queue](screenshots/01-alert-queue.png)

Every alert, with the latest recommendation and where people have taken it: _waiting for a person_, _human-approved_, _block approval pending_, _auto-closed_, or _QA sample_. Filter by type or by reviewed.

## A case

Open an alert and press **Review this alert**. The steps light up from the real events (not a timer): triage, evidence, safety guard, matching or ownership, memory, decision, critic, policy guard, reporter. Each model step shows which model answered and where it ran.

![A case: evidence](screenshots/02-case-evidence.png)
- **Recommendation** and **What decided it**: the outcome, the confidence and the two or three lines that decided the case. The _path_ line says whether code's first finding settled it and the agents confirmed it, or whether free text or missing data meant the agents reasoned over everything.
- **Evidence**: the customer, the listed party, the payment, the data-quality results and the approved definitions that were applied. Identifier numbers are shown as dots: they are masked, and whether one matches a listed number was decided inside Zetaris. A date of birth that came from a verified note is shown as such, with its check reference, never as a value of the customer record.
- **Decision trace**: which approved definition applied, what data the recommendation rests on, who could see what, and what it cost to produce. The record's hash is checked.
- **Replay**: drag the slider to see the run as of any recorded event.

## Decide

![The decision panel](screenshots/03-decision-panel.png)
1. Choose **Approve the recommendation**, or **Override with** another outcome.
2. Write a **reason** (at least 10 characters). It goes in the sealed record.
3. Press the button.

Rules the desk enforces, each tested:
- Only an analyst or an approver can decide. A viewer or a policy admin cannot.
- An override must name a different outcome. An override towards a less cautious outcome (for example from escalation to a close) needs an approver.
- A **block** is never final on one decision. After the first approval it is marked **block approval pending**, and a **second, different approver** must confirm or decline it. Even then it is only a recommendation for the sanctions officer.
- A case that was decided cannot be decided again, and a decision about a recommendation that has since changed is refused (reload and decide again).

The next record is prepared **only after** a decision: a closure note, an escalation ticket, a request for information (a draft, checked so it cannot reveal screening), or a hold instruction (a draft for a payment). They are shown under **Case file: what happens next**, each with its seal. Nothing is sent or executed. A record is **signed** (Ed25519, public key in the configuration, private key outside the repository) only when a signing key is set; otherwise it says it is **hash-sealed**.

Press **Download case file (PDF)** or **(Markdown)** for one document with the recommendation, the facts, what people did, what was prepared next, the models that answered and the record's hash.

Your decision is remembered: the next review of the same customer and listed party sees it as an earlier decision, with who made it and why, and it stays valid until the listed entry changes.

## Which model answered

![Model routing and receipts](screenshots/04-routing-and-receipts.png)

The routing panel lists, for each model step, the mode asked for, the **Nemotron model that answered** (Nemotron 3 Ultra 550B in the cloud, or Nemotron 3.5 Lightning 30B on this machine), the app identity the call was sent under, time, tokens and cost under stated unit costs. **Verify receipt** checks Nightshift's signature on that call and says what it proves. See [MODELS.md](MODELS.md) for how routing works and how to verify a run from the repository.

## Autonomy

![Policy studio](screenshots/05-policy-studio.png)

The **Policy studio** shows how much a person does.
- **Level 0** (the default): a person approves every alert.
- **Level 1**: a close is made without waiting only when code, the decision agent, the critic and the challenger all agree, the evidence standard is met, no data-quality rule fails and the confidence is at least the policy's line. A random share of those (at least 5%) goes to a person as a quality-assurance sample, there is a daily cap, and the **kill switch** (an approver or policy admin) forces level 0 at once. Each automatic close says "closed automatically under policy vX, level 1, conditions met: …", appears in the list for review, and can be **reopened** by an analyst.
- **Locked at every level**: an escalation or a request for information always goes to a person, and a block always needs two different approvers. No setting changes these.

To change autonomy, create a **draft**, press **Preview on the exam** (it shows how many alerts would be closed automatically, how many sampled, and the false closes on the exam, which must be 0), then a _different_ policy admin publishes it. Every step is in the audit log.

## Governance and exam results

![Governance](screenshots/06-governance.png)

The **Governance** page maps the desk to the headings of the Monetary Authority of Singapore's proposed AI risk-management guidelines (a mapping, not a claim of compliance), including human oversight in proportion to risk.

![Exam results](screenshots/07-exam-results.png)

**Exam results** compares the full system with a name-matching baseline and with the deterministic pipeline on the 70 rule-defined cases and on the held-out set the rules were not written for. The method and the limits are in [EVALUATION.md](EVALUATION.md).

## When something goes wrong

| What you see                                             | What it means                                                                           |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| "choose a demo user (the X-Demo-User header) to do this" | In sample mode, deciding or changing policy needs a demo user. Pick one in the top bar. |
| "the recommendation changed since you looked at it"      | Someone reviewed the alert again. Reload the case and decide again.                     |
| "a valid token is required"                              | Sign-in is on. Ask for a token.                                                         |
| "model decision unavailable" on a recommendation         | No model gave a usable answer; the case was escalated for a person, never closed.       |
| Block approval pending                                   | A block has one approval. A different approver must confirm it.                         |

More: the failure-handling table in the [README](../README.md#failure-handling) and [KNOWN_ISSUES.md](KNOWN_ISSUES.md).
