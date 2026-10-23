import type { BankBuilder, ExamCase } from "./builder.js";
import { companyName, personName } from "./names.js";
import { type Candidate, company, fullDobOf, isLatin, nationalityOf, otherCountry, person } from "./scenarios.js";

/**
 * The second held-out set. It has the same families as the first (risk stated only in free text, clears backed by
 * documentary evidence, notes that look documentary but are only claims) with new names, new wording and the text
 * in other places, some of it not in English. The labels apply the approved definitions and the documentary evidence
 * standard (policy version 5, `false_positive@2`) exactly as written, and were written before any system output on
 * this set was seen. The set is frozen when its file hash is recorded in `eval/cases/README.md`.
 *
 * Every row is built with its own id marker (CUST-J0001, ALR-J0001, ...) and from its own seed, so adding the set
 * leaves every other row of the synthetic bank, including those of the first held-out set, exactly as it was.
 */

export const HELDOUT2_GROUP = "beyond_rules_v2";

const NOT_CLOSE = ["CLOSE_FALSE_POSITIVE"] as const;
const ESCALATE_OR_ASK: ExamCase["acceptable"] = ["NEED_MORE_INFO", "RECOMMEND_BLOCK"];
const ASK_ONLY: ExamCase["acceptable"] = ["NEED_MORE_INFO"];

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
    group: HELDOUT2_GROUP as ExamCase["group"],
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

const byEntry = (b: BankBuilder, entryId: string): Candidate => {
  const found = b.candidates.find((c) => c.party.entryId === entryId);
  if (!found) throw new Error(`the second held-out set needs list entry ${entryId}`);
  b.used.add(entryId);
  return found;
};

const yearsLater = (dob: string, years: number): string => `${Number(dob.slice(0, 4)) + years}${dob.slice(4)}`;
const individual = (c: Candidate) => person(c) && fullDobOf(c.party) !== null && nationalityOf(c.party) !== null;

/** A company customer with a registry number, as the first set builds them. */
function companyCustomer(b: BankBuilder) {
  const customer = b.customer({
    customer_type: "company",
    full_name: companyName(b.rng),
    nationality: "GB",
    residence_country: "GB",
  });
  b.identifier(customer.customer_id, "registration", `REG-${b.rng.int(100000, 999999)}`, "GB");
  return customer;
}

/** Build the second held-out rows and cases. Their ids carry the marker "J". */
export function buildHeldout2Cases(b: BankBuilder): void {
  const kyc = () => `KYC-${b.rng.int(100000, 999999)}`;
  const cdd = () => `CDD-${b.rng.int(100000, 999999)}`;
  const day = () => `2026-09-${b.rng.int(10, 28)}`;

  // A. Risk stated only in free text: payment references.
  {
    const c = byEntry(b, "UN-KPe.068");
    const customer = companyCustomer(b);
    const payment = b.payment({
      customer_id: customer.customer_id,
      counterparty_name: "Pacific Bunkering Pte Ltd",
      counterparty_country: "SG",
      payment_reference: `Bunkers delivered to tanker, IMO 5988369, delivery note BK-${b.rng.int(1000, 9999)}`,
      amount: String(b.rng.int(20000, 90000)),
    });
    const alert = b.alert({
      customer,
      candidate: c,
      source: "payment",
      paymentId: payment.payment_id,
      matchedName: c.natural,
      score: 0.55,
    });
    record(b, {
      kind: "ho2_ref_imo_number",
      title: "A ship's IMO number in the payment reference is the one in the listed manager's remarks",
      alertId: alert.alert_id,
      alertType: "payment",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      expected: "ESCALATE_L2",
      acceptable: ESCALATE_OR_ASK,
      mustNot: [...NOT_CLOSE],
      note: "The counterparty is an unrelated bunker supplier; only the IMO number in the reference ties the payment to the vessel that the listed company's remarks say it manages.",
      edge: ["free_text_payment_reference", "free_text_list_remarks"],
    });
  }
  {
    const c = byEntry(b, "UN-KPe.060");
    const customer = companyCustomer(b);
    const payment = b.payment({
      customer_id: customer.customer_id,
      counterparty_name: "Harbour Fuel Trading LLC",
      counterparty_country: "AE",
      payment_reference: "Commission, marine oil tranche 2, agent Tsang Yung Yuan (Neil Tsang)",
      amount: String(b.rng.int(15000, 60000)),
    });
    const alert = b.alert({
      customer,
      candidate: c,
      source: "payment",
      paymentId: payment.payment_id,
      matchedName: c.natural,
      score: 0.55,
    });
    record(b, {
      kind: "ho2_ref_agent_named_in_remarks",
      title: "The agent named in the payment reference is the person named in the listed company's remarks",
      alertId: alert.alert_id,
      alertType: "payment",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      expected: "ESCALATE_L2",
      acceptable: ESCALATE_OR_ASK,
      mustNot: [...NOT_CLOSE],
      note: "Neither the counterparty nor its country is linked to the listed company; the agent in the reference is the individual the listed company's remarks name as the one who brokered its oil deal.",
      edge: ["free_text_payment_reference", "free_text_list_remarks"],
    });
  }
  {
    const c = b.pick(
      "ho2_ref_alias_spanish",
      (x) => company(x) && x.party.aliases.some((a) => a.strong && isLatin(a.name)),
    );
    const alias = c.party.aliases.find((a) => a.strong && isLatin(a.name))?.name ?? c.natural;
    const customer = companyCustomer(b);
    const payment = b.payment({
      customer_id: customer.customer_id,
      counterparty_name: "Distribuciones Levante SL",
      counterparty_country: "ES",
      payment_reference: `Pago por cuenta de ${alias}, contrato 3390/2026`,
      amount: String(b.rng.int(8000, 70000)),
    });
    const alert = b.alert({
      customer,
      candidate: c,
      source: "payment",
      paymentId: payment.payment_id,
      matchedName: alias,
      score: 0.7,
    });
    record(b, {
      kind: "ho2_ref_alias_spanish",
      title: "A Spanish payment reference says the payment is made on behalf of a listed company's alias",
      alertId: alert.alert_id,
      alertType: "payment",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      expected: "ESCALATE_L2",
      acceptable: ESCALATE_OR_ASK,
      mustNot: [...NOT_CLOSE],
      note: "The reference, in Spanish, says the payment is made for the listed company under its alias; the counterparty name and country say nothing.",
      edge: ["free_text_payment_reference", "non_english_text", "alias_pattern"],
    });
  }

  // B. Risk stated only in free text: customer notes, some not in English.
  {
    const c = byEntry(b, "UN-QDi.360");
    const customer = b.customer({
      customer_type: "individual",
      full_name: personName(b.rng),
      date_of_birth: null,
      nationality: otherCountry(b.rng, [nationalityOf(c.party)]),
      residence_country: "ES",
      notes: "Cliente casada. Apellido de soltera: Sally Anne Frances Jones. Esposo: Junaid Hussain.",
    });
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.84 });
    record(b, {
      kind: "ho2_note_maiden_name_spanish",
      title: "A Spanish customer note gives a maiden name that is the listed individual's name",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      expected: "ESCALATE_L2",
      acceptable: ESCALATE_OR_ASK,
      mustNot: [...NOT_CLOSE],
      note: "The structured name and the empty birth date say nothing; the note, in Spanish, gives the listed individual's full name as the customer's maiden name and names the husband the listed remarks name.",
      edge: ["free_text_note", "non_english_text", "alias_pattern"],
    });
  }
  {
    const c = byEntry(b, "UN-QDi.299");
    const customer = b.customer({
      customer_type: "individual",
      full_name: personName(b.rng),
      date_of_birth: null,
      nationality: otherCountry(b.rng, [nationalityOf(c.party)]),
      residence_country: "DE",
      notes:
        "Ehefrau von Ibrahim Awwad Ibrahim Ali al-Badri al-Samarrai laut Kopie der Heiratsurkunde. Das Konto dient dem Familienunterhalt.",
    });
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.62 });
    record(b, {
      kind: "ho2_note_spouse_german",
      title: "A German customer note says the account holder is the listed individual's wife",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      expected: "ESCALATE_L2",
      acceptable: ASK_ONLY,
      mustNot: [...NOT_CLOSE],
      note: "No structured field links the customer to the listed individual; the note, in German, names the listed individual as the customer's husband.",
      edge: ["free_text_note", "non_english_text"],
    });
  }
  {
    const c = byEntry(b, "UN-QDe.153");
    const customer = b.customer({
      customer_type: "company",
      full_name: "Al Noor Change SARL",
      nationality: "FR",
      residence_country: "FR",
      notes:
        "Bureau de change. Succursale à Albu Kamal (Syrie), ouverte en 2021; virements vers la région frontalière.",
    });
    b.identifier(customer.customer_id, "registration", `REG-${b.rng.int(100000, 999999)}`, "FR");
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.57 });
    record(b, {
      kind: "ho2_note_branch_location_french",
      title: "A French customer note places a branch in the town where the listed exchange office operated",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      expected: "ESCALATE_L2",
      acceptable: ESCALATE_OR_ASK,
      mustNot: [...NOT_CLOSE],
      note: "The names are different; the note, in French, says the customer, also a money exchange, runs a branch in Albu Kamal, which is the branch location in the listed entry.",
      edge: ["free_text_note", "non_english_text", "free_text_list_remarks"],
    });
  }

  // C. Risk stated only in the listed entity's remarks.
  {
    const c = byEntry(b, "UN-QDe.119");
    const customer = companyCustomer(b);
    const payment = b.payment({
      customer_id: customer.customer_id,
      counterparty_name: "Najmiddin K. Jalolov",
      counterparty_country: "UZ",
      payment_reference: "Consulting fee, September",
      amount: String(b.rng.int(2000, 9000)),
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
      kind: "ho2_remarks_founder_as_counterparty",
      title: "The counterparty is the person the listed group's remarks name as its founder",
      alertId: alert.alert_id,
      alertType: "payment",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      expected: "ESCALATE_L2",
      acceptable: ASK_ONLY,
      mustNot: [...NOT_CLOSE],
      note: "The counterparty's name is not the listed name; it is the founder and leader the listed group's remarks name (reportedly deceased), so a reviewer must look at it rather than close.",
      edge: ["free_text_list_remarks"],
    });
  }

  // D. Clears backed by documentary evidence. Escalating any of them is a miss.
  const CLOSE = "CLOSE_FALSE_POSITIVE" as const;
  const clearing = {
    expected: CLOSE,
    acceptable: [] as ExamCase["acceptable"],
    mustNot: ["RECOMMEND_BLOCK"] as ExamCase["must_not"],
  };
  {
    const c = b.pick("ho2_clear_spanish_passport", individual);
    const customer = b.customer({
      customer_type: "individual",
      full_name: c.natural,
      date_of_birth: null,
      nationality: otherCountry(b.rng, [nationalityOf(c.party)]),
      residence_country: "ES",
      notes: `Identidad verificada en sucursal (${kyc()}) el ${day()}: passport ZV${b.rng.int(1000000, 9999999)}, date of birth ${yearsLater(fullDobOf(c.party) as string, 21)}.`,
    });
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.97 });
    record(b, {
      ...clearing,
      kind: "ho2_clear_spanish_passport",
      title:
        "Exact name, no birth date on record; a Spanish note records a passport check with a birth date 21 years away",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "The note names the check, a passport number that is not the listed one and a date, so it is documentary; its birth date conflicts with every listed date.",
      edge: ["free_text_note", "non_english_text", "clearing_evidence_in_text"],
    });
  }
  {
    const c = b.pick("ho2_clear_street_name", individual);
    const customer = companyCustomer(b);
    const payment = b.payment({
      customer_id: customer.customer_id,
      counterparty_name: c.natural,
      counterparty_country: "XX",
      payment_reference: `Rent deposit, Isis Court, Oxford; landlord ID ${b.rng.int(10000000, 99999999)} verified (${cdd()}) on 2026-10-0${b.rng.int(1, 9)}, landlord born ${yearsLater(fullDobOf(c.party) as string, 26)}`,
      amount: String(b.rng.int(1500, 6000)),
    });
    const alert = b.alert({
      customer,
      candidate: c,
      source: "payment",
      paymentId: payment.payment_id,
      matchedName: c.natural,
      score: 0.95,
    });
    record(b, {
      ...clearing,
      kind: "ho2_clear_street_name",
      title:
        "The counterparty name equals a listed individual and has no country; the reference documents a landlord and mentions a street whose name looks like a listed group",
      alertId: alert.alert_id,
      alertType: "payment",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "The reference carries a check reference, an ID number and a date, and the counterparty is named; its birth date conflicts with every listed date. The street name is a building in Oxford, not a listed party.",
      edge: ["free_text_payment_reference", "near_miss_wording", "clearing_evidence_in_text"],
    });
  }
  {
    const c = b.pick("ho2_clear_registered_company", (x) => company(x));
    const customer = companyCustomer(b);
    const payment = b.payment({
      customer_id: customer.customer_id,
      counterparty_name: c.natural,
      counterparty_country: "XX",
      payment_reference: `Invoice 2026-114 to ${c.natural} (Leeds, GB); company no. ${b.rng.int(10000000, 99999999)} confirmed, chk ${b.rng.int(100000, 999999)} on 2026-10-0${b.rng.int(1, 9)}`,
      amount: String(b.rng.int(4000, 30000)),
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
      kind: "ho2_clear_registered_company",
      title:
        "The counterparty name equals a listed company and has no country; the reference gives a registered company in Leeds",
      alertId: alert.alert_id,
      alertType: "payment",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "The reference carries a check reference, a company number and a date, and names the counterparty with a city that has no link to the listed company.",
      edge: ["free_text_payment_reference", "clearing_evidence_in_text"],
    });
  }
  {
    const c = b.pick("ho2_clear_themed_bar", individual);
    const customer = b.customer({
      customer_type: "individual",
      full_name: c.natural,
      date_of_birth: null,
      nationality: otherCountry(b.rng, [nationalityOf(c.party)]),
      residence_country: "GB",
      notes: `Owns the Kalashnikov Vodka Bar, a themed restaurant in Soho. Identity: passport ZT${b.rng.int(1000000, 9999999)}, checked at branch (${kyc()}) on 14 Sep 2026, date of birth ${yearsLater(fullDobOf(c.party) as string, -23)}.`,
    });
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.96 });
    record(b, {
      ...clearing,
      kind: "ho2_clear_themed_bar",
      title:
        "Exact name; the note mentions a themed bar named after a weapons maker and gives a documented passport check",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "The name of the bar is a near miss that must not raise risk; the note names the check, a passport number and a date, and its birth date conflicts with every listed date.",
      edge: ["free_text_note", "near_miss_wording", "clearing_evidence_in_text"],
    });
  }
  {
    const c = b.pick("ho2_clear_french_id", (x) => individual(x) && x.party.aliases.some((a) => a.strong));
    const alias = c.party.aliases.find((a) => a.strong)?.name ?? c.natural;
    const customer = b.customer({
      customer_type: "individual",
      full_name: alias,
      date_of_birth: null,
      nationality: otherCountry(b.rng, [nationalityOf(c.party)]),
      residence_country: "FR",
      notes: `Vérification d'identité (${cdd()}) le ${day()} : national ID ${b.rng.int(10000000, 99999999)}, date of birth ${yearsLater(fullDobOf(c.party) as string, 18)}.`,
    });
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: alias, score: 0.96 });
    record(b, {
      ...clearing,
      kind: "ho2_clear_french_id",
      title:
        "The customer's name equals a strong alias; a French note records an identity card check with a birth date 18 years away",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "A strong alias match cleared by a note, in French, that carries a check reference, an ID number and a date, with a birth date that conflicts with every listed date.",
      edge: ["free_text_note", "non_english_text", "alias_pattern", "clearing_evidence_in_text"],
    });
  }

  // E. Notes that look documentary but fail the standard: a close is a miss.
  const claim = {
    expected: "NEED_MORE_INFO" as const,
    acceptable: ["ESCALATE_L2"] as ExamCase["acceptable"],
    mustNot: [...NOT_CLOSE] as ExamCase["must_not"],
  };
  {
    const c = b.pick("ho2_claim_no_check_reference", individual);
    const customer = b.customer({
      customer_type: "individual",
      full_name: c.natural,
      date_of_birth: null,
      nationality: otherCountry(b.rng, [nationalityOf(c.party)]),
      residence_country: "GB",
      notes: `Passport ZP${b.rng.int(1000000, 9999999)} seen at branch on ${day()}; date of birth ${yearsLater(fullDobOf(c.party) as string, 17)}.`,
    });
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.97 });
    record(b, {
      ...claim,
      kind: "ho2_claim_no_check_reference",
      title: "Exact name; a note gives a passport number, a date and a different birth date but names no check",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "The note has a document number and a date but no reference to the check that was made, so it is a claim and cannot clear the match.",
      edge: ["free_text_note", "claim_looks_documentary"],
    });
  }
  {
    const c = b.pick("ho2_claim_unnamed_counterparty", (x) => company(x));
    const customer = companyCustomer(b);
    const payment = b.payment({
      customer_id: customer.customer_id,
      counterparty_name: "Unknown",
      counterparty_country: "XX",
      payment_reference: `Final payment for ${c.natural}, company no. ${b.rng.int(10000000, 99999999)}, verified (${cdd()}) on ${day()}; unrelated to the listed entity`,
      amount: String(b.rng.int(3000, 25000)),
    });
    const alert = b.alert({
      customer,
      candidate: c,
      source: "payment",
      paymentId: payment.payment_id,
      matchedName: c.natural,
      score: 0.92,
    });
    record(b, {
      ...claim,
      kind: "ho2_claim_unnamed_counterparty",
      title:
        "A payment reference with a check, a company number and a date, but the counterparty is recorded as unknown",
      alertId: alert.alert_id,
      alertType: "payment",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "The reference has all three elements, but the standard also needs a named counterparty for a payment, and the counterparty is recorded as unknown.",
      edge: ["free_text_payment_reference", "claim_looks_documentary"],
    });
  }
  {
    const c = b.pick("ho2_claim_no_date", individual);
    const customer = b.customer({
      customer_type: "individual",
      full_name: c.natural,
      date_of_birth: null,
      nationality: otherCountry(b.rng, [nationalityOf(c.party)]),
      residence_country: "GB",
      notes: `Identity confirmed (${kyc()}), passport ZS${b.rng.int(1000000, 9999999)}; born ${yearsLater(fullDobOf(c.party) as string, 15).slice(0, 4)}.`,
    });
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.97 });
    record(b, {
      ...claim,
      kind: "ho2_claim_no_date",
      title: "Exact name; a note gives a check reference and a passport number but only a year of birth and no date",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      note: "The note has a check reference and a document number but no date, so it is a claim and cannot clear the match.",
      edge: ["free_text_note", "claim_looks_documentary"],
    });
  }
}

/** The second held-out cases, renumbered HO2-001 and up. */
export function heldout2CaseIds(cases: ExamCase[]): ExamCase[] {
  return cases.map((c, i) => ({ ...c, case_id: `HO2-${String(i + 1).padStart(3, "0")}` }));
}
