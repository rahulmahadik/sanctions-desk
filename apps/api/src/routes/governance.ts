import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, PolicyStore } from "@sanctions-desk/shared";
import { projectRoot } from "@sanctions-desk/shared";
import type { FastifyPluginAsync } from "fastify";
import { headlineFromRuns, readExamResults } from "./desk.js";

interface GovernanceOptions {
  config: Config;
  policies: PolicyStore;
}

const MAPPING_NOTE =
  "This page maps what the desk does to the headings of the Monetary Authority of Singapore's proposed Guidelines on AI Risk Management (consultation of November 2025). It is a mapping of existing facts, not a claim of compliance with those guidelines or any other rule, and the ratings below are the project author's own assessment.";

function readJson<T>(file: string): T | undefined {
  const path = join(projectRoot(), file);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
}

/**
 * The governance view, built only from what the project already holds: the configuration, the active policy and
 * its audit log, the latest exam results, the label changes and the JSON failure counts. Nothing is typed in here
 * that a file does not back; the ratings are marked as a self-assessment.
 */
export const governanceRoutes: FastifyPluginAsync<GovernanceOptions> = async (app, { config, policies }) => {
  app.get("/governance", async () => {
    const policy = policies.active();
    const results = readExamResults(join(projectRoot(), "eval", "results"));
    const head = headlineFromRuns(results, config);
    const labelChanges =
      readJson<{ changes: Array<{ case_id: string; reason: string }> }>("eval/label-changes.json")?.changes ?? [];
    const failureRate = readJson<{ note: string; before: unknown[]; after: unknown[] }>("eval/json-failure-rate.json");
    const audit = policies.audit();
    return {
      mapping_note: MAPPING_NOTE,
      inventory: {
        name: "Sanctions Desk",
        purpose:
          "Recommends an outcome for bank sanctions-screening alerts, with the evidence, for a person to decide.",
        status: "prototype built for the Open Agent Hackathon 2026",
        deployment: "runs locally; sample mode needs no external service",
        data: "synthetic customers, payments and owners; real public sanctions-list entries",
        models: [
          {
            name: "Nemotron 3 Ultra 550B",
            served: "cloud, through Meterless Nightshift",
            used_by: ["decision", "critic", "challenger"],
          },
          {
            name: "Nemotron 3.5 Lightning 30B",
            served: "local, through Meterless Nightshift",
            used_by: ["safety guard", "occasionally the critic"],
          },
        ],
        which_model_serves:
          "Nightshift's learned router decides; the desk asks for a pinned mode and records the model that answered",
        components: [
          "Zetaris unified semantic layer (all data access)",
          "Meterless Nightshift (all model calls)",
          "Ollama (backup provider)",
          "H-MEM, World Model, Markovian engines",
        ],
        policy_version: policy.version,
        sample_mode: config.sampleMode,
      },
      risk_materiality: {
        kind: "self-assessment by the project author, with the basis for each rating",
        dimensions: [
          {
            dimension: "impact",
            rating: "high",
            basis:
              "A wrongly closed true match is a potential sanctions breach; a wrongly escalated alert costs analyst time.",
          },
          {
            dimension: "complexity",
            rating: "medium to high",
            basis:
              "Several steps, two model sizes, a router the desk does not control, retrieval from a semantic layer, and learned memory.",
          },
          {
            dimension: "reliance",
            rating: "medium",
            basis:
              "A person decides every case, but a clear recommendation with cited evidence can be accepted without independent analysis (automation bias).",
          },
        ],
        conclusion: "Treated as material: the controls below apply to every recommendation.",
      },
      human_oversight: {
        hard_limits: {
          auto_block: policy.automation.autoBlock,
          message_customers: policy.automation.messageCustomers,
          data_access: policy.automation.dataAccess,
          approvals_required_for_a_block: policy.automation.blockApprovalsRequired,
          fixed_in: "the policy schema; a draft that tries to change them is rejected",
        },
        proportionate_to_risk: {
          principle:
            "Human oversight proportional to risk: the more a mistake would cost, the more people are involved. A mistaken close is the costly one, so only a close can ever be made without waiting, and only under strict conditions.",
          level_0: "A person approves every alert (the default, and the level the headline exam runs at).",
          level_1:
            "A close may be closed without waiting only when code, the decision agent, the critic and the challenger all agree, the evidence standard is met, no data-quality rule fails and the confidence is at least the policy's line. A random share (at least 5 percent) goes to a person for quality assurance, there is a daily cap, and a kill switch forces level 0 at once.",
          always_to_a_person: [
            "an escalation",
            "a request for more information",
            "a recommended block (and it needs two different approvers)",
          ],
          current: { policy_level: policy.autonomy.level, version: policy.version },
          change_control:
            "Autonomy changes only through a policy draft, a preview on the exam (automatic closes, quality-assurance samples, false closes, which must be 0) and a publish by a different policy admin; every step is in the audit log.",
        },
        controls: [
          "Every recommendation is for a person to act on unless it was closed automatically under level 1; the response says which.",
          "A recommended block needs two different approvers, and a person can reopen any automatic close.",
          "The policy guard can only make an outcome more cautious.",
          "A close is challenged when confidence is low, the name is very close, or a data-quality rule fails.",
          "Text in the data that tries to instruct the reviewer is flagged and cannot close a case.",
        ],
      },
      explainability: {
        record:
          "Each recommendation has a hash-sealed decision record and a trace that answers: which approved definition applied, what data it rested on, who could see what, and what it cost.",
        evidence: "Every cited fact is re-read from the data by code and checked before the critic's model sees it.",
        where: [
          "GET /cases/:alertId/trace",
          "GET /cases/:alertId/record",
          "the alert view and replay in the review desk",
        ],
      },
      testing: {
        exam_report: "eval/REPORT.md",
        headline: head.headline,
        headline_sentence: head.headline_sentence,
        headline_run: head.headline_run,
        baselines: "compared with a name-match rules baseline and with the deterministic pipeline on the same cases",
        label_changes: labelChanges.map((c) => ({ case_id: c.case_id, reason: c.reason })),
        limits: "one run per variant; labels follow the same definitions as the rules; synthetic data",
      },
      monitoring: {
        model_ledger:
          "every call records the mode asked for, the model that answered, reasoning budget, tokens, latency, cost and the signed receipt's status",
        routing_split: head.routing_split,
        json_failure_rate: failureRate ?? null,
        provider_failures: "the exam report counts calls that ended before any answer, by mode asked for",
        access: "npm run check:roles verifies each agent's access to the data; the API checks at start-up",
      },
      change_control: {
        active_policy_version: policies.activeVersion(),
        policy_versions: policies.list().map((r) => ({
          version: r.policy.version,
          status: r.status,
          proposed_by: r.proposedBy,
          approved_by: r.approvedBy ?? null,
          published_at: r.publishedAt ?? null,
        })),
        audit_entries: audit.length,
        rule: "A change is a draft, then a publish by a different person; a run keeps the version it started with; every record names the policy version it used.",
        code: "changes go through version control with tests and checks on each commit",
      },
      limits: [
        "Synthetic data only; not tested on a bank's real alerts.",
        "Most decision and critic calls are answered by a cloud model; real customer data would need a decision on what may leave the machine.",
        "Fairness across name origins and languages is only partly measured (see the README).",
        "The exam's labels and the rules share the same definitions.",
        "Ratings on this page are a self-assessment.",
      ],
    };
  });
};
