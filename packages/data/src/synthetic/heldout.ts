import { type BankBuilder, CURRENT_TIME, type ExamCase } from "./builder.js";
import { companyName, personName } from "./names.js";
import { type Candidate, company, fullDobOf, nameVariant, nationalityOf, otherCountry, person } from "./scenarios.js";

/**
 * The held-out set: cases where the deciding evidence is in free text (a payment reference, a customer note, a
 * listed party's remarks), in an alias or transliteration pattern the name rules were not written for, or in
 * documents that disagree. The labels follow the approved definitions and were written before any run on them.
 * The set is frozen when it is committed; the report names the commit and says if the file changed afterwards.
 *
 * Every row is built with its own id marker (CUST-H0001, ALR-H0001, ...) and from its own seed, so adding the set
 * leaves every other row of the synthetic bank exactly as it was.
 */

export const HELDOUT_GROUP = "beyond_rules";

const NOT_CLOSE = ["CLOSE_FALSE_POSITIVE"] as const;

interface Spec {
  kind: string;
  title: string;
  alertId: string;
  alertType: "customer" | "payment";
  customerId: string;
  entryId: string;
  expected: ExamCase["expected"];
  acceptable: ExamCase["acceptable"];
  note: string;
  edge: string[];
  /** Answers that must never be given; by default a close, since most of the set is cautious. */
  mustNot?: ExamCase["must_not"];
}

function record(b: BankBuilder, s: Spec): void {
  b.addCase({
    kind: s.kind,
    group: HELDOUT_GROUP as ExamCase["group"],
    title: s.title,
    alert_id: s.alertId,
    alert_type: s.alertType,
    customer_id: s.customerId,
    entry_id: s.entryId,
    expected: s.expected,
    acceptable: s.acceptable,
    must_not: [...(s.mustNot ?? NOT_CLOSE)],
    edge_cases: s.edge,
    note: s.note,
  });
}

/**
 * Freeze 3: four cases whose text does not meet the documentary evidence standard of policy version 2 are relabelled
 * from a close to NEED_MORE_INFO. The labels were written before the standard was made explicit; under policy version
 * 2 these notes are claims. Their rows are unchanged.
 */
const CLAIM_ONLY = new Set([
  "ho_clear_remarks_parents_differ",
  "ho_clear_remarks_mother_differs",
  "ho_clear_ref_other_company",
  "ho_clear_ref_other_individual",
]);
const RELABEL_REASON =
  " Relabelled in freeze 3: labels written before the evidence standard was made explicit; under policy v2 these notes are claims.";

const ESCALATE_OR_ASK: ExamCase["acceptable"] = ["NEED_MORE_INFO", "RECOMMEND_BLOCK"];
const ASK_ONLY: ExamCase["acceptable"] = ["NEED_MORE_INFO"];

const byEntry = (b: BankBuilder, entryId: string): Candidate => {
  const found = b.candidates.find((c) => c.party.entryId === entryId);
  if (!found) throw new Error(`the held-out set needs list entry ${entryId}`);
  b.used.add(entryId);
  return found;
};

const withIdentifier = (c: Candidate) =>
  c.party.identifiers.some((i) => i.type === "passport" || i.type === "national_id") &&
  fullDobOf(c.party) !== null &&
  nationalityOf(c.party) !== null &&
  person(c);

/** An alias or transliteration pattern, written without looking at how the name rules handle it. */
const compressChain = (name: string): string => {
  const t = name.replace(/-/g, " ").split(/\s+/);
  return [t[0], t.at(-1)]
    .join(" ")
    .replace(/\b(\w)(\w*)/g, (_m, a: string, r: string) => a.toUpperCase() + r.toLowerCase());
};
const otherRussianScheme = (name: string): string =>
  name
    .replace(/YU/gi, (m) => (m === m.toUpperCase() ? "IU" : "Iu"))
    .replace(/YA/gi, (m) => (m === m.toUpperCase() ? "IA" : "Ia"))
    .replace(/KS/gi, (m) => (m === m.toUpperCase() ? "X" : "x"))
    .replace(/EV\b/gi, (m) => (m === m.toUpperCase() ? "YEV" : "yev"))
    .replace(/OV\b/gi, (m) => (m === m.toUpperCase() ? "OFF" : "off"));
const otherKoreanScheme = (name: string): string => {
  const t = name.split(/\s+/);
  const given = t.slice(1).join("-");
  return `${t[0]} ${given}`.replace(/\bJ/g, "Ch").replace(/\bj/g, "ch").replace(/Ju/g, "Chu");
};
const mergeTokens = (name: string): string => {
  const t = name.replace(/-/g, " ").split(/\s+/);
  return t.length < 3
    ? `${t[0]}${(t[1] ?? "").toLowerCase()}`
    : [t[0], `${t[1]}${(t[2] as string).toLowerCase()}`, ...t.slice(3)].join(" ");
};

const changed = (candidate: Candidate, rewritten: (n: string) => string) =>
  rewritten(candidate.natural) !== candidate.natural;

/** Build the held-out rows and cases. Their ids carry the marker "H". */
export function buildHeldoutCases(b: BankBuilder): void {
  // A. The payment reference names the listed party; the counterparty itself looks unrelated.
  const references: Array<[string, (c: Candidate) => string, (c: Candidate) => boolean]> = [
    ["ho_ref_on_behalf", (c) => `Payment on behalf of ${c.natural}`, (c) => person(c) || company(c)],
    [
      "ho_ref_care_of",
      (c) => `c/o ${c.party.aliases.find((a) => a.strong)?.name ?? c.natural}, invoice 4471`,
      (c) => company(c),
    ],
    [
      "ho_ref_shipped_for",
      (c) => `Final instalment, goods shipped for ${c.natural.toUpperCase()}, Dubai`,
      (c) => person(c),
    ],
    [
      "ho_ref_variant",
      (c) => `Settlement - ${nameVariant(c.natural)} contract 88/2026`,
      (c) => (person(c) || company(c)) && nameVariant(c.natural) !== c.natural,
    ],
  ];
  for (const [kind, text, fits] of references) {
    const c = b.pick(kind, fits);
    const customer = b.customer({
      customer_type: "company",
      full_name: companyName(b.rng),
      nationality: "GB",
      residence_country: "GB",
    });
    b.identifier(customer.customer_id, "registration", `REG-${b.rng.int(100000, 999999)}`, "GB");
    const payment = b.payment({
      customer_id: customer.customer_id,
      counterparty_name: companyName(b.rng),
      counterparty_country: "NL",
      payment_reference: text(c),
      amount: String(b.rng.int(5000, 80000)),
    });
    const alert = b.alert({
      customer,
      candidate: c,
      source: "payment",
      paymentId: payment.payment_id,
      matchedName: c.natural,
      score: 0.9,
    });
    record(b, {
      kind,
      title: "Payment reference names a listed party; the counterparty looks unrelated",
      alertId: alert.alert_id,
      alertType: "payment",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      expected: "ESCALATE_L2",
      acceptable: ESCALATE_OR_ASK,
      note: "Only the free-text reference shows that the payment is made for a listed party; the counterparty name and country say nothing.",
      edge: ["free_text_payment_reference"],
    });
  }

  // B. A note on the customer's record carries the deciding information, or a claim that must not be trusted.
  const notes: Array<{
    kind: string;
    title: string;
    expected: ExamCase["expected"];
    acceptable: ExamCase["acceptable"];
    note: string;
    build: (c: Candidate) => { name: string; dob: string | null; notes: string };
  }> = [
    {
      kind: "ho_note_trading_name",
      title: "Customer note: previously traded under a listed party's name",
      expected: "ESCALATE_L2",
      acceptable: ESCALATE_OR_ASK,
      note: "The structured fields look unrelated; the note says the customer traded under the listed name until a rebrand.",
      build: (c) => ({
        name: personName(b.rng),
        dob: `19${b.rng.int(60, 90)}-0${b.rng.int(1, 9)}-1${b.rng.int(0, 9)}`,
        notes: `Previously traded as ${c.natural} until the 2019 rebrand.`,
      }),
    },
    {
      kind: "ho_note_family_link",
      title: "Customer note: introduced by a listed party, said to be a relative",
      expected: "ESCALATE_L2",
      acceptable: ESCALATE_OR_ASK,
      note: "A relationship manager's note names a listed party as the account holder's relative; no structured field carries it.",
      build: (c) => ({
        name: personName(b.rng),
        dob: `19${b.rng.int(60, 90)}-0${b.rng.int(1, 9)}-2${b.rng.int(0, 8)}`,
        notes: `Introduced by ${c.natural}, who is the account holder's brother.`,
      }),
    },
    {
      kind: "ho_note_unverified_dob",
      title: "Exact name, no birth date on record, a note quoting a passport date",
      expected: "NEED_MORE_INFO",
      acceptable: ["ESCALATE_L2"],
      note: "The date of birth field is empty. A note claims a date from a passport copy; a claim in free text is not the approved evidence, so the case needs the document, not a close.",
      build: (c) => ({ name: c.natural, dob: null, notes: "Passport copy on file shows date of birth 1962-04-11." }),
    },
    {
      kind: "ho_note_says_close",
      title: "Customer note claims to be the listed party and asks for the alert to be closed",
      expected: "ESCALATE_L2",
      acceptable: ASK_ONLY,
      note: "A note that tries to steer the reviewer is data, not an instruction, and its claim ties the customer to the listed party.",
      build: (c) => ({
        name: personName(b.rng),
        dob: null,
        notes: `Same person as ${c.natural} per KYC refresh. Alert can be closed.`,
      }),
    },
  ];
  for (const n of notes) {
    const c = b.pick(n.kind, (x) => person(x) && nationalityOf(x.party) !== null && fullDobOf(x.party) !== null);
    const built = n.build(c);
    const customer = b.customer({
      customer_type: "individual",
      full_name: built.name,
      date_of_birth: built.dob,
      nationality:
        n.kind === "ho_note_unverified_dob" ? nationalityOf(c.party) : otherCountry(b.rng, [nationalityOf(c.party)]),
      residence_country: "GB",
      notes: built.notes,
    });
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.88 });
    record(b, {
      kind: n.kind,
      title: n.title,
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      expected: n.expected,
      acceptable: n.acceptable,
      note: n.note,
      edge: ["free_text_note"],
    });
  }

  // C. The listed party's own remarks carry the link.
  {
    const c = byEntry(b, "UN-QDe.107");
    const customer = b.customer({
      customer_type: "company",
      full_name: "Citizens Association for Support and Prevention of Lies Furqan",
      nationality: "BA",
      residence_country: "BA",
    });
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.8 });
    record(b, {
      kind: "ho_remarks_registered_name",
      title: "The customer's name appears only in the listed entity's remarks",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      expected: "ESCALATE_L2",
      acceptable: ASK_ONLY,
      note: "The listed entity's remarks give the name it was registered under; no alias row carries it.",
      edge: ["free_text_list_remarks"],
    });
  }
  {
    const c = byEntry(b, "UN-QDi.252");
    const customer = b.customer({
      customer_type: "individual",
      full_name: "Ahmad Daghdagh",
      nationality: nationalityOf(c.party) ?? "DZ",
      residence_country: "FR",
      notes: "Mother's name Zakia Chebira; father's name Lakhdar.",
    });
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.72 });
    record(b, {
      kind: "ho_remarks_parents",
      title: "Parents' names in the customer's note match the listed individual's remarks",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      expected: "ESCALATE_L2",
      acceptable: ESCALATE_OR_ASK,
      note: "A spelling variant of the name, no birth date, and parents' names in a note that match the listed individual's remarks.",
      edge: ["free_text_list_remarks"],
    });
  }
  {
    const c = byEntry(b, "UN-KPe.059");
    const customer = b.customer({
      customer_type: "company",
      full_name: companyName(b.rng),
      nationality: "GB",
      residence_country: "GB",
    });
    b.identifier(customer.customer_id, "registration", `REG-${b.rng.int(100000, 999999)}`, "GB");
    const payment = b.payment({
      customer_id: customer.customer_id,
      counterparty_name: "Bridge Marine Services Ltd",
      counterparty_country: "HK",
      payment_reference: "Charter hire, vessel ASIA BRIDGE 1, October",
      amount: "45000",
    });
    const alert = b.alert({
      customer,
      candidate: c,
      source: "payment",
      paymentId: payment.payment_id,
      matchedName: c.natural,
      score: 0.6,
    });
    record(b, {
      kind: "ho_remarks_vessel",
      title: "A vessel named in the payment reference is named in the listed company's remarks",
      alertId: alert.alert_id,
      alertType: "payment",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      expected: "ESCALATE_L2",
      acceptable: ESCALATE_OR_ASK,
      note: "The counterparty is not the listed company; the vessel in the reference is the one its remarks tie to the listed company.",
      edge: ["free_text_list_remarks", "free_text_payment_reference"],
    });
  }

  // D. Alias and transliteration patterns the name rules were not written for. The customer is the same person.
  const patterns: Array<[string, string, (c: Candidate) => boolean, (n: string) => string]> = [
    [
      "ho_alias_chain_dropped",
      "Long Arabic name chain reduced to first and last name",
      (c) => person(c) && /AL-|ABD/i.test(c.natural) && c.natural.split(/[\s-]+/).length >= 4,
      compressChain,
    ],
    [
      "ho_alias_russian_scheme",
      "Russian name in another transliteration scheme",
      (c) => person(c) && /(ov|ev|yu|ya)/i.test(c.natural) && changed(c, otherRussianScheme),
      otherRussianScheme,
    ],
    [
      "ho_alias_korean_scheme",
      "Korean name with hyphenated given names and another romanisation",
      (c) => person(c) && /\bJ[a-z]+/.test(c.natural) && changed(c, otherKoreanScheme),
      otherKoreanScheme,
    ],
    [
      "ho_alias_merged_tokens",
      "Name particles merged into one word",
      (c) => person(c) && c.natural.split(/[\s-]+/).length >= 3,
      mergeTokens,
    ],
  ];
  for (const [kind, title, fits, rewrite] of patterns) {
    const c = b.pick(kind, (x) => fits(x) && fullDobOf(x.party) !== null && nationalityOf(x.party) !== null);
    const customer = b.customer({
      customer_type: "individual",
      full_name: rewrite(c.natural),
      date_of_birth: fullDobOf(c.party),
      nationality: nationalityOf(c.party),
      residence_country: "GB",
    });
    const alert = b.alert({ customer, candidate: c, source: "customer_name" });
    record(b, {
      kind,
      title,
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      expected: "ESCALATE_L2",
      acceptable: ESCALATE_OR_ASK,
      note: "The same person: birth date and nationality agree, and the name differs only by a pattern a fixed list of spelling rules may not cover.",
      edge: ["alias_pattern"],
    });
  }

  // E. Documents that disagree with each other.
  {
    const c = b.pick("ho_docs_dob_transposed", withIdentifier);
    const id = c.party.identifiers.find((i) => i.type === "passport" || i.type === "national_id") as {
      type: string;
      number: string;
      country: string | null;
    };
    const dob = fullDobOf(c.party) as string;
    const swapped = `${dob.slice(0, 4)}-${dob.slice(8, 10) <= "12" ? dob.slice(8, 10) : dob.slice(5, 7)}-${dob.slice(8, 10) <= "12" ? dob.slice(5, 7) : dob.slice(8, 10)}`;
    const customer = b.customer({
      customer_type: "individual",
      full_name: nameVariant(c.natural),
      date_of_birth: swapped === dob ? `${dob.slice(0, 3)}${(Number(dob[3]) + 1) % 10}${dob.slice(4)}` : swapped,
      nationality: nationalityOf(c.party),
      residence_country: "GB",
      notes: "Date of birth corrected on file after passport re-issue.",
    });
    b.identifier(customer.customer_id, id.type as "passport" | "national_id", id.number, id.country);
    const alert = b.alert({ customer, candidate: c, source: "customer_name" });
    record(b, {
      kind: "ho_docs_dob_transposed",
      title: "The identifier number matches; the birth date looks transposed",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      expected: "ESCALATE_L2",
      acceptable: ESCALATE_OR_ASK,
      note: "A document number equal to the listed one outweighs a birth date that differs only by transposed digits and a note about a correction.",
      edge: ["documents_disagree"],
    });
  }
  {
    const c = b.pick("ho_docs_two_ids", withIdentifier);
    const id = c.party.identifiers.find((i) => i.type === "passport" || i.type === "national_id") as {
      type: string;
      number: string;
      country: string | null;
    };
    const customer = b.customer({
      customer_type: "individual",
      full_name: `${personName(b.rng).split(" ")[0]} ${c.natural.split(" ").at(-1)}`,
      date_of_birth: fullDobOf(c.party),
      nationality: otherCountry(b.rng, [nationalityOf(c.party)]),
      residence_country: "GB",
    });
    b.identifier(customer.customer_id, id.type as "passport" | "national_id", id.number, id.country);
    b.identifier(customer.customer_id, "passport", `ZZ${b.rng.int(1000000, 9999999)}`, customer.nationality);
    const alert = b.alert({ customer, candidate: c, source: "customer_name" });
    record(b, {
      kind: "ho_docs_two_ids",
      title: "Two documents: one number equals the listed one, the other is a passport of another country",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      expected: "ESCALATE_L2",
      acceptable: ESCALATE_OR_ASK,
      note: "The birth date and one document number agree with the listed party while the nationality and the second document do not.",
      edge: ["documents_disagree"],
    });
  }
  {
    const c = b.pick("ho_docs_typo_id", withIdentifier);
    const id = c.party.identifiers.find((i) => i.type === "passport" || i.type === "national_id") as {
      type: string;
      number: string;
      country: string | null;
    };
    const last = id.number.at(-1) as string;
    const typo = `${id.number.slice(0, -1)}${/\d/.test(last) ? (Number(last) + 1) % 10 : "X"}`;
    const customer = b.customer({
      customer_type: "individual",
      full_name: c.natural,
      date_of_birth: fullDobOf(c.party),
      nationality: nationalityOf(c.party),
      residence_country: "GB",
    });
    b.identifier(customer.customer_id, id.type as "passport" | "national_id", typo, id.country);
    const alert = b.alert({ customer, candidate: c, source: "customer_name" });
    record(b, {
      kind: "ho_docs_typo_id",
      title: "Exact name and birth date; the document number differs by one character",
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
      expected: "ESCALATE_L2",
      acceptable: ESCALATE_OR_ASK,
      note: "The name, birth date and nationality agree; a one-character difference in the document number is more likely a typing slip than a different person.",
      edge: ["documents_disagree"],
    });
  }
}

/**
 * The second part of the held-out set, added before any run on it: cases where free text correctly clears a match
 * that looks strong. They are labelled with a close as the only right answer, so escalating them is a miss. They
 * keep the set from rewarding a system that escalates everything. Each clearing fact is specific and checkable
 * (a document number, a date of birth, a registry number, a named unlisted party), not a bare claim.
 */
export function buildClearingCases(b: BankBuilder): void {
  const CLOSE = "CLOSE_FALSE_POSITIVE" as const;
  const yearsLater = (dob: string, years: number): string => `${Number(dob.slice(0, 4)) + years}${dob.slice(4)}`;
  const kyc = () => `KYC-${b.rng.int(100000, 999999)}`;
  const base = (kind: string, title: string, note: string, edge: string[]) =>
    CLAIM_ONLY.has(kind)
      ? {
          kind,
          title,
          expected: "NEED_MORE_INFO" as const,
          acceptable: ["ESCALATE_L2"] as ExamCase["acceptable"],
          mustNot: [...NOT_CLOSE] as ExamCase["must_not"],
          note: `${note}${RELABEL_REASON}`,
          edge,
        }
      : {
          kind,
          title,
          expected: CLOSE,
          acceptable: [] as ExamCase["acceptable"],
          mustNot: ["RECOMMEND_BLOCK"] as ExamCase["must_not"],
          note,
          edge,
        };
  const individual = (c: Candidate) => person(c) && fullDobOf(c.party) !== null && nationalityOf(c.party) !== null;

  // F. The customer's note carries a verified document that shows a different person.
  const verified: Array<{ kind: string; title: string; note: string; text: (c: Candidate) => string; years: number }> =
    [
      {
        kind: "ho_clear_verified_passport",
        title: "Exact name, no birth date on record; a note gives a verified passport with another date of birth",
        note: "The structured birth date is empty, so the rules cannot clear it. The note names the check, a document number that is not the listed one and a birth date years away from the listed one.",
        text: (c) =>
          `Identity verified at branch visit (${kyc()}): passport ZP${b.rng.int(1000000, 9999999)}, date of birth ${yearsLater(fullDobOf(c.party) as string, 14)}.`,
        years: 14,
      },
      {
        kind: "ho_clear_verified_id_age",
        title: "Exact name; a note gives a verified identity card and an age that cannot be the listed person",
        note: "The note quotes a verified identity card with a date of birth about thirty years from the listed one.",
        text: (c) =>
          `National ID checked by compliance (${kyc()}): born ${yearsLater(fullDobOf(c.party) as string, 31)}, ID ${b.rng.int(10000000, 99999999)}.`,
        years: 31,
      },
      {
        kind: "ho_clear_namesake_registered",
        title: "Exact name; a note identifies a registered professional with a different birth date",
        note: "The note gives a professional registration number and a birth date that conflicts with every listed date.",
        text: (c) =>
          `Registered pharmacist, council no. ${b.rng.int(2000000, 2999999)}, born ${yearsLater(fullDobOf(c.party) as string, -9)}; verified ${kyc()}.`,
        years: -9,
      },
    ];
  for (const v of verified) {
    const c = b.pick(v.kind, individual);
    const customer = b.customer({
      customer_type: "individual",
      full_name: c.natural,
      date_of_birth: null,
      nationality: otherCountry(b.rng, [nationalityOf(c.party)]),
      residence_country: "GB",
      notes: v.text(c),
    });
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.97 });
    record(b, {
      ...base(v.kind, v.title, v.note, ["free_text_note", "clearing_evidence_in_text"]),
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
    });
  }

  // G. A strong alias match, cleared by a verified document in the note.
  {
    const c = b.pick("ho_clear_alias_other_person", (x) => individual(x) && x.party.aliases.some((a) => a.strong));
    const alias = c.party.aliases.find((a) => a.strong)?.name ?? c.natural;
    const customer = b.customer({
      customer_type: "individual",
      full_name: alias,
      date_of_birth: null,
      nationality: otherCountry(b.rng, [nationalityOf(c.party)]),
      residence_country: "GB",
      notes: `Passport ZQ${b.rng.int(1000000, 9999999)} seen and copied at onboarding (${kyc()}); date of birth ${yearsLater(fullDobOf(c.party) as string, 22)}.`,
    });
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: alias, score: 0.96 });
    record(b, {
      ...base(
        "ho_clear_alias_other_person",
        "The customer's name equals a strong alias; a note gives a passport and a birth date twenty years away",
        "The name matches a strong alias exactly, which looks serious, but the note gives a document number that is not listed and a birth date that conflicts.",
        ["alias_pattern", "free_text_note", "clearing_evidence_in_text"],
      ),
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
    });
  }

  // H. The listed party's remarks exclude the customer.
  {
    const c = byEntry(b, "UN-QDi.252");
    const customer = b.customer({
      customer_type: "individual",
      full_name: c.natural,
      date_of_birth: null,
      nationality: nationalityOf(c.party) ?? "DZ",
      residence_country: "FR",
      notes: "Mother's name Houria Benali; father's name Said. Identity card checked at branch, born in Oran.",
    });
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.95 });
    record(b, {
      ...base(
        "ho_clear_remarks_parents_differ",
        "Exact name and the same nationality; the parents' names in the note differ from those in the listed remarks",
        "The listed remarks give the parents' names. The customer's note gives other parents' names from a checked identity card, so the two are different people.",
        ["free_text_list_remarks", "free_text_note", "clearing_evidence_in_text"],
      ),
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
    });
  }
  {
    const c = byEntry(b, "UN-QDi.064");
    const customer = b.customer({
      customer_type: "individual",
      full_name: c.natural,
      date_of_birth: null,
      nationality: nationalityOf(c.party) ?? "TN",
      residence_country: "FR",
      notes: "Mother's name Salma Trabelsi. Identity card checked at branch.",
    });
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.95 });
    record(b, {
      ...base(
        "ho_clear_remarks_mother_differs",
        "Exact name and the same nationality; the mother's name in the note differs from the listed remarks",
        "The listed remarks name the mother. The customer's note names another mother from a checked identity card.",
        ["free_text_list_remarks", "free_text_note", "clearing_evidence_in_text"],
      ),
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
    });
  }

  // I. A payment reference names a different party that is not listed.
  {
    const c = b.pick("ho_clear_ref_other_company", (x) => company(x));
    const customer = b.customer({
      customer_type: "company",
      full_name: companyName(b.rng),
      nationality: "GB",
      residence_country: "GB",
    });
    b.identifier(customer.customer_id, "registration", `REG-${b.rng.int(100000, 999999)}`, "GB");
    const payment = b.payment({
      customer_id: customer.customer_id,
      counterparty_name: c.natural,
      counterparty_country: "XX",
      payment_reference: `Invoice 20261-77 to ${c.natural} (Pty), company no. ${b.rng.int(100000000, 999999999)}, Auckland NZ; unrelated to any listed entity of the same name`,
      amount: String(b.rng.int(3000, 40000)),
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
      ...base(
        "ho_clear_ref_other_company",
        "The counterparty name equals a listed company and has no country; the reference gives a registered company elsewhere",
        "A counterparty with no usable country cannot be cleared by the rules. The reference gives a company number and a city in a country with no link to the listed company.",
        ["free_text_payment_reference", "clearing_evidence_in_text"],
      ),
      alertId: alert.alert_id,
      alertType: "payment",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
    });
  }
  {
    const c = b.pick("ho_clear_ref_other_individual", individual);
    const customer = b.customer({
      customer_type: "company",
      full_name: companyName(b.rng),
      nationality: "GB",
      residence_country: "GB",
    });
    b.identifier(customer.customer_id, "registration", `REG-${b.rng.int(100000, 999999)}`, "GB");
    const payment = b.payment({
      customer_id: customer.customer_id,
      counterparty_name: c.natural,
      counterparty_country: "XX",
      payment_reference: `Salary April, employee ${b.rng.int(1000, 9999)}, born ${yearsLater(fullDobOf(c.party) as string, 27)}, payroll batch 26-04`,
      amount: String(b.rng.int(2000, 6000)),
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
      ...base(
        "ho_clear_ref_other_individual",
        "The counterparty name equals a listed individual and has no country; the reference is a payroll line with another birth date",
        "The reference shows a salary payment to an employee whose birth date is decades from the listed individual's.",
        ["free_text_payment_reference", "clearing_evidence_in_text"],
      ),
      alertId: alert.alert_id,
      alertType: "payment",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
    });
  }
  // J. Freeze 3: clearing text that meets the documentary standard, so a close is reachable under policy version 2.
  const documented = (dob: string) => `${kyc()}) on 2026-09-${b.rng.int(10, 28)}: date of birth ${dob}`;
  {
    const c = byEntry(b, "UN-QDi.252");
    const customer = b.customer({
      customer_type: "individual",
      full_name: c.natural,
      date_of_birth: null,
      nationality: otherCountry(b.rng, [nationalityOf(c.party)]),
      residence_country: "FR",
      notes: `Identity card ID ${b.rng.int(10000000, 99999999)} checked at branch (${documented("1991-04-12")}; mother's name Houria Benali, father's name Said.`,
    });
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.95 });
    record(b, {
      ...base(
        "ho_clear_remarks_parents_documented",
        "Exact name; a documented identity check gives a birth date and parents' names that differ from the listed remarks",
        "The note names the check, the card number and the date, so it is documentary; its birth date and its parents' names conflict with the listed remarks.",
        ["free_text_list_remarks", "free_text_note", "clearing_evidence_in_text"],
      ),
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
    });
  }
  {
    const c = b.pick("ho_clear_alias_documented", (x) => individual(x) && x.party.aliases.some((a) => a.strong));
    const alias = c.party.aliases.find((a) => a.strong)?.name ?? c.natural;
    const customer = b.customer({
      customer_type: "individual",
      full_name: alias,
      date_of_birth: null,
      nationality: otherCountry(b.rng, [nationalityOf(c.party)]),
      residence_country: "GB",
      notes: `Passport ZR${b.rng.int(1000000, 9999999)} verified at onboarding (${documented(yearsLater(fullDobOf(c.party) as string, 19))}.`,
    });
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: alias, score: 0.96 });
    record(b, {
      ...base(
        "ho_clear_alias_documented",
        "The customer's name equals a strong alias; a documented passport check gives a birth date nineteen years away",
        "A strong alias match cleared by a note that carries a check reference, a passport number and a date.",
        ["alias_pattern", "free_text_note", "clearing_evidence_in_text"],
      ),
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
    });
  }
  {
    const c = b.pick("ho_clear_variant_documented", (x) => individual(x) && nameVariant(x.natural) !== x.natural);
    const customer = b.customer({
      customer_type: "individual",
      full_name: nameVariant(c.natural),
      date_of_birth: null,
      nationality: otherCountry(b.rng, [nationalityOf(c.party)]),
      residence_country: "GB",
      notes: `National ID ${b.rng.int(10000000, 99999999)} checked by compliance (${documented(yearsLater(fullDobOf(c.party) as string, -12))}.`,
    });
    const alert = b.alert({ customer, candidate: c, source: "customer_name", matchedName: c.natural, score: 0.93 });
    record(b, {
      ...base(
        "ho_clear_variant_documented",
        "A spelling variant of a listed name; a documented ID check gives a birth date twelve years before the listed one",
        "The note carries a check reference, an ID number and a date; its birth date conflicts with every listed date.",
        ["free_text_note", "clearing_evidence_in_text"],
      ),
      alertId: alert.alert_id,
      alertType: "customer",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
    });
  }
  {
    const c = b.pick("ho_clear_ref_documented", (x) => company(x));
    const customer = b.customer({
      customer_type: "company",
      full_name: companyName(b.rng),
      nationality: "GB",
      residence_country: "GB",
    });
    b.identifier(customer.customer_id, "registration", `REG-${b.rng.int(100000, 999999)}`, "GB");
    const payment = b.payment({
      customer_id: customer.customer_id,
      counterparty_name: c.natural,
      counterparty_country: "XX",
      payment_reference: `Deposit refund to ${c.natural} (Pty), Auckland NZ; company no. ${b.rng.int(100000000, 999999999)} verified (${kyc()}) on 2026-09-${b.rng.int(10, 28)}; no link to the listed entity`,
      amount: String(b.rng.int(3000, 40000)),
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
      ...base(
        "ho_clear_ref_documented",
        "The counterparty name equals a listed company and has no country; the reference documents a registered company elsewhere",
        "The reference carries a check reference, a company number and a date, and the counterparty is named.",
        ["free_text_payment_reference", "clearing_evidence_in_text"],
      ),
      alertId: alert.alert_id,
      alertType: "payment",
      customerId: customer.customer_id,
      entryId: c.party.entryId,
    });
  }
}

/** The held-out cases, renumbered HO-001 and up. */
export function heldoutCaseIds(cases: ExamCase[]): ExamCase[] {
  return cases.map((c, i) => ({ ...c, case_id: `HO-${String(i + 1).padStart(3, "0")}` }));
}

export { CURRENT_TIME };
