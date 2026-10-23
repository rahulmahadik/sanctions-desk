import Link from "next/link";

/** What each screen is for, and a two-minute path through the whole decision flow. */
export function Help() {
  return (
    <>
      <section className="panel" aria-labelledby="help-try">
        <h2 id="help-try">Try the whole flow in two minutes</h2>
        <ol>
          <li>
            In the top bar, under <strong>Demo user</strong>, choose <strong>analyst_demo</strong>. (Demo users exist
            only in sample mode; a live deployment asks for a sign-in token instead.)
          </li>
          <li>
            Open the <Link href="/">Alert queue</Link>, pick an alert and press <strong>Review this alert</strong>. The
            steps light up from the real events, and the recommendation appears with the evidence that decided it.
          </li>
          <li>
            In <strong>Decision</strong>, approve the recommendation or override it, and give a reason. Nothing is sent
            or executed: the next record (a closure note, an escalation ticket, a request for information draft, a hold
            instruction) is prepared below, with its seal, for you to read.
          </li>
          <li>
            For a <strong>block</strong>, switch to <strong>approver_demo</strong> and give the second approval. A block
            needs two different people, and it is only ever a recommendation for the sanctions officer.
          </li>
          <li>
            Press <strong>Download case file (PDF)</strong> for one document with the recommendation, the facts, what
            people did, what was prepared next, the models that answered and the record's hash.
          </li>
          <li>
            In <strong>Model routing and cost</strong>, press <strong>Verify receipt</strong> on any step to check the
            signed receipt and see which Nemotron model served the call.
          </li>
        </ol>
      </section>

      <section className="panel" aria-labelledby="help-screens">
        <h2 id="help-screens">The screens</h2>
        <dl className="facts">
          <dt>
            <Link href="/">Alert queue</Link>
          </dt>
          <dd>
            Every alert, with the latest recommendation and where people have taken it: waiting for a person,
            human-approved, block approval pending, auto-closed, or picked as a quality-assurance sample.
          </dd>
          <dt>Case</dt>
          <dd>
            The live run, the recommendation and what decided it, the decision panel, the four-question decision trace,
            the evidence (identifier numbers masked), the model routing and cost with receipt checks, and a replay
            slider.
          </dd>
          <dt>
            <Link href="/policy">Policy studio</Link>
          </dt>
          <dd>
            How much a person does. Level 0 is the default: a person approves every alert. Level 1 lets a close the desk
            is certain of be closed without waiting, with a daily cap, a random quality-assurance sample and a kill
            switch. A change is a draft, previewed on the exam, then published by a different policy admin.
          </dd>
          <dt>
            <Link href="/exam">Exam results</Link>
          </dt>
          <dd>The variants compared on the exam, with false closes, the results by group and the held-out set.</dd>
          <dt>
            <Link href="/governance">Governance</Link>
          </dt>
          <dd>
            The model's inventory, risk materiality, human oversight in proportion to risk, testing, monitoring and
            change control.
          </dd>
        </dl>
      </section>

      <section className="panel" aria-labelledby="help-rules">
        <h2 id="help-rules">What never changes</h2>
        <ul>
          <li>The desk recommends. It never blocks an account, writes to a source system or contacts a customer.</li>
          <li>An escalation or a request for information always goes to a person, whatever the autonomy setting.</li>
          <li>A recommended block needs two different approvers.</li>
          <li>Text in the data that tries to instruct the desk is treated as data and can never close a case.</li>
          <li>Every model call carries a signed receipt, so which Nemotron model answered can be checked.</li>
        </ul>
        <p className="muted">
          More detail is in the user guide in the repository (<code>docs/USER_GUIDE.md</code>) and the README.
        </p>
      </section>
    </>
  );
}
