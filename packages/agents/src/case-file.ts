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

/** A case file a person can read without running anything: what happened, why, and what it rested on. */
export function renderCaseFile(input: CaseFileInput): string {
  const { record, contract } = input;
  const lines: string[] = [
    `# ${input.title}`,
    "",
    `> Synthetic customers, payments and owners; the listed parties are public sanctions-list entries. The desk recommends; a person decides.`,
    "",
    input.summary,
    "",
    "## Recommendation",
    "",
    `**${DECISION_TEXT[record.decision] ?? record.decision}** · confidence ${Math.round(record.confidence * 100)}%${
      record.confidence_cap
        ? ` (capped at ${Math.round(record.confidence_cap.value * 100)}%: ${record.confidence_cap.reason})`
        : ""
    }`,
    "",
    record.rationale,
    "",
  ];
  if (record.what_would_change.length > 0) {
    lines.push("**What would change this**", "", ...record.what_would_change.map((w) => `- ${w}`), "");
  }
  if (record.review_path) {
    lines.push(
      "## Path",
      "",
      record.review_path === "confirm"
        ? `Code's first finding from the structured fields was **${DECISION_TEXT[record.first_finding ?? ""] ?? record.first_finding}**, and the structured evidence settles the case, so the agents confirmed and explained it.`
        : `Code's first finding from the structured fields was **${DECISION_TEXT[record.first_finding ?? ""] ?? record.first_finding}**, but the structured evidence does not settle the case or there is free text to weigh, so the agents reasoned over all of it.`,
      "",
    );
  }
  if (record.documentary?.length) {
    lines.push(
      "## Values taken from verified notes",
      "",
      ...record.documentary.map(
        (d) =>
          `- ${d.label}: **${d.value}**. This is not a value of the customer record; the data-quality finding stays.`,
      ),
      "",
    );
  }
  if (input.facts?.length) {
    lines.push("## Facts the case rests on", "", ...input.facts.map((f) => `- **${f.label}:** ${f.value}`), "");
  }
  if (record.autonomy) {
    lines.push(
      "## Autonomy",
      "",
      record.autonomy.outcome === "auto_closed"
        ? `**${record.autonomy.statement}.**`
        : record.autonomy.outcome === "qa_sample"
          ? "This close met every condition for an automatic close and was picked at random for a quality-assurance review by a person."
          : `Level ${record.autonomy.level_in_force} was in force; the recommendation goes to a person. Conditions not met: ${
              record.autonomy.conditions
                .filter((c) => !c.met)
                .map((c) => c.name.replaceAll("_", " "))
                .join(", ") || "none"
            }.`,
      "",
    );
  }
  lines.push("## How the desk got there", "", ...timeline(input.events), "");

  const state = humanState(record);
  lines.push("## What people did", "", `Status: ${STATUS_TEXT[state.status] ?? state.status}.`, "");
  if (record.human.length > 0) {
    lines.push("| Who | Role | Action | Outcome | When | Reason |", "|---|---|---|---|---|---|");
    for (const h of record.human) {
      lines.push(
        `| ${cell(h.actor)} | ${(h.role ?? "").replaceAll("_", " ")} | ${h.action.replaceAll("_", " ")} | ${h.outcome ? (DECISION_TEXT[h.outcome] ?? h.outcome) : ""} | ${h.at} | ${cell(h.reason ?? "")} |`,
      );
    }
    lines.push("");
  } else {
    lines.push("No person has acted on this recommendation yet.", "");
  }
  if (input.actions && input.actions.length > 0) {
    lines.push("## What was prepared next", "", "Nothing here was sent or executed.", "");
    lines.push("| Record | Status | Seal | Text |", "|---|---|---|---|");
    for (const a of input.actions) {
      lines.push(
        `| ${a.body.kind.replaceAll("_", " ")} | ${cell(a.body.status)} | ${cell(CHECK_TEXT[a.check ?? (a.seal.type === "ed25519" ? "signed_unpinned" : "hash_sealed")] ?? "")} | ${cell(a.body.content)} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Checks", "", "| Check | Result | Detail |", "|---|---|---|");
  for (const g of record.guards)
    lines.push(`| ${cell(g.guard.replaceAll("_", " "))} | ${g.verdict} | ${cell(g.detail ?? "")} |`);
  lines.push(
    `| critic | ${record.critic.final_verdict} | ${record.critic.rounds} round${record.critic.rounds === 1 ? "" : "s"} |`,
    "",
  );

  lines.push("## The decision trace", "");
  lines.push(
    `- **Which approved definition applied:** ${record.definitions.map((d) => `${d.definition_id.replaceAll("_", " ")} v${d.version}`).join(", ") || "none"}`,
    `- **What data it rests on:** semantic layer ${contract.data.usl.model_version}; ${contract.data.queries.length} read-only queries; list snapshots ${record.list_snapshots.map((s) => `${s.list} ${s.snapshot_id}`).join(", ") || "none"}`,
    `- **Who could see what:** policy version ${record.policy.version}; ${contract.access.by_role
      .map(
        (r) =>
          `${r.role} ran ${r.queries} queries (${r.token_source === "role" ? "own token" : "labelled fallback key"}${r.masked_columns.length ? `; masked: ${r.masked_columns.join(", ")}` : ""})`,
      )
      .join("; ")}`,
    `- **What it cost to produce:** ${contract.cost.totals.local_calls + contract.cost.totals.cloud_calls} model calls (${contract.cost.totals.local_calls} local, ${contract.cost.totals.cloud_calls} cloud), ${contract.cost.totals.tokens_in} tokens in and ${contract.cost.totals.tokens_out} out, ${contract.cost.data_queries.count} data queries; ${money(contract.cost.totals.total_cost, contract.cost.currency)} under the configured unit costs`,
    "",
  );

  if (contract.cost.models.length > 0) {
    lines.push(
      "## Which model answered each step",
      "",
      "| Step | Asked for | Answered by | Lane | App | Reasoning | Receipt |",
      "|---|---|---|---|---|---|---|",
    );
    for (const m of contract.cost.models) {
      lines.push(
        `| ${cell(m.agent.replaceAll("_", " "))} | ${cell(m.model_requested)} | ${cell(m.model_routed)} | ${m.route_kind ?? "local"} | ${cell(m.app ?? "")} | ${cell(m.reasoning)} | ${m.receipt_status.replaceAll("_", " ")}${m.receipt_id ? ` (${m.receipt_id})` : ""} |`,
      );
    }
    lines.push("");
  }

  lines.push(
    "## The record",
    "",
    `Sealed ${record.decided_at} with hash \`${record.record_hash}\`${contract.record.verified ? " (verified: the hash matches the contents)" : ""}. Data and policy as of ${record.as_of}.`,
    "",
    `- [Decision record](${input.files.record})`,
    `- [Decision trace](${input.files.trace})`,
    `- [Run events](${input.files.events})`,
    "",
  );
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
