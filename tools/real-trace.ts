/**
 * Write the README's "One real trace" block from a committed output example: real trace lines, the guard verdict that
 * blocked, the final outcome and the human step, copied from the files and never typed in.
 *
 *   npm run readme:trace            # rewrite the block between <!-- realtrace:start --> and <!-- realtrace:end -->
 *   npm run readme:trace -- --check # exit 1 if the README block differs from what the files give
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProjectPath } from "@sanctions-desk/shared";

const EXAMPLE = "output_examples/close-stopped-by-policy-guard";
/** The decision's first recommendation, the critic's checks and the guard's block, then the seal. */
const SEQ = [24, 25, 26, 27, 28, 29, 30, 31];
const START = "<!-- realtrace:start -->";
const END = "<!-- realtrace:end -->";

interface Event {
  seq: number;
  agent: string;
  action: string;
  status: string;
  target_agent?: string;
  model_requested?: string;
  model_used?: string;
  confidence?: number;
  output_summary?: string;
  receipt?: { receipt_id: string };
}
interface Guard {
  guard: string;
  verdict: string;
  detail?: string;
}

const dir = resolveProjectPath(EXAMPLE);
const events = readFileSync(join(dir, "run-events.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Event);
const record = JSON.parse(readFileSync(join(dir, "decision-record.json"), "utf8")) as {
  alert_ref: string;
  decision: string;
  confidence: number;
  record_hash: string;
  guards: Guard[];
  human: unknown[];
};

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");
const rows = SEQ.map((seq) => {
  const e = events.find((x) => x.seq === seq);
  if (!e) throw new Error(`event ${seq} is not in ${EXAMPLE}/run-events.jsonl`);
  const model = e.model_used
    ? `${e.model_requested ?? "?"} → ${e.model_used}${e.receipt ? ` (receipt \`${e.receipt.receipt_id}\`)` : ""}`
    : "";
  return `| ${e.seq} | ${e.agent} | ${e.action} | ${e.target_agent ?? ""} | ${model} | ${e.status}${e.confidence !== undefined ? ` (${e.confidence})` : ""} | ${cell(clip(e.output_summary ?? "", 140))} |`;
});
const blocked = record.guards.filter((g) => g.verdict === "block");
if (blocked.length === 0) throw new Error("the example's record has no blocking guard verdict");
const first = events.find((e) => e.agent === "decision" && e.action === "recommend");
const checked = events.find((e) => e.agent === "critic" && e.action === "verify_facts")?.output_summary ?? "";
const verdict = events.find((e) => e.agent === "critic" && e.action === "judge")?.output_summary ?? "";
const critic =
  verdict === "approved" && / 0 issues$/.test(checked)
    ? `the critic approved it (${checked}): the cited facts were true`
    : `the critic answered "${verdict}" (${checked})`;

const block = [
  START,
  `Case **EX-064** (alert ${record.alert_ref}), first-system run of 23 Oct 2026, copied by \`npm run readme:trace\` from [${EXAMPLE}](${EXAMPLE}) (the same events are in the signed evidence export \`eval/runs/routed-20261023T133311Z\`). The label is ESCALATE_L2; closing it is a must-not.`,
  "",
  "| Seq | Agent | Action | Target | Model (requested → routed) | Status | Summary |",
  "|---:|---|---|---|---|---|---|",
  ...rows,
  "",
  `- **What happened:** the decision's first recommendation was ${first?.output_summary?.split(":")[0] ?? "?"} at confidence ${first?.confidence ?? "?"}, and ${critic}. The policy guard then blocked the close on a rule.`,
  `- **The rule that blocked:** ${blocked.map((g) => `\`${g.guard}\`: ${g.detail ?? ""}`).join("; ")}.`,
  `- **Final outcome:** ${record.decision} at confidence ${record.confidence}, sealed as record \`${record.record_hash.slice(0, 12)}…\`.`,
  `- **The human step:** ${record.human.length === 0 ? "none recorded yet: the recommendation waits for a person." : `${record.human.length} human action(s) recorded.`} An analyst or approver approves it or overrides it with a reason against the sealed record; only an approver may override towards a close. The escalation ticket is prepared only after that decision, and nothing is sent.`,
  END,
].join("\n");

const readmePath = resolveProjectPath("README.md");
const readme = readFileSync(readmePath, "utf8");
if (!readme.includes(START) || !readme.includes(END)) throw new Error("README.md has no realtrace markers");
const next = readme.replace(new RegExp(`${START}[\\s\\S]*?${END}`), block);
if (process.argv.includes("--check")) {
  if (next !== readme) {
    console.error("README.md's real trace block differs from the committed example; run npm run readme:trace");
    process.exit(1);
  }
  console.log("README real trace block matches the committed example");
} else {
  writeFileSync(readmePath, next);
  console.log(`wrote the real trace block from ${EXAMPLE}`);
}
