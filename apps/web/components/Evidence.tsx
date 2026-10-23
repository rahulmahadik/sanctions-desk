import { MASK, show } from "../lib/format";
import type { EvidenceView, Row } from "../lib/types";

function Facts({ row, columns, masked }: { row: Row | null; columns: string[]; masked: readonly string[] }) {
  if (!row) return <p className="muted">Not part of this case.</p>;
  return (
    <dl className="facts">
      {columns.map((c) => (
        <div key={c} style={{ display: "contents" }}>
          <dt>{c.replaceAll("_", " ")}</dt>
          <dd className={masked.includes(c) ? "masked" : undefined}>{show(row, c, masked)}</dd>
        </div>
      ))}
    </dl>
  );
}

const maskedOf = (view: EvidenceView, table: string): string[] =>
  view.queries.filter((q) => q.table.endsWith(`.${table}`)).flatMap((q) => q.masked_columns);

/** The facts a case rests on. Columns the evidence role may not see are drawn as dots. */
export function EvidenceCards({ view }: { view: EvidenceView }) {
  const idMask = maskedOf(view, "customer_identifier");
  return (
    <section aria-labelledby="evidence-title">
      <h2 id="evidence-title">Evidence</h2>
      <div className="grid">
        <article className="panel" aria-label="Customer">
          <h2>Customer</h2>
          <Facts
            row={view.customer}
            masked={[]}
            columns={[
              "customer_id",
              "customer_type",
              "full_name",
              "date_of_birth",
              "nationality",
              "residence_country",
              "notes",
            ]}
          />
          <h2 style={{ marginTop: 12 }}>Identifiers held</h2>
          {view.customer_identifiers.length === 0 ? (
            <p className="muted">None on file.</p>
          ) : (
            <ul>
              {view.customer_identifiers.map((r, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: identifier rows have no stable id of their own
                <li key={i}>
                  {show(r, "id_type")}:{" "}
                  <span className="masked">{idMask.includes("id_number") ? MASK : show(r, "id_number")}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="muted">
            Identifier numbers are masked for the evidence role.{" "}
            {view.identifier_overlap.length > 0
              ? `A number matches a listed one (${view.identifier_overlap.join(", ")}); the comparison ran inside Zetaris.`
              : "No identifier matches a listed one."}
          </p>
        </article>

        <article className="panel" aria-label="Listed party">
          <h2>Listed party</h2>
          <Facts
            row={view.list_entry}
            masked={[]}
            columns={["entry_id", "list_id", "party_kind", "primary_name", "listed_on", "remarks"]}
          />
          <p className="muted">Aliases: {view.list_aliases.map((a) => show(a, "alias_name")).join("; ") || "none"}</p>
          <p className="muted">
            Dates of birth: {view.list_dobs.map((d) => show(d, "dob_value")).join("; ") || "none"}
          </p>
          <p className="muted">
            Countries:{" "}
            {view.list_countries.map((c) => `${show(c, "country_name")} (${show(c, "role")})`).join("; ") || "none"}
          </p>
        </article>

        {view.payment ? (
          <article className="panel" aria-label="Payment">
            <h2>Payment</h2>
            <Facts
              row={view.payment}
              masked={[]}
              columns={[
                "payment_id",
                "counterparty_name",
                "counterparty_country",
                "beneficiary_bank_country",
                "intermediary_bank_country",
                "amount",
                "currency",
                "payment_reference",
              ]}
            />
          </article>
        ) : null}

        <article className="panel" aria-label="Data quality and definitions">
          <h2>Data quality</h2>
          {view.data_quality.length === 0 ? (
            <p className="muted">Every data-quality rule passes for these records.</p>
          ) : (
            <ul>
              {view.data_quality.map((d) => (
                <li key={`${d.table}-${d.rule}`} className={d.failed ? "tone-stop" : undefined}>
                  {d.table}: {d.rule} {d.failed ? "fails" : "passes"}
                </li>
              ))}
            </ul>
          )}
          <h2 style={{ marginTop: 12 }}>Approved definitions read</h2>
          <ul>
            {view.definitions.map((d) => (
              <li key={d.definition_id}>
                {d.definition_id.replaceAll("_", " ")} (version {d.version})
              </li>
            ))}
          </ul>
        </article>
      </div>
    </section>
  );
}
