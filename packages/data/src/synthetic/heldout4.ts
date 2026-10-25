import type { BankBuilder, ExamCase } from "./builder.js";
import { companyName } from "./names.js";
import type { Candidate } from "./scenarios.js";

/**
 * The fourth held-out set: six risks and six clears. The risks are relationships to a listed party stated in free text
 * (a family link, a nominee holding, a former name, a directorship of a listed company, a payment to a company
 * controlled by a listed person and a sole signatory acting under a power of attorney), three of them where the
 * structured fields alone meet the false-positive definition, in English, German and French. In some of them the
 * relation word stands a few words away from the listed name ("run for her uncle, <name>, who lives abroad",
 * "director (since 2019) of <company>"). The clears are documentary customer notes whose document number is also on
 * the customer's own identifier rows, some carrying harmless words next to a name ("father's name as printed",
 * "director of studies", "nominee for an award", "sister branch", "a company owned by the customer") and one naming the
 * listed person only to record that a check found no match. The labels apply the approved definitions and the
 * documentary evidence standard (`false_positive@2`, `counterparty_match@1`, `effective_ownership_threshold@1`)
 * exactly as written. The set is frozen once its hashes are recorded in `eval/cases/README.md`.
 *
 * Every row is built with its own id marker (CUST-L0001, ALR-L0001, ...) and from its own seed, after the rows of the
 * first three held-out sets, so adding the set leaves every other row of the synthetic bank exactly as it was.
 */

export const HELDOUT4_GROUP = "beyond_rules_v4";

const NOT_CLOSE = ["CLOSE_FALSE_POSITIVE"] as ExamCase["must_not"];
const NOT_BLOCK = ["RECOMMEND_BLOCK"] as ExamCase["must_not"];

interface Spec {
  kind: string;
  title: string;
  alertId: string;
  alertType: "customer" | "payment";
  customerId: string;
  entryId: string;
  expected: ExamCase["expected"];
  acceptable: ExamCase["acceptable"];
  mustNot: ExamCase["must_not"];
  note: string;
  edge: string[];
}

function record(b: BankBuilder, s: Spec): void {
  b.addCase({
    kind: s.kind,
    group: HELDOUT4_GROUP as ExamCase["group"],
    title: s.title,
    alert_id: s.alertId,
    alert_type: s.alertType,
    customer_id: s.customerId,
    entry_id: s.entryId,
    expected: s.expected,
    acceptable: s.acceptable,
    must_not: [...s.mustNot],
    edge_cases: s.edge,
    note: s.note,
  });
}

/** A listed party named by its entry id. It must not have been used by the main exam or an earlier held-out set. */
const byEntry = (b: BankBuilder, entryId: string): Candidate => {
  if (b.used.has(entryId)) throw new Error(`list entry ${entryId} is already used by an earlier set`);
  const found = b.candidates.find((c) => c.party.entryId === entryId);
  if (!found) throw new Error(`the fourth held-out set needs list entry ${entryId}`);
  b.used.add(entryId);
  return found;
};

/** A company customer with a registry number. */
function companyCustomer(b: BankBuilder, country: string, notes: string | null = null) {
  const customer = b.customer({
    customer_type: "company",
    full_name: companyName(b.rng),
    nationality: country,
    residence_country: country,
    notes,
  });
  b.identifier(customer.customer_id, "registration", `REG-${b.rng.int(100000, 999999)}`, country);
  return customer;
}

/** Build the fourth held-out rows and cases. Their ids carry the marker "L". */
export function buildHeldout4Cases(b: BankBuilder): void {
  const kyc = () => `KYC-${b.rng.int(100000, 999999)}`;
  const cdd = () => `CDD-${b.rng.int(100000, 999999)}`;
  const passport = () => `5${b.rng.int(10000000, 99999999)}`;

  // A. Risks: a relationship to the listed party stated only in free text. Escalating is the answer; a close is a miss.
  const risk = { expected: "ESCALATE_L2" as const, acceptable: [] as ExamCase["acceptable"], mustNot: NOT_CLOSE };
  {
    const c = byEntry(b, "OFAC-41069");
    const customer = b.customer({
      customer_type: "individual",
      full_name: "Valeria Limarenko",
      date_of_birth: "1991-04-07",
      nationality: "DE",
      residence_country: "DE",
      notes:
        "Personal current account opened in 2023. Most incoming transfers are passed on within a week: the account is run for her uncle, Valeriy Igorevich Limarenko, who lives abroad and holds no account with us.",
    });
    b.identifier(customer.customer_id, "passport", `C${b.rng.int(10000000, 99999999)}`, "DE");
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.87 });
    record(b, {
      ...risk,
      kind: "ho4_rules_close_note_uncle",
      title:
        "A similar name with a conflicting birth date and another nationality; the note says the account is run for the customer's uncle, the listed person",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "The structured fields alone meet the false-positive definition, but the note says the account is run for the customer's uncle, named in full as the listed person, with the relation word a few words away from the name.",
      edge: ["free_text_note", "rules_would_close", "relation_word_at_distance"],
    });
  }
  {
    const c = byEntry(b, "OFAC-46715");
    const customer = b.customer({
      customer_type: "individual",
      full_name: "Vladislav Sviblov",
      date_of_birth: "1987-06-02",
      nationality: "AT",
      residence_country: "AT",
      notes:
        "Der Kunde ist seit 2021 als Nominee-Gesellschafter der Elbtal Logistik GmbH eingetragen und hält die Anteile für Vladislav Vladimirovich Sviblov, geboren am 19.01.1980, an den er die Gewinnausschüttungen weiterleitet.",
    });
    b.identifier(customer.customer_id, "passport", `P${b.rng.int(1000000, 9999999)}`, "AT");
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.9 });
    record(b, {
      ...risk,
      kind: "ho4_rules_close_note_nominee_german",
      title:
        "A shorter form of the listed name with a conflicting birth date and another nationality; a German note says the customer holds company shares as nominee for the listed person",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "The structured fields alone meet the false-positive definition, but the note, in German, says the customer is a nominee shareholder holding shares for the listed person, named in full with the listed birth date, and passes the profit distributions on to him.",
      edge: ["free_text_note", "rules_would_close", "non_english_text", "relation_word_at_distance"],
    });
  }
  {
    const c = byEntry(b, "OFAC-23445");
    const customer = b.customer({
      customer_type: "individual",
      full_name: "Samuel Dhar",
      date_of_birth: "1990-02-11",
      nationality: "IE",
      residence_country: "IE",
      notes:
        "Customer changed his name by deed poll in 2019. Before that he was known as Siddhartha Dhar; the earlier passport in that name was surrendered and is not on file.",
    });
    b.identifier(customer.customer_id, "passport", `PE${b.rng.int(1000000, 9999999)}`, "IE");
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.81 });
    record(b, {
      ...risk,
      kind: "ho4_rules_close_note_former_name",
      title:
        "A partly similar name with a conflicting birth date and another nationality; the note says the customer's former name was exactly the listed name",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "The structured fields alone meet the false-positive definition, but the note says the customer was formerly known by exactly the listed person's name and that the passport in that name is not on file, so the former name is a link no structured field carries.",
      edge: ["free_text_note", "rules_would_close", "former_name_in_text"],
    });
  }
  {
    const c = byEntry(b, "OFAC-22605");
    const customer = b.customer({
      customer_type: "individual",
      full_name: "Marcus Oyelaran",
      date_of_birth: "1968-09-30",
      nationality: "GB",
      residence_country: "GB",
      notes: `Board fees are paid into this account twice a year. Non-executive director (since 2019) of ${c.natural}, Singapore, and of two UK charities.`,
    });
    b.identifier(customer.customer_id, "passport", passport(), "GB");
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.5 });
    record(b, {
      ...risk,
      kind: "ho4_note_director_since",
      title: "The customer note says the customer has been a non-executive director of the listed company since 2019",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "The customer's name has nothing in common with the listed company, but the note says the customer has been its director since 2019 and receives board fees into this account, with the year standing between the relation word and the company's name.",
      edge: ["free_text_note", "relation_word_at_distance"],
    });
  }
  {
    const c = byEntry(b, "OFAC-26417");
    const customer = companyCustomer(b, "FR");
    const payment = b.payment({
      customer_id: customer.customer_id,
      counterparty_name: "Inversiones Morichal S.A.S.",
      counterparty_country: "CO",
      payment_reference: `Règlement facture 2026-118 (pièces de pompage) ; Inversiones Morichal S.A.S. est contrôlée, via une holding au Panama, par ${c.natural}`,
      amount: String(b.rng.int(15000, 90000)),
    });
    const alert = b.alert({
      customer,
      candidate: c,
      source: "payment",
      paymentId: payment.payment_id,
      matchedName: c.natural,
      score: 0.48,
    });
    record(b, {
      ...risk,
      kind: "ho4_ref_company_controlled_french",
      title:
        "A French payment reference says the counterparty company is controlled, through a holding company, by the listed person",
      alertId: alert.alert_id,
      alertType: "payment",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "The counterparty's name and country are not linked to the listed person, but the reference, in French, says he controls the counterparty through a holding company, with no percentage, which the approved ownership definition treats as unknown, never as zero.",
      edge: ["free_text_payment_reference", "non_english_text", "relation_word_at_distance"],
    });
  }
  {
    const c = byEntry(b, "OFAC-16753");
    const customer = companyCustomer(
      b,
      "GB",
      "Holding company with no staff. Sole authorised signatory on this account since March 2024, acting under a general power of attorney from the shareholders: Rustam Ilmirovich Temirgaliev, resident in Moscow.",
    );
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.46 });
    record(b, {
      ...risk,
      kind: "ho4_note_signatory_proxy",
      title:
        "The note on a company customer says the listed person is the sole signatory on its account, acting under a power of attorney",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "The company's name has nothing in common with the listed person, but the note says he operates its account alone as its proxy under a power of attorney, and his name stands at the end of the sentence, after the role.",
      edge: ["free_text_note", "relation_word_at_distance"],
    });
  }

  // B. Clears the written policy allows: no failing data-quality rule other than the missing birth date, which a
  // documentary note answers with a labelled birth date that conflicts with every listed date. The document number in
  // the note is also one of the customer's identifier rows, so the document is on the customer record. Words near a
  // name that are not a relationship must not raise risk.
  const clearing = {
    expected: "CLOSE_FALSE_POSITIVE" as const,
    acceptable: [] as ExamCase["acceptable"],
    mustNot: NOT_BLOCK,
  };
  const clearEdges = [
    "free_text_note",
    "near_miss_wording",
    "clearing_evidence_in_text",
    "document_on_customer_record",
    "data_quality_failure",
  ];
  {
    const c = byEntry(b, "OFAC-10010");
    const number = passport();
    const customer = b.customer({
      customer_type: "individual",
      full_name: "Jaber Al-Jalamah",
      date_of_birth: null,
      nationality: "GB",
      residence_country: "GB",
      notes: `Passport ${number} seen and copied under ${kyc()} on 2026-10-09; father's name as printed on the passport: Ahmad Al-Jalamah; date of birth 1994-12-03.`,
    });
    b.identifier(customer.customer_id, "passport", number, "GB");
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.97 });
    record(b, {
      ...clearing,
      kind: "ho4_clear_fathers_name_printed",
      title:
        "Exact name, no birth date on record; a passport note gives the father's name as printed on the passport and a different birth date",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "The father's name is a field copied from the passport, not a link to the listed person; the note carries a check reference, a passport number that is on the customer's identifier rows and a date, and its labelled birth date conflicts with the only listed date while the nationality differs and no document matches.",
      edge: [...clearEdges],
    });
  }
  {
    const c = byEntry(b, "OFAC-7214");
    const number = `E${b.rng.int(1000000, 9999999)}`;
    const customer = b.customer({
      customer_type: "individual",
      full_name: "Gorka Palacios Alday",
      date_of_birth: null,
      nationality: "ES",
      residence_country: "GB",
      notes: `Director of studies at the Leeds campus of Northgate Business School. National ID ${number} verified under EDD-${b.rng.int(10000, 99999)} on 3 Oct 2026; date of birth 1983-05-26.`,
    });
    b.identifier(customer.customer_id, "national_id", number, "ES");
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.98 });
    record(b, {
      ...clearing,
      kind: "ho4_clear_director_of_studies",
      title:
        "Exact name, no birth date on record; the note says the customer is a director of studies at a business school and records a national ID check",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "A director of studies is a job title at a school, not a directorship of a listed company; the note carries a check reference, a national ID number that is on the customer's identifier rows and a date, and its labelled birth date conflicts with the only listed date while the listed person has no listed nationality and no document matches.",
      edge: [...clearEdges],
    });
  }
  {
    const c = byEntry(b, "OFAC-30504");
    const number = passport();
    const customer = b.customer({
      customer_type: "individual",
      full_name: "Jianming Cao",
      date_of_birth: null,
      nationality: "SG",
      residence_country: "SG",
      notes: `Primary school teacher; nominee for an award at the 2026 Singapore Teaching Awards. Passport ${number} checked under ${cdd()} on 2026-10-11; born 1988-08-21.`,
    });
    b.identifier(customer.customer_id, "passport", number, "SG");
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.93 });
    record(b, {
      ...clearing,
      kind: "ho4_clear_award_nominee",
      title:
        "Exact name, no birth date on record; the note says the customer is a nominee for a teaching award and records a passport check",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "Being a nominee for an award is not a nominee holding for anyone; the note carries a check reference, a passport number that is on the customer's identifier rows and a date, and its labelled birth date conflicts with the only listed date while the nationality differs and no document matches.",
      edge: [...clearEdges],
    });
  }
  {
    const c = byEntry(b, "OFAC-41005");
    const number = `FP${b.rng.int(1000000, 9999999)}`;
    const customer = b.customer({
      customer_type: "individual",
      full_name: "Tatyana Golikova",
      date_of_birth: null,
      nationality: "FI",
      residence_country: "FI",
      notes: `Pharmacist; her accounts moved here in 2025 from our sister branch in Tampere. Passport ${number} re-verified under ${kyc()} on 2026-10-13; DOB: 1979-07-15.`,
    });
    b.identifier(customer.customer_id, "passport", number, "FI");
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.92 });
    record(b, {
      ...clearing,
      kind: "ho4_clear_sister_branch",
      title:
        "A shorter form of the listed name, no birth date on record; the note says the accounts moved from the bank's sister branch and records a passport check",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "The sister branch is the bank's own office, not a link to the listed person; the note carries a check reference, a passport number that is on the customer's identifier rows and a date, and its labelled birth date conflicts with the only listed date while the nationality differs and no document matches.",
      edge: [...clearEdges],
    });
  }
  {
    const c = byEntry(b, "OFAC-29250");
    const number = passport();
    const customer = b.customer({
      customer_type: "individual",
      full_name: "John Lee",
      date_of_birth: null,
      nationality: "GB",
      residence_country: "GB",
      notes: `Name check against ${c.natural} (listed) under ${cdd()} on 2026-10-14: not the same person. Customer's passport ${number} inspected in branch; date of birth 1984-03-15, which does not match the listed details.`,
    });
    b.identifier(customer.customer_id, "passport", number, "GB");
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.9 });
    record(b, {
      ...clearing,
      kind: "ho4_clear_name_checked_no_match",
      title:
        "A strong name match, no birth date on record; the note names the listed person only to record that a name check found no match",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "The note names the listed person only as the subject of a name check that found no match; it carries a check reference, a passport number that is on the customer's identifier rows and a date, and its labelled birth date conflicts with the only listed date while the listed person has no listed nationality and no document matches.",
      edge: [...clearEdges],
    });
  }
  {
    const c = byEntry(b, "OFAC-23143");
    const number = `NX${b.rng.int(1000000, 9999999)}`;
    const customer = b.customer({
      customer_type: "individual",
      full_name: c.natural,
      date_of_birth: null,
      nationality: "NL",
      residence_country: "NL",
      notes: `Tiler; trades through Heidari Tegelwerken B.V., a company owned by the customer himself since 2015. Passport ${number} verified under ${kyc()} on 2026-10-15; born 1989-11-28.`,
    });
    b.identifier(customer.customer_id, "passport", number, "NL");
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.98 });
    record(b, {
      ...clearing,
      kind: "ho4_clear_own_company",
      title:
        "Exact name, no birth date on record; the note says the customer trades through a company he owns himself and records a passport check",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "A company owned by the customer himself is not a company owned by the listed person; the note carries a check reference, a passport number that is on the customer's identifier rows and a date, and its labelled birth date conflicts with the only listed date while the listed person has no listed nationality and no document matches.",
      edge: [...clearEdges],
    });
  }
}

/** The fourth held-out cases, renumbered HO4-001 and up. */
export function heldout4CaseIds(cases: ExamCase[]): ExamCase[] {
  return cases.map((c, i) => ({ ...c, case_id: `HO4-${String(i + 1).padStart(3, "0")}` }));
}
