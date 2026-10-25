import type { MeView } from "./types";

/**
 * What each role may do: a copy of PERMISSIONS in packages/shared/src/auth.ts, which the interface cannot import (it
 * pulls in Node modules). A test keeps the two equal. The server is the rule; this only lets a screen grey out a
 * button the server would certainly refuse, and say why in plain words.
 */
export const PERMISSIONS = {
  run: ["analyst", "approver", "policy_admin"],
  decide: ["analyst", "approver"],
  approveBlock: ["approver"],
  overrideTowardsLessCaution: ["approver"],
  proposePolicy: ["approver", "policy_admin"],
  publishPolicy: ["policy_admin"],
  stopAutonomy: ["approver", "policy_admin"],
  restoreAutonomy: ["policy_admin"],
} as const;
export type Permission = keyof typeof PERMISSIONS;

const ROLE_ORDER = ["analyst", "approver", "policy_admin"] as const;
const ROLE_WORDS: Record<string, string> = {
  analyst: "an analyst",
  approver: "an approver",
  policy_admin: "a policy admin",
};

interface ActionRule {
  /** What the person is trying to do, as the sentence ends: "Only an approver can <doing>." */
  doing: string;
  /** The check on the route (apps/api/src/access.ts). Skipped with sign-in off, and for `run` in sample mode. */
  route: Permission;
  /** Checks the handler makes itself, whatever the sign-in mode. */
  handler: readonly Permission[];
}

/** Every action a screen offers that the server can refuse for a role, with the checks the server makes. */
export const ACTIONS = {
  review: { doing: "start a review", route: "run", handler: [] },
  listChange: { doing: "check earlier decisions against the list", route: "run", handler: [] },
  preview: { doing: "preview a draft on the exam", route: "run", handler: [] },
  decide: { doing: "record a decision", route: "decide", handler: ["decide"] },
  reopen: { doing: "reopen an automatic close", route: "decide", handler: ["decide"] },
  overrideLessCautious: {
    doing: "override towards a less cautious outcome",
    route: "decide",
    handler: ["decide", "overrideTowardsLessCaution"],
  },
  secondApproval: { doing: "give the second approval", route: "decide", handler: ["decide", "approveBlock"] },
  propose: { doing: "propose a policy change", route: "proposePolicy", handler: [] },
  discard: { doing: "discard a draft", route: "proposePolicy", handler: [] },
  publish: { doing: "publish a draft", route: "publishPolicy", handler: [] },
  stopAutonomy: { doing: "stop autonomy", route: "stopAutonomy", handler: [] },
  restoreAutonomy: { doing: "switch autonomy back on", route: "stopAutonomy", handler: ["restoreAutonomy"] },
} as const satisfies Record<string, ActionRule>;
export type Action = keyof typeof ACTIONS;

/**
 * Who is using the screen: the answer from /me, "signed_out" when /me said 401, or undefined while it is not known
 * (still loading, or the API could not be reached). Nothing is greyed out while it is not known.
 */
export type Who = MeView | "signed_out" | undefined;

/** The roles that pass every check in the list, in a fixed order. */
const rolesWith = (needs: readonly Permission[]): string[] =>
  ROLE_ORDER.filter((role) => needs.every((p) => (PERMISSIONS[p] as readonly string[]).includes(role)));

const joinOr = (words: string[]): string =>
  words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;

/** "Only an analyst or an approver can record a decision." The sentence for a role that may not do the action. */
export function onlySentence(action: Action): string {
  const rule: ActionRule = ACTIONS[action];
  const needs = [rule.route, ...rule.handler];
  return `Only ${joinOr(rolesWith(needs).map((r) => ROLE_WORDS[r] ?? r))} can ${rule.doing}.`;
}

/** The checks the server makes for this action under this sign-in mode. */
function needsFor(action: Action, auth: MeView["auth"]): Permission[] {
  const rule: ActionRule = ACTIONS[action];
  // With sign-in off the route check is skipped; in sample mode anyone may run a review.
  const routeApplies = auth === "on" || (auth === "demo" && rule.route !== "run");
  return [...(routeApplies ? [rule.route] : []), ...rule.handler];
}

/** The four-eyes facts an action depends on: who made the first decision, who wrote the draft. */
export interface FourEyes {
  firstActor?: string;
  proposedBy?: string;
}

/**
 * Why the server would refuse this person this action, in one short sentence, or undefined when it would not
 * certainly refuse. Only a refusal the server is sure to give is reported: never grey out what the server allows.
 */
export function refusal(who: Who, action: Action, facts: FourEyes = {}): string | undefined {
  if (who === undefined) return undefined;
  if (who === "signed_out") return `Sign in to ${ACTIONS[action].doing}.`;
  const role = who.user.role;
  if (!needsFor(action, who.auth).every((p) => (PERMISSIONS[p] as readonly string[]).includes(role)))
    return onlySentence(action);
  // Four-eyes: the server compares the person's id; an anonymous caller has no id of their own.
  const named = who.user.id !== "anonymous";
  if (action === "secondApproval" && named && facts.firstActor !== undefined && facts.firstActor === who.user.id)
    return "A different approver must give the second approval.";
  if (action === "publish" && named && facts.proposedBy !== undefined && facts.proposedBy === who.user.id)
    return "A different policy admin must publish this draft.";
  return undefined;
}

/** Who is using the screen, from the outcome of /me: a 401 means signed out, any other failure is not known. */
export const whoFromError = (err: unknown): Who =>
  (err as { status?: unknown } | null)?.status === 401 ? "signed_out" : undefined;

/**
 * What to show when an action failed. A refusal for the role (403) is said as the same plain sentence the greyed-out
 * button uses; the server's own message is unchanged. Anything else is shown as the server said it.
 */
export function actionProblem(err: unknown, action: Action): string {
  const status = (err as { status?: unknown } | null)?.status;
  const message = err instanceof Error ? err.message : String(err);
  if (status === 401) return `Sign in to ${ACTIONS[action].doing}.`;
  if (status !== 403) return message;
  if (action === "secondApproval" && /different person/i.test(message))
    return "A different approver must give the second approval.";
  if (/ must be you /.test(message)) return message;
  return onlySentence(action);
}
