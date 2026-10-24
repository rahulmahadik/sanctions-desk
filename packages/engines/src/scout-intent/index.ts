/**
 * Scout Intent: senses the intent of a text against a registry of intents, checks it for injected instructions,
 * routes the intent to the capabilities it declares, and issues a signed execution contract. An implementation of
 * the Meterless Scout Intent specification (engines/scout-intent: docs/architecture.md, docs/scoring.md,
 * docs/execution-contract.md), Stage 1 only: a deterministic trigger scan over the registry, with no model call.
 *
 * Self-contained (node:crypto and node:fs only), so the official eval harness can load it directly with
 * SCOUT_IMPL=packages/engines/src/scout-intent/index.ts.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

export interface IntentDef {
  id: string;
  category?: string;
  description?: string;
  capabilities: string[];
  riskClass: "low" | "medium" | "high";
  surfaces?: string[];
  roles?: string[];
  examples: string[];
  version?: number;
}

export interface IntentRegistry {
  version: number;
  intents: IntentDef[];
}

export interface Candidate {
  intent: string;
  score: number;
}

export type RiskLevel = "low" | "medium" | "high" | "block";

export interface RiskFlag {
  kind: "pattern" | "role-drift" | "tool-ref" | "control-bytes" | "role-scope";
  evidence: string;
}

export interface ToolStep {
  capability: string;
  tool: string;
}

export interface ExecutionContract {
  contractId: string;
  traceId: string;
  intent: {
    primary: { id: string; version: number };
    parameters: Record<string, unknown>;
    confidence: number;
    alternates: Candidate[];
  };
  risk: { level: "low" | "medium" | "high"; flags: RiskFlag[]; redactions: never[]; approvals: never[] };
  toolPlan: ToolStep[];
  modelProfile: { id: string };
  scope: { user: { id: string; role: string }; surface: string; capabilities: string[] };
  issuedAt: string;
  expiresAt: string;
  registryVersion: number;
  policyPackVersion: string;
  signature: string;
  signedBy: "scout";
}

export interface DecideInput {
  prompt: string;
  user: { id: string; role: string };
  surface?: string;
}

export interface Decision {
  candidates: Candidate[];
  /** Every intent at or above the Medium band floor that rests on its own words, for composed requests. */
  intents: Candidate[];
  risk: { level: RiskLevel; flags: RiskFlag[]; reason?: string };
  toolPlan: ToolStep[];
  clarification: boolean;
  /** Absent when the request is blocked: nothing downstream may act on it. */
  executionContract?: ExecutionContract;
}

export interface ScoutOptions {
  /** A registry object, or the path of a registry JSON file. */
  intentRegistry: IntentRegistry | string;
  policyPack?: string | string[];
  /** HMAC secret for contract signatures; a random per-instance secret when absent. */
  secret?: string | Buffer;
  /** Contract lifetime (default 5 minutes, as the specification sets). */
  ttlMs?: number;
  /** Fixed clock, for reproducible contracts in tests. */
  now?: () => Date;
}

/** Score bands from the specification (docs/scoring.md). */
export const BANDS = { high: 0.8, medium: 0.55, low: 0.4 } as const;
const FALLBACK = "GENERAL";

const STOP = new Set(
  "a an the and or of to for in on at by with from me my our we you your i it its is are be this that these those what whats how do does can will should please all any some about into over up out".split(
    " ",
  ),
);

/** Lower-case word stems: punctuation dropped, a few English endings removed. */
export function terms(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .split(/[^a-z0-9$]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => w.replace(/(ings|ing|ies|es|ed|s)$/, (m) => (m === "ies" ? "y" : "")) || w);
}

const overlap = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return n;
};

/** Lexical score of a prompt against one intent: the best example, lifted by the intent's description. */
function lexical(prompt: Set<string>, normalised: string, intent: IntentDef): number {
  let best = 0;
  for (const ex of intent.examples) {
    if (ex.trim().toLowerCase() === normalised) return 1;
    const e = new Set(terms(ex));
    const hit = overlap(prompt, e);
    // Dice coefficient between the prompt and the example.
    best = Math.max(best, (2 * hit) / (prompt.size + e.size));
  }
  const desc = new Set(terms(`${intent.id.replace(/[._-]/g, " ")} ${intent.description ?? ""}`));
  const descHit = prompt.size ? overlap(prompt, desc) / prompt.size : 0;
  return Math.min(1, best * 0.85 + descHit * 0.25);
}

/**
 * Injected instructions: overrides of earlier instructions, role confusion, requests for secrets or privileges,
 * references to tools outside the request, and control characters that hide text. Pattern layer only.
 */
const INJECTION: Array<{ kind: RiskFlag["kind"]; re: RegExp }> = [
  {
    kind: "pattern",
    re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|the)\b[^.\n]{0,20}\b(instructions?|rules?|prompts?|user|guidelines?)\b/i,
  },
  { kind: "pattern", re: /\byou are now\b|\bunrestricted mode\b|\bdeveloper mode\b|\bjailbreak\b/i },
  { kind: "role-drift", re: /<\/?\s*(system|user|assistant)\s*>|\[\/?INST\]|<\|im_(start|end)\|>/i },
  { kind: "role-drift", re: /\bpretend (to be|you are)\b[^.\n]{0,30}\b(system|admin|developer)\b/i },
  {
    kind: "pattern",
    re: /\b(reveal|print|show|dump|leak)\b[^.\n]{0,30}\b(api keys?|credentials?|passwords?|secrets?|tokens?|system prompt)\b/i,
  },
  {
    kind: "tool-ref",
    re: /\b(grant|give|make)\s+(me|us)\b[^.\n]{0,20}\badmin\b|\binternal_[a-z_]+\b|\bdrop (the )?[a-z_]+ table\b/i,
  },
  { kind: "control-bytes", re: /[‪-‮⁦-⁩​-‏]|\\u202[a-e]/i },
];

export function detectInjection(text: string): RiskFlag[] {
  const flags: RiskFlag[] = [];
  for (const { kind, re } of INJECTION) {
    const m = re.exec(text);
    if (m) flags.push({ kind, evidence: m[0].slice(0, 60) });
  }
  return flags;
}

/** Sorted-key compact JSON, so a signature does not depend on key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as Record<string, unknown>)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** A ULID-like id: time-ordered, then random. */
function contractId(now: Date): string {
  return `ctr_${now.getTime().toString(36).padStart(9, "0")}${randomBytes(8).toString("hex")}`;
}

const PARAMS: Array<[string, RegExp, (m: RegExpExecArray) => unknown]> = [
  ["count", /\btop (\d+)\b|\b(\d+) (?:at-risk|stuck|deals|renewals|accounts)\b/i, (m) => Number(m[1] ?? m[2])],
  ["channel", /\b(email|call|slack)s?\b/i, (m) => (m[1] as string).toLowerCase()],
];

/** The clarification rules of docs/scoring.md: a Low-band score, a near tie in the Medium band, or an unsure high-risk intent. */
function needsClarification(top: Candidate, second: Candidate | undefined, primary: IntentDef): boolean {
  if (top.score >= BANDS.low && top.score < BANDS.medium) return true;
  if (top.score >= BANDS.medium && top.score < BANDS.high && second && top.score - second.score < 0.05) return true;
  return primary.riskClass === "high" && top.score < 0.95;
}

export class Scout {
  readonly registry: IntentRegistry;
  readonly policyPackVersion: string;
  private readonly secret: Buffer;
  private readonly ttlMs: number;
  private readonly now: () => Date;
  private readonly byId: Map<string, IntentDef>;

  constructor(opts: ScoutOptions) {
    this.registry =
      typeof opts.intentRegistry === "string"
        ? (JSON.parse(readFileSync(opts.intentRegistry, "utf8")) as IntentRegistry)
        : opts.intentRegistry;
    if (!Array.isArray(this.registry.intents) || this.registry.intents.length === 0)
      throw new Error("the intent registry has no intents");
    this.byId = new Map(this.registry.intents.map((i) => [i.id, i]));
    this.policyPackVersion = [opts.policyPack ?? "default"].flat().join("+");
    this.secret = opts.secret ? Buffer.from(opts.secret) : randomBytes(32);
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.now = opts.now ?? (() => new Date());
  }

  /** Stage 1 of Sense: every registered intent scored against the text, highest first. */
  sense(prompt: string): Candidate[] {
    const p = new Set(terms(prompt));
    const normalised = prompt.trim().toLowerCase();
    return this.registry.intents
      .map((i) => ({ intent: i.id, score: Math.round(lexical(p, normalised, i) * 1000) / 1000 }))
      .sort((a, b) => b.score - a.score || a.intent.localeCompare(b.intent));
  }

  /** Composed requests: score each clause on its own and keep every intent in the Medium band or above. */
  private composed(prompt: string): Candidate[] {
    const clauses = prompt
      .split(/,|;|\band (?:then |also )?(?=[a-z]+\b)/i)
      .map((c) => c.trim())
      .filter((c) => terms(c).length >= 2);
    const found = new Map<string, number>();
    for (const c of clauses) {
      const top = this.sense(c)[0];
      if (top && top.score >= BANDS.medium && top.intent !== FALLBACK)
        found.set(top.intent, Math.max(found.get(top.intent) ?? 0, top.score));
    }
    return [...found].map(([intent, score]) => ({ intent, score }));
  }

  sign(contract: Omit<ExecutionContract, "signature">): string {
    return createHmac("sha256", this.secret).update(canonical(contract)).digest("hex");
  }

  /** Verify a contract's signature and lifetime; downstream steps refuse anything that fails. */
  verify(contract: ExecutionContract, at: Date = this.now()): { ok: boolean; reason?: string } {
    const { signature, ...rest } = contract;
    const expected = Buffer.from(this.sign(rest), "hex");
    const got = Buffer.from(signature ?? "", "hex");
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return { ok: false, reason: "signature" };
    if (at.getTime() > Date.parse(contract.expiresAt)) return { ok: false, reason: "expired" };
    return { ok: true };
  }

  async decide(input: DecideInput): Promise<Decision> {
    return this.decideSync(input);
  }

  decideSync(input: DecideInput): Decision {
    const surface = input.surface ?? "chat";
    const flags = detectInjection(input.prompt);
    const candidates = this.sense(input.prompt);
    const top = candidates[0] as Candidate;
    const primaryId = top.score >= BANDS.low ? top.intent : FALLBACK;
    const primary = this.byId.get(primaryId) ?? (this.byId.get(top.intent) as IntentDef);
    const toolPlan = primary.capabilities.map((c) => ({ capability: c, tool: c }));
    if (flags.length > 0) {
      return {
        candidates,
        intents: [],
        risk: { level: "block", flags, reason: "injected instructions in the request" },
        toolPlan: [],
        clarification: false,
      };
    }
    const clarification = needsClarification(top, candidates[1], primary);
    const parameters: Record<string, unknown> = {};
    for (const [name, re, read] of PARAMS) {
      const m = re.exec(input.prompt);
      if (m) parameters[name] = read(m);
    }
    const now = this.now();
    const unsigned: Omit<ExecutionContract, "signature"> = {
      contractId: contractId(now),
      traceId: `trc_${randomBytes(8).toString("hex")}`,
      intent: {
        primary: { id: primary.id, version: primary.version ?? 1 },
        parameters,
        confidence: primaryId === FALLBACK && top.intent !== FALLBACK ? 1 - top.score : top.score,
        alternates: candidates.slice(1, 3),
      },
      risk: { level: primary.riskClass, flags: [], redactions: [], approvals: [] },
      toolPlan,
      modelProfile: { id: primary.riskClass === "high" ? "careful" : "fast" },
      scope: { user: { id: input.user.id, role: input.user.role }, surface, capabilities: [...primary.capabilities] },
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      registryVersion: this.registry.version,
      policyPackVersion: this.policyPackVersion,
      signedBy: "scout",
    };
    const composed = this.composed(input.prompt);
    return {
      candidates,
      intents: composed.length > 1 ? composed : [{ intent: primary.id, score: top.score }],
      risk: { level: primary.riskClass, flags: [] },
      toolPlan,
      clarification,
      executionContract: { ...unsigned, signature: this.sign(unsigned) },
    };
  }
}
