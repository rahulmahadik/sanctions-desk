import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DecisionRecord, TraceEvent } from "@sanctions-desk/shared";
import type { ActionCheck, ActionRecord } from "./actions.js";
import { humanState } from "./human-state.js";
import type { ListChangeReport } from "./list-change.js";
import type { TraceContract } from "./trace-contract.js";

const DECISION_TEXT: Record<string, string> = {
  CLOSE_FALSE_POSITIVE: "Close as a false positive",
  ESCALATE_L2: "Escalate to level 2",
  RECOMMEND_BLOCK: "Recommend a block (needs two approvals)",
  NEED_MORE_INFO: "Need more information",
};

export interface CaseFileInput {
  title: string;
  /** What the case is, in a sentence or two. */
  summary: string;
  record: DecisionRecord;
  events: readonly TraceEvent[];
  contract: TraceContract;
  /** Files saved beside the case file, by name. */
  files: { record: string; trace: string; events: string };
  /** The records prepared after a person's decision, with the result of checking each one's seal. */
  actions?: ReadonlyArray<ActionRecord & { check?: ActionCheck }>;
  /** The facts the case rests on, as label and value, with identifier numbers already masked. */
  facts?: ReadonlyArray<{ label: string; value: string }>;
}

/** The events of the newest run recorded in a record's trace file, up to a few seconds after the record was sealed. */
export function readRunEvents(logDir: string, record: DecisionRecord): TraceEvent[] {
  const file = join(logDir, `trace-${record.run_id}.jsonl`);
  if (!existsSync(file)) return [];
  const all = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TraceEvent);
  // The file holds every run of this case, each starting again at event 0. The sealed record is the newest run's.
  const start = all.map((e) => e.seq).lastIndexOf(0);
  const until = new Date(Date.parse(record.decided_at) + 5000).toISOString();
  return all.slice(Math.max(0, start)).filter((e) => e.ts <= until);
}

const STATUS_TEXT: Record<string, string> = {
  awaiting: "waiting for a person to decide",
  auto_closed: "closed automatically; a person can reopen it",
  decided: "decided by a person",
  block_pending: "block approval pending: a second, different approver must confirm",
  block_approved: "a block recommendation, approved by two people",
  block_declined: "the block was declined by the second approver; escalated",
};
const CHECK_TEXT: Record<string, string> = {
  signed_and_pinned: "signed (Ed25519), key matches the configured public key",
  signed_unpinned: "signed (Ed25519), key not pinned",
  hash_sealed: "hash-sealed (no signing key configured)",
  invalid: "does not verify",
};

const cell = (text: string): string => text.replaceAll("|", "/").replaceAll("\n", " ");
const money = (n: number, currency: string): string => `${n.toFixed(4)} ${currency}`;

/** The steps a reader can follow: every event that says what a step found, in order. */
function timeline(events: readonly TraceEvent[]): string[] {
  const keep = events.filter((e) => e.output_summary && e.agent !== "system" && e.action !== "model_answer");
  return keep.map(
    (e, i) => `${i + 1}. **${e.agent.replaceAll("_", " ")}** (${e.action.replaceAll("_", " ")}): ${e.output_summary}`,
  );
}

const pct = (n: number): number => Math.round(n * 100);
const word = (text: string): string => text.replaceAll("_", " ");

function recommendationSection({ record }: CaseFileInput): string[] {
  const cap = record.confidence_cap
    ? ` (capped at ${pct(record.confidence_cap.value)}%: ${record.confidence_cap.reason})`
    : "";
  const lines = [
    "## Recommendation",
    "",
    `**${DECISION_TEXT[record.decision] ?? record.decision}** · confidence ${pct(record.confidence)}%${cap}`,
    "",
    record.rationale,
    "",
  ];
  if (record.what_would_change.length > 0) {
    lines.push("**What would change this**", "", ...record.what_would_change.map((w) => `- ${w}`), "");
  }
  return lines;
}

function pathSection({ record }: CaseFileInput): string[] {
  if (!record.review_path) return [];
  const finding = `Code's first finding from the structured fields was **${DECISION_TEXT[record.first_finding ?? ""] ?? record.first_finding}**`;
  return [
    "## Path",
    "",
    record.review_path === "confirm"
      ? `${finding}, and the structured evidence settles the case, so the agents confirmed and explained it.`
      : `${finding}, but the structured evidence does not settle the case or there is free text to weigh, so the agents reasoned over all of it.`,
    "",
  ];
}

function documentarySection({ record }: CaseFileInput): string[] {
  if (!record.documentary?.length) return [];
  return [
    "## Values taken from verified notes",
    "",
    ...record.documentary.map(
      (d) =>
        `- ${d.label}: **${d.value}**. This is not a value of the customer record; the data-quality finding stays.`,
    ),
    "",
  ];
}

function factsSection({ facts }: CaseFileInput): string[] {
  return facts?.length
    ? ["## Facts the case rests on", "", ...facts.map((f) => `- **${f.label}:** ${f.value}`), ""]
    : [];
}

function autonomyText(a: NonNullable<DecisionRecord["autonomy"]>): string {
  if (a.outcome === "auto_closed") return `**${a.statement}.**`;
  if (a.outcome === "qa_sample")
    return "This close met every condition for an automatic close and was picked at random for a quality-assurance review by a person.";
  const unmet =
    a.conditions
      .filter((c) => !c.met)
      .map((c) => word(c.name))
      .join(", ") || "none";
  return `Level ${a.level_in_force} was in force; the recommendation goes to a person. Conditions not met: ${unmet}.`;
}

function autonomySection({ record }: CaseFileInput): string[] {
  return record.autonomy ? ["## Autonomy", "", autonomyText(record.autonomy), ""] : [];
}

function peopleSection({ record }: CaseFileInput): string[] {
  const lines = [
    "## What people did",
    "",
    `Status: ${STATUS_TEXT[humanState(record).status] ?? humanState(record).status}.`,
    "",
  ];
  if (record.human.length === 0) return [...lines, "No person has acted on this recommendation yet.", ""];
  lines.push("| Who | Role | Action | Outcome | When | Reason |", "|---|---|---|---|---|---|");
  for (const h of record.human) {
    const outcome = h.outcome ? (DECISION_TEXT[h.outcome] ?? h.outcome) : "";
    lines.push(
      `| ${cell(h.actor)} | ${word(h.role ?? "")} | ${word(h.action)} | ${outcome} | ${h.at} | ${cell(h.reason ?? "")} |`,
    );
  }
  return [...lines, ""];
}

function actionsSection({ actions }: CaseFileInput): string[] {
  if (!actions || actions.length === 0) return [];
  const lines = [
    "## What was prepared next",
    "",
    "Nothing here was sent or executed.",
    "",
    "| Record | Status | Seal | Text |",
    "|---|---|---|---|",
  ];
  for (const a of actions) {
    const check = a.check ?? (a.seal.type === "ed25519" ? "signed_unpinned" : "hash_sealed");
    lines.push(
      `| ${word(a.body.kind)} | ${cell(a.body.status)} | ${cell(CHECK_TEXT[check] ?? "")} | ${cell(a.body.content)} |`,
    );
  }
  return [...lines, ""];
}

function checksSection({ record }: CaseFileInput): string[] {
  const rounds = record.critic.rounds;
  return [
    "## Checks",
    "",
    "| Check | Result | Detail |",
    "|---|---|---|",
    ...record.guards.map((g) => `| ${cell(word(g.guard))} | ${g.verdict} | ${cell(g.detail ?? "")} |`),
    `| critic | ${record.critic.final_verdict} | ${rounds} round${rounds === 1 ? "" : "s"} |`,
    "",
  ];
}

function traceSection({ record, contract }: CaseFileInput): string[] {
  const access = contract.access.by_role
    .map((r) => {
      const masked = r.masked_columns.length ? `; masked: ${r.masked_columns.join(", ")}` : "";
      return `${r.role} ran ${r.queries} queries (${r.token_source === "role" ? "own token" : "labelled fallback key"}${masked})`;
    })
    .join("; ");
  const totals = contract.cost.totals;
  return [
    "## The decision trace",
    "",
    `- **Which approved definition applied:** ${record.definitions.map((d) => `${word(d.definition_id)} v${d.version}`).join(", ") || "none"}`,
    `- **What data it rests on:** semantic layer ${contract.data.usl.model_version}; ${contract.data.queries.length} read-only queries; list snapshots ${record.list_snapshots.map((s) => `${s.list} ${s.snapshot_id}`).join(", ") || "none"}`,
    `- **Who could see what:** policy version ${record.policy.version}; ${access}`,
    `- **What it cost to produce:** ${totals.local_calls + totals.cloud_calls} model calls (${totals.local_calls} local, ${totals.cloud_calls} cloud), ${totals.tokens_in} tokens in and ${totals.tokens_out} out, ${contract.cost.data_queries.count} data queries; ${money(totals.total_cost, contract.cost.currency)} under the configured unit costs`,
    "",
  ];
}

function modelsSection({ contract }: CaseFileInput): string[] {
  if (contract.cost.models.length === 0) return [];
  const lines = [
    "## Which model answered each step",
    "",
    "| Step | Asked for | Answered by | Lane | App | Reasoning | Receipt |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const m of contract.cost.models) {
    const receipt = `${word(m.receipt_status)}${m.receipt_id ? ` (${m.receipt_id})` : ""}`;
    lines.push(
      `| ${cell(word(m.agent))} | ${cell(m.model_requested)} | ${cell(m.model_routed)} | ${m.route_kind ?? "local"} | ${cell(m.app ?? "")} | ${cell(m.reasoning)} | ${receipt} |`,
    );
  }
  return [...lines, ""];
}

function recordSection({ record, contract, files }: CaseFileInput): string[] {
  return [
    "## The record",
    "",
    `Sealed ${record.decided_at} with hash \`${record.record_hash}\`${contract.record.verified ? " (verified: the hash matches the contents)" : ""}. Data and policy as of ${record.as_of}.`,
    "",
    `- [Decision record](${files.record})`,
    `- [Decision trace](${files.trace})`,
    `- [Run events](${files.events})`,
    "",
  ];
}

/** A case file a person can read without running anything: what happened, why, and what it rested on. */
export function renderCaseFile(input: CaseFileInput): string {
  const lines: string[] = [
    `# ${input.title}`,
    "",
    "> Synthetic customers, payments and owners; the listed parties are public sanctions-list entries. The desk recommends; a person decides.",
    "",
    input.summary,
    "",
    ...recommendationSection(input),
    ...pathSection(input),
    ...documentarySection(input),
    ...factsSection(input),
    ...autonomySection(input),
    "## How the desk got there",
    "",
    ...timeline(input.events),
    "",
    ...peopleSection(input),
    ...actionsSection(input),
    ...checksSection(input),
    ...traceSection(input),
    ...modelsSection(input),
    ...recordSection(input),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

/** A case file for the list-change replay, which is not one decision but a check of all earlier ones. */
export function renderReplayFile(input: {
  title: string;
  summary: string;
  report: ListChangeReport;
  policyVersion: number;
  files: { report: string };
}): string {
  const { report } = input;
  const row = (c: ListChangeReport["reopen"][number]) =>
    `| ${cell(c.customer_id)} | ${cell(c.entry_name ?? "")} | ${cell(c.earlier_decision)} (${cell(c.reason_code)}) | ${cell(c.open_alert_ids.join(", ") || "none open")} |`;
  const lines = [
    `# ${input.title}`,
    "",
    "> Synthetic customers and payments; the list change is a labelled synthetic edit of a few real entries. The desk recommends; a person decides.",
    "",
    input.summary,
    "",
    "## Result",
    "",
    `${report.examined} of ${report.total} earlier decisions were compared with the list as it is now (policy version ${input.policyVersion}). ${report.reopen.length} should be looked at again, ${report.release.length} are candidates for a person to release, ${report.unchanged} are unchanged and ${report.moot} no longer matter.`,
    "",
    `**Portfolio impact:** ${report.impact.summary}`,
    "",
    "## Earlier decisions to look at again",
    "",
    "| Customer | Listed entry | Earlier decision | Open alerts |",
    "|---|---|---|---|",
    ...report.reopen.map(row),
    "",
    "## Candidates for a person to release",
    "",
    "A listed entry that was removed no longer supports an escalation that rested on it. The desk does not release anything.",
    "",
    "| Customer | Listed entry | Earlier decision | Open alerts |",
    "|---|---|---|---|",
    ...report.release.map(row),
    "",
    `- [Full report](${input.files.report})`,
    "",
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}
