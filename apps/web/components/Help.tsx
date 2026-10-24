import Link from "next/link";
import type { ReactNode } from "react";
import { REASON_LENGTH } from "../lib/format";

/** The same steps, in the same order and words, as docs/USER_GUIDE.md, in fewer words. */
export const HELP_SECTIONS: { id: string; title: string }[] = [
  { id: "help-start", title: "Start it" },
  { id: "help-user", title: "Choose a demo user" },
  { id: "help-queue", title: "The alert queue" },
  { id: "help-review", title: "Open a case and review" },
  { id: "help-result", title: "Read the result" },
  { id: "help-decide", title: "Decide" },
  { id: "help-next", title: "What happens next" },
  { id: "help-autonomy", title: "Autonomy and the kill switch" },
  { id: "help-policy", title: "Change the policy" },
  { id: "help-exam", title: "Exam results and governance" },
  { id: "help-wrong", title: "When something goes wrong" },
];

const title = (id: string) => HELP_SECTIONS.find((s) => s.id === id)?.title ?? id;

function Section({ id, children }: { id: string; children: ReactNode }) {
  return (
    <section className="panel" aria-labelledby={id}>
      <h2 id={id}>{title(id)}</h2>
      {children}
    </section>
  );
}

/** A short walk through the desk, in the order a first-time user meets things. */
export function Help() {
  return (
    <>
      <Section id="help-start">
        <p>
          Sample mode needs Docker and nothing else: <code>SAMPLE_MODE=true docker compose up --build</code>, then open
          http://localhost:3001. To run it live, see Run it live in docs/SETUP.md. The full guide is{" "}
          <code>docs/USER_GUIDE.md</code>.
        </p>
      </Section>

      <Section id="help-user">
        <p>
          In the top bar, under <strong>Demo user</strong>, choose <strong>analyst_demo</strong> to approve or override,{" "}
          <strong>approver_demo</strong> to give a second approval or stop autonomy, or <strong>admin_demo</strong> to
          publish a policy change. <strong>Visitor</strong> can read and run a review. Demo users exist only in sample
          mode; a live deployment asks for a sign-in token.
        </p>
      </Section>

      <Section id="help-queue">
        <p>
          The <Link href="/">Alert queue</Link> lists every alert with its latest recommendation and where people have
          taken it: waiting for a person, human-approved, block approval pending, auto-closed or QA sample. Filter by
          type or by reviewed. Click an alert to open it.
        </p>
      </Section>

      <Section id="help-review">
        <p>
          Press <strong>Review this alert</strong>. The steps light up from the real events, not a timer.
        </p>
      </Section>

      <Section id="help-result">
        <ul>
          <li>
            <strong>Recommendation</strong>: the outcome, the confidence, what decided it and what would change it.
          </li>
          <li>
            <strong>Evidence</strong>: the customer, the listed party, the payment, the data-quality results and the
            approved definitions. Identifier numbers are masked.
          </li>
          <li>
            <strong>Decision trace</strong>: which definition applied, what data it rests on, who could see what, what
            it cost, and whether the record's hash checks.
          </li>
          <li>
            <strong>Replay</strong>: drag the slider to see the run as of any recorded event.
          </li>
          <li>
            <strong>Model routing and cost</strong>: which model answered each step. Press{" "}
            <strong>Verify receipt</strong> to check one call's signature, or <strong>Verify all receipts</strong> to
            check every call and count how many name a Nemotron model.
          </li>
        </ul>
      </Section>

      <Section id="help-decide">
        <ol>
          <li>
            Choose <strong>Approve the recommendation</strong>, or <strong>Override with</strong> another outcome.
          </li>
          <li>Write a reason of at least {REASON_LENGTH.min} characters.</li>
          <li>
            Press <strong>Approve</strong> or <strong>Override</strong>.
          </li>
        </ol>
        <ul>
          <li>Only an analyst or an approver can decide.</li>
          <li>An override towards a less cautious outcome needs an approver.</li>
          <li>
            A <strong>block</strong> is marked block approval pending after the first approval. A second, different
            approver must press <strong>Give the second approval</strong> or <strong>Decline the block</strong>. It is
            still only a recommendation for the sanctions officer.
          </li>
        </ul>
      </Section>

      <Section id="help-next">
        <p>
          After a decision, <strong>Case file: what happens next</strong> shows the prepared record: a closure note, an
          escalation ticket, a request for information draft or a hold instruction draft, each with its seal. Nothing is
          sent or executed. Press <strong>Download case file (PDF)</strong> or <strong>(Markdown)</strong> for one
          document with the recommendation, the facts, what people did, the models that answered and the record's hash.
        </p>
      </Section>

      <Section id="help-autonomy">
        <ul>
          <li>
            <strong>Level 0</strong> is the default: a person approves every alert.
          </li>
          <li>
            <strong>Level 1</strong> closes an alert without waiting only when every check agrees. A random share, at
            least 5%, still goes to a person as a quality-assurance sample, and there is a daily cap. An analyst can
            reopen an automatic close.
          </li>
          <li>
            <strong>Kill switch</strong>: an approver or a policy admin presses{" "}
            <strong>Kill switch: force level 0 now</strong>. A policy admin switches autonomy back on.
          </li>
          <li>
            An escalation or a request for information always goes to a person, and a block always needs two approvers.
          </li>
        </ul>
      </Section>

      <Section id="help-policy">
        <p>
          On the <Link href="/policy">Policy studio</Link>, under <strong>Change autonomy</strong>:
        </p>
        <ol>
          <li>
            <strong>Create a draft</strong> with a level, a confidence line, a sample rate, a daily cap and a reason.
          </li>
          <li>
            Press <strong>Preview on the exam</strong>. False closes must be 0.
          </li>
          <li>A different policy admin presses Publish. The author of a draft cannot publish it.</li>
        </ol>
      </Section>

      <Section id="help-exam">
        <p>
          <Link href="/governance">Governance</Link> maps the desk to the proposed AI risk-management headings; it is
          not a claim of compliance. <Link href="/exam">Exam results</Link> compares the variants on the exam, with
          false closes and results by case group.
        </p>
      </Section>

      <Section id="help-wrong">
        <ul>
          <li>No decision buttons: choose a demo user in the top bar, or sign in.</li>
          <li>The recommendation changed since you looked at it: reload the case and decide again.</li>
          <li>No recommendation, or model decision unavailable: the case goes to a person and is never closed.</li>
          <li>A receipt shows Not verified: the signature does not match. Do not rely on that call.</li>
        </ul>
        <p className="muted">
          The desk recommends. It never blocks an account, writes to a source system or contacts a customer. More detail
          is in the README.
        </p>
      </Section>
    </>
  );
}
