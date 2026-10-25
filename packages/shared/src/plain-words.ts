import type { Decision } from "./schemas.js";

/**
 * Plain words for the codes the comparison writes into a rationale (missing_customer, conflict, token_set, ...), for
 * text a person reads in a case file. The sealed decision record keeps the codes. The desk's screen says them the same
 * way (apps/web/lib/format.ts; a test keeps the two in step).
 */

export const DECISION_WORDS: Record<Decision, string> = {
  CLOSE_FALSE_POSITIVE: "Close as false positive",
  ESCALATE_L2: "Escalate to level 2",
  RECOMMEND_BLOCK: "Recommend block (two approvals)",
  NEED_MORE_INFO: "Need more information",
};

const DOB_WORDS: Record<string, string> = {
  exact: "the same date",
  compatible: "compatible (not ruled out)",
  conflict: "conflicts",
  missing_customer: "customer has no date of birth on record",
  missing_list: "the list gives no date of birth",
};
/** On a payment the compared party is the counterparty, and a payment carries no date of birth. */
const PAYMENT_DOB_WORDS: Record<string, string> = {
  ...DOB_WORDS,
  missing_customer: "the payment gives no date of birth for the counterparty",
};
const COUNTRY_WORDS: Record<string, string> = {
  match: "matches",
  address_only: "only an address matches",
  conflict: "conflicts",
  unknown: "not known",
};
const NAME_METHOD_WORDS: Record<string, string> = {
  exact: "exact",
  token_set: "same words",
  phonetic: "sounds alike",
  none: "no match",
};
const ASSESSMENT_WORDS: Record<string, string> = { strong: "strong", possible: "possible", weak: "weak" };

const words = (map: Record<string, string>, code: string): string => map[code] ?? code.replaceAll("_", " ");

/**
 * A comparison reason or a rationale with its codes in plain words and the compared name labelled: on a payment alert
 * the name compared is the payment counterparty's, on any other alert the customer's.
 */
export function plainReason(text: string, alertType?: string | null): string {
  const payment = alertType === "payment";
  const who = payment ? "payment counterparty name" : "customer name";
  const dob = payment ? PAYMENT_DOB_WORDS : DOB_WORDS;
  return (
    text
      // name 1.00 (exact) vs primary "X"
      .replace(
        /\bname (\d(?:\.\d+)?) \((\w+)\) vs (\w+) "/g,
        (_m, score: string, method: string, alias: string) =>
          `${who}: ${score} ${words(NAME_METHOD_WORDS, method)}, against the listed ${alias.replaceAll("_", " ")} name "`,
      )
      // the stand-in's "Name is weak": that is the whole comparison, not the name
      .replace(
        /\bName is (\w+)/g,
        (_m, a: string) => `Overall match (all facts together) is ${words(ASSESSMENT_WORDS, a)}`,
      )
      .replace(/\bdate of birth(?::| is) (\w+)/g, (_m, code: string) => `date of birth: ${words(dob, code)}`)
      .replace(
        /\b(country|nationality)(?::| is) (\w+)/g,
        (_m, what: string, code: string) =>
          `${payment && what === "country" ? "counterparty country" : what}: ${words(COUNTRY_WORDS, code)}`,
      )
  );
}
