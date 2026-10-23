import type { BankBuilder, ExamCase } from "./builder.js";
import { companyName } from "./names.js";
import type { Candidate } from "./scenarios.js";

/**
 * The third held-out set: six risks and six clears. The risks are relationships to a listed party stated in free text
 * (a family link, a directorship of a listed company, a nominee holding, a payment to a company owned by a listed
 * party, a business partnership and a trust), three of them where the structured fields alone meet the false-positive
 * definition, in English and in Portuguese, Italian and Dutch. The clears are documentary notes and payment
 * references that meet the evidence standard, some naming the listed person in a name check and some carrying
 * harmless words next to a name ("father's name", "director of studies", "nominee for the award", "sister company of
 * our branch office"). The labels apply the approved definitions and the documentary evidence standard
 * (`false_positive@2`, `counterparty_match@1`) exactly as written, and were written before any system output on this
 * set was seen. The set is frozen when its file hash is recorded in `eval/cases/README.md`.
 *
 * Every row is built with its own id marker (CUST-K0001, ALR-K0001, ...) and from its own seed, after the rows of the
 * first two held-out sets, so adding the set leaves every other row of the synthetic bank exactly as it was.
 */

export const HELDOUT3_GROUP = "beyond_rules_v3";

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
    group: HELDOUT3_GROUP as ExamCase["group"],
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

/** A listed party named by its entry id. It must not have been used by an earlier held-out set. */
const byEntry = (b: BankBuilder, entryId: string): Candidate => {
  if (b.used.has(entryId)) throw new Error(`list entry ${entryId} is already used by an earlier held-out set`);
  const found = b.candidates.find((c) => c.party.entryId === entryId);
  if (!found) throw new Error(`the third held-out set needs list entry ${entryId}`);
  b.used.add(entryId);
  return found;
};

/** A company customer with a registry number. */
function companyCustomer(b: BankBuilder, country = "GB") {
  const customer = b.customer({
    customer_type: "company",
    full_name: companyName(b.rng),
    nationality: country,
    residence_country: country,
  });
  b.identifier(customer.customer_id, "registration", `REG-${b.rng.int(100000, 999999)}`, country);
  return customer;
}

/** Build the third held-out rows and cases. Their ids carry the marker "K". */
export function buildHeldout3Cases(b: BankBuilder): void {
  const kyc = () => `KYC-${b.rng.int(100000, 999999)}`;
  const cdd = () => `CDD-${b.rng.int(100000, 999999)}`;

  // A. Risks: a relationship to the listed party stated only in free text. Escalating is the answer; a close is a miss.
  const risk = { expected: "ESCALATE_L2" as const, acceptable: [] as ExamCase["acceptable"], mustNot: NOT_CLOSE };
  {
    const c = byEntry(b, "OFAC-17037");
    const customer = b.customer({
      customer_type: "individual",
      full_name: "Mohamad Ali Zeaiter",
      date_of_birth: "2002-08-14",
      nationality: "DE",
      residence_country: "DE",
      notes:
        "Student account. Son of Ali Zeaiter (born 1977-02-24); the father pays the term fees by transfer from Guangzhou every quarter.",
    });
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.86 });
    record(b, {
      ...risk,
      kind: "ho3_rules_close_note_son",
      title:
        "A similar name with a conflicting birth date and another nationality; the note says the customer is the listed person's son and is funded by him",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "The structured fields alone meet the false-positive definition, but the note names the listed person, with the listed birth date, as the customer's father and the source of the account's funds.",
      edge: ["free_text_note", "rules_would_close"],
    });
  }
  {
    const c = byEntry(b, "OFAC-19992");
    const customer = b.customer({
      customer_type: "individual",
      full_name: "Rui Baltazar Teixeira",
      date_of_birth: "1979-03-30",
      nationality: "PT",
      residence_country: "PT",
      notes:
        "Cliente é diretor executivo da LLC BALTECH (São Petersburgo) desde 2020 e recebe o salário de administrador nesta conta.",
    });
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.52 });
    record(b, {
      ...risk,
      kind: "ho3_note_director_portuguese",
      title: "A Portuguese customer note says the customer is the executive director of a listed company",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "The customer's name has nothing in common with the listed company; the note, in Portuguese, says the customer has been its executive director since 2020 and is paid by it into this account.",
      edge: ["free_text_note", "non_english_text"],
    });
  }
  {
    const c = byEntry(b, "OFAC-23189");
    const customer = b.customer({
      customer_type: "individual",
      full_name: "Daren Debono",
      date_of_birth: "1998-04-03",
      nationality: "GB",
      residence_country: "GB",
      notes:
        "Registered holder of 40 shares in Seabright Marine Ltd as nominee for Darren Debono of Malta (born 1974-01-09); dividends are passed on to him.",
    });
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.91 });
    record(b, {
      ...risk,
      kind: "ho3_rules_close_note_nominee",
      title:
        "A near-identical name with a conflicting birth date and another nationality; the note says the customer holds shares as nominee for the listed person",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "The structured fields alone meet the false-positive definition, but the note says the customer holds shares as nominee for the listed person, named with the listed birth date, and passes the dividends on to him.",
      edge: ["free_text_note", "rules_would_close"],
    });
  }
  {
    const c = byEntry(b, "OFAC-58482");
    const customer = companyCustomer(b);
    const payment = b.payment({
      customer_id: customer.customer_id,
      counterparty_name: "Coral Reach Trading LLC",
      counterparty_country: "OM",
      payment_reference: `Invoice 2026/311 for marine spares; Coral Reach Trading LLC is a company owned by ${c.natural}`,
      amount: String(b.rng.int(12000, 80000)),
    });
    const alert = b.alert({
      customer,
      candidate: c,
      source: "payment",
      paymentId: payment.payment_id,
      matchedName: c.natural,
      score: 0.5,
    });
    record(b, {
      ...risk,
      kind: "ho3_ref_company_owned_by_listed",
      title: "The payment reference says the counterparty company is owned by the listed person",
      alertId: alert.alert_id,
      alertType: "payment",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "The counterparty's name and country are not linked to the listed person, but the reference says the counterparty is owned by him, with no percentage, which the approved ownership definition treats as unknown, never as zero.",
      edge: ["free_text_payment_reference"],
    });
  }
  {
    const c = byEntry(b, "OFAC-40569");
    const customer = b.customer({
      customer_type: "individual",
      full_name: "Arkadiy Gostev",
      date_of_birth: "1983-07-22",
      nationality: "IT",
      residence_country: "IT",
      notes:
        "Socio al 50% di Arkadiy Aleksandrovich Gostev nella Gostev Costruzioni S.r.l. di Genova; firma i contratti anche a nome del socio.",
    });
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.88 });
    record(b, {
      ...risk,
      kind: "ho3_rules_close_note_partner_italian",
      title:
        "A shorter form of the listed name with a conflicting birth date and another nationality; an Italian note says the customer is the listed person's business partner",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "The structured fields alone meet the false-positive definition, but the note, in Italian, says the customer co-owns a company half and half with the listed person, named in full, and signs contracts on his behalf.",
      edge: ["free_text_note", "non_english_text", "rules_would_close"],
    });
  }
  {
    const c = byEntry(b, "OFAC-56810");
    const customer = b.customer({
      customer_type: "company",
      full_name: "Grachtzicht Trust B.V.",
      nationality: "NL",
      residence_country: "NL",
      notes:
        "Trustkantoor. Treedt op als trustee van de Stichting Familiefonds Rivera; volgens een persbericht is de enige begunstigde Carlos Humberto Rivera Miramontes.",
    });
    b.identifier(customer.customer_id, "registration", `REG-${b.rng.int(100000, 999999)}`, "NL");
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.55 });
    record(b, {
      ...risk,
      acceptable: ["NEED_MORE_INFO"],
      kind: "ho3_note_trustee_dutch",
      title:
        "A Dutch customer note says the customer is trustee of a foundation whose sole beneficiary, according to a press report, is the listed person",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "The note, in Dutch, links the customer to the listed person as trustee for him, but the link rests on a press report and not on a document, so asking for more information is an honest answer beside escalation.",
      edge: ["free_text_note", "non_english_text"],
    });
  }

  // B. Clears the written policy allows: no failing data-quality rule other than the missing birth date, which a
  // documentary English note answers with a labelled birth date; for payments, a usable counterparty country not
  // linked to the listed party. Words near a name that are not a relationship must not raise risk.
  const clearing = {
    expected: "CLOSE_FALSE_POSITIVE" as const,
    acceptable: [] as ExamCase["acceptable"],
    mustNot: NOT_BLOCK,
  };
  {
    const c = byEntry(b, "OFAC-29260");
    const customer = b.customer({
      customer_type: "individual",
      full_name: c.natural,
      date_of_birth: null,
      nationality: "GB",
      residence_country: "GB",
      notes: `Name check against the listed person ${c.natural} under ${kyc()} on 2026-10-06: different date of birth, different passport. Passport 5${b.rng.int(10000000, 99999999)} inspected in branch; DOB: 1987-11-03.`,
    });
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.98 });
    record(b, {
      ...clearing,
      kind: "ho3_clear_name_check_note",
      title:
        "Exact name, no birth date on record; the note records a name check against the listed person with a passport and a different birth date",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "The note names the listed person only as the subject of a name check; it carries a check reference, a passport number and a date, and its labelled birth date conflicts with the only listed date while the nationality differs and no document matches.",
      edge: ["free_text_note", "near_miss_wording", "clearing_evidence_in_text", "data_quality_failure"],
    });
  }
  {
    const c = byEntry(b, "OFAC-10009");
    const customer = b.customer({
      customer_type: "individual",
      full_name: "Hamid Al-Ali",
      date_of_birth: null,
      nationality: "AE",
      residence_country: "GB",
      notes: `Passport P${b.rng.int(10000000, 99999999)} checked under ${cdd()} on 2026-09-22; father's name Yousef Al-Ali as printed on the passport; date of birth 1993-06-11.`,
    });
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.97 });
    record(b, {
      ...clearing,
      kind: "ho3_clear_fathers_name",
      title:
        "Exact name, no birth date on record; a passport check note gives the father's name as printed on the passport and a different birth date",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "The father's name is a field copied from the passport, not a link to the listed person; the note carries a check reference, a passport number and a date, and its labelled birth date conflicts with the only listed date while the nationality differs and no document matches.",
      edge: ["free_text_note", "near_miss_wording", "clearing_evidence_in_text", "data_quality_failure"],
    });
  }
  {
    const c = byEntry(b, "OFAC-30964");
    const customer = b.customer({
      customer_type: "individual",
      full_name: c.natural,
      date_of_birth: null,
      nationality: "FR",
      residence_country: "GB",
      notes: `Director of studies at Kingsbridge Language School. Identity card ${b.rng.int(1000000000, 9999999999)} checked under EDD-${b.rng.int(10000, 99999)} on 12 Sep 2026; date of birth 1991-02-19.`,
    });
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.98 });
    record(b, {
      ...clearing,
      kind: "ho3_clear_director_of_studies",
      title:
        "Exact name, no birth date on record; the note says the customer is a director of studies at a language school and records an identity card check",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "A director of studies at a school is a job title, not a directorship of a listed company; the note carries a check reference, an identity card number and a date, and its labelled birth date conflicts with the only listed date while the nationality differs and no document matches.",
      edge: ["free_text_note", "near_miss_wording", "clearing_evidence_in_text", "data_quality_failure"],
    });
  }
  {
    const c = byEntry(b, "OFAC-58343");
    const customer = b.customer({
      customer_type: "individual",
      full_name: c.natural,
      date_of_birth: null,
      nationality: "SG",
      residence_country: "SG",
      notes: `Nominee for the 2026 Young Engineer of the Year award. National ID ${b.rng.int(10000000, 99999999)} verified, case 2026-${b.rng.int(10000, 99999)}, on 2026-10-02; born 1996-09-30.`,
    });
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.98 });
    record(b, {
      ...clearing,
      kind: "ho3_clear_award_nominee",
      title:
        "Exact name, no birth date on record; the note says the customer is a nominee for an engineering award and records a national ID check",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "Being a nominee for an award is not a nominee holding for anyone; the note carries a check reference, a national ID number and a date, and its labelled birth date conflicts with the only listed date while the nationality differs and no document matches.",
      edge: ["free_text_note", "near_miss_wording", "clearing_evidence_in_text", "data_quality_failure"],
    });
  }
  {
    const c = byEntry(b, "OFAC-18289");
    const customer = companyCustomer(b, "IE");
    const payment = b.payment({
      customer_id: customer.customer_id,
      counterparty_name: "Rose Group Limited",
      counterparty_country: "IE",
      payment_reference: `Fit-out of the Cork office; Rose Group Limited is the sister company of our Dublin branch office; company no. ${b.rng.int(10000000, 99999999)} confirmed, CHK-${b.rng.int(100000, 999999)} on 2026-10-07`,
      amount: String(b.rng.int(9000, 45000)),
    });
    const alert = b.alert({
      customer,
      candidate: c,
      source: "payment",
      paymentId: payment.payment_id,
      matchedName: c.natural,
      score: 0.96,
    });
    record(b, {
      ...clearing,
      kind: "ho3_clear_sister_company",
      title:
        "The counterparty name equals a listed company; the reference says it is the sister company of the customer's branch office and records a company number check",
      alertId: alert.alert_id,
      alertType: "payment",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "The counterparty's country, Ireland, is not one linked to the listed company, so the counterparty match definition is not met; the sister company is the customer's own group, not the listed party's, and the reference names the counterparty and carries a check reference, a company number and a date.",
      edge: ["free_text_payment_reference", "near_miss_wording", "clearing_evidence_in_text"],
    });
  }
  {
    const c = byEntry(b, "OFAC-16210");
    const customer = companyCustomer(b, "ES");
    const payment = b.payment({
      customer_id: customer.customer_id,
      counterparty_name: "Juanita Del Carmen Rios Hernandez",
      counterparty_country: "ES",
      payment_reference: `Deposit refund, flat 4B Calle Mayor 12, Valencia; name check against the listed person: different date of birth, different passport; payee passport PAE${b.rng.int(100000, 999999)} verified (${cdd()}) on 2026-10-08, payee born 1990-03-27`,
      amount: String(b.rng.int(800, 3000)),
    });
    const alert = b.alert({
      customer,
      candidate: c,
      source: "payment",
      paymentId: payment.payment_id,
      matchedName: c.natural,
      score: 0.97,
    });
    record(b, {
      ...clearing,
      kind: "ho3_clear_payee_name_check",
      title:
        "The counterparty name equals a listed individual; the reference records a name check against the listed person with a passport and a different birth date",
      alertId: alert.alert_id,
      alertType: "payment",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "The counterparty's country, Spain, is not one linked to the listed person, so the counterparty match definition is not met; the reference mentions the listed person only as the subject of a name check, names the payee and carries a check reference, a passport number, a date and a labelled birth date that conflicts with the only listed date.",
      edge: ["free_text_payment_reference", "near_miss_wording", "clearing_evidence_in_text"],
    });
  }
}

/** The third held-out cases, renumbered HO3-001 and up. */
export function heldout3CaseIds(cases: ExamCase[]): ExamCase[] {
  return cases.map((c, i) => ({ ...c, case_id: `HO3-${String(i + 1).padStart(3, "0")}` }));
}
