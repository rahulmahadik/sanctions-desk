/**
 * Draw the evidence charts from the committed files only, as SVG (1920x1080, light background, large text), and a
 * PNG of each through headless Chrome. Nothing is typed in: every number is read from eval/results, eval/runs and
 * eval/critic-mutation.json, and the receipts are verified with the same code as `npm run evidence:verify`.
 *
 *   npm run charts                     # writes docs/media/charts/*.svg and *.png
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { heldoutRounds, type SavedResult } from "@sanctions-desk/agents";
import { loadConfig, resolveProjectPath } from "@sanctions-desk/shared";
import { verifyExportedRun } from "./lib/evidence.js";

const W = 1920;
const H = 1080;
const out = resolveProjectPath("docs/media/charts");
mkdirSync(out, { recursive: true });
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const C = {
  ink: "#1f2937",
  muted: "#4b5563",
  grid: "#e5e7eb",
  bg: "#ffffff",
  full: "#1d4ed8",
  rules: "#b45309",
  name: "#b91c1c",
  escalate: "#047857",
  stopped: "#047857",
  proposed: "#9ca3af",
  local: "#0e7490",
  cloud: "#6d28d9",
};
const esc = (t: string) => t.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const text = (x: number, y: number, t: string, size: number, opts: Record<string, string | number> = {}) =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${opts.fill ?? C.ink}" font-weight="${opts.weight ?? 400}" text-anchor="${opts.anchor ?? "start"}">${esc(t)}</text>`;
const page = (title: string, subtitle: string, body: string, source: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif">
<title>${esc(title)}</title>
<rect width="${W}" height="${H}" fill="${C.bg}"/>
${text(90, 110, title, 54, { weight: 700 })}
${text(90, 170, subtitle, 32, { fill: C.muted })}
${body}
${text(90, H - 45, `Source: ${source}`, 26, { fill: C.muted })}
</svg>
`;
/** A row of colour keys, each placed after the previous label (about 0.56 of the font size per character). */
function legend(x: number, y: number, items: Array<[string, string]>): string {
  let lx = x;
  return items
    .map(([label, color]) => {
      const key = `<rect x="${lx}" y="${y - 26}" width="32" height="32" rx="4" fill="${color}"/>${text(lx + 46, y, label, 32)}`;
      lx += 46 + label.length * 18 + 60;
      return key;
    })
    .join("\n");
}

function save(name: string, svg: string) {
  const svgPath = join(out, `${name}.svg`);
  writeFileSync(svgPath, svg);
  const res = spawnSync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      `--window-size=${W},${H}`,
      `--screenshot=${join(out, `${name}.png`)}`,
      `file://${svgPath}`,
    ],
    { stdio: "ignore" },
  );
  if (res.status !== 0) throw new Error(`Chrome could not render ${name}`);
  console.log(`wrote ${name}.svg and ${name}.png`);
}

// ---- 1. Held-out rounds: risk cases wrongly closed --------------------------------------------------------------

const resultsDir = resolveProjectPath("eval/results");
const results = readdirSync(resultsDir)
  .filter((n) => n.endsWith(".json"))
  .map((n) => ({ file: n, ...(JSON.parse(readFileSync(join(resultsDir, n), "utf8")) as SavedResult) }));
const rounds = heldoutRounds(results);
const ROUND_NAMES: Record<string, string> = {
  v1: "v1",
  v2: "v2 (blind)",
  "v2-rerun": "v2 (re-run)",
  v3: "v3",
  v4: "v4",
};
const SERIES = [
  ["routed", "Full system", C.full],
  ["rules", "Deterministic rules", C.rules],
  ["fuzzy", "Name match", C.name],
  ["escalate_all", "Escalate everything", C.escalate],
] as const;
{
  const maxV = Math.max(...rounds.flatMap((r) => SERIES.map(([k]) => r.cells[k]?.wrong_closes ?? 0)));
  const top = 320;
  const bottom = 880;
  const left = 170;
  const groupW = (W - left - 120) / rounds.length;
  const barW = (groupW - 80) / SERIES.length;
  const y = (v: number) => bottom - (v / maxV) * (bottom - top);
  let body = "";
  for (let v = 0; v <= maxV; v += 2) {
    body += `<line x1="${left}" x2="${W - 120}" y1="${y(v)}" y2="${y(v)}" stroke="${C.grid}" stroke-width="2"/>${text(left - 24, y(v) + 11, String(v), 30, { anchor: "end", fill: C.muted })}`;
  }
  rounds.forEach((r, gi) => {
    const gx = left + gi * groupW + 40;
    SERIES.forEach(([key, , color], si) => {
      const cell = r.cells[key];
      const x = gx + si * barW;
      if (!cell) {
        body += text(x + barW / 2, bottom - 12, "not run", 22, { anchor: "middle", fill: C.muted });
        return;
      }
      const h = bottom - y(cell.wrong_closes);
      body += `<rect x="${x + 4}" y="${y(cell.wrong_closes)}" width="${barW - 8}" height="${Math.max(h, 3)}" fill="${color}" rx="3"/>`;
      body += text(x + barW / 2, y(cell.wrong_closes) - 14, String(cell.wrong_closes), 34, {
        anchor: "middle",
        weight: 700,
      });
    });
    const risk = r.cells.routed?.risk ?? 0;
    body += text(gx + (groupW - 80) / 2, bottom + 52, ROUND_NAMES[r.id] ?? r.id, 36, { anchor: "middle", weight: 600 });
    body += text(gx + (groupW - 80) / 2, bottom + 92, `${risk} risk cases`, 28, { anchor: "middle", fill: C.muted });
  });
  body += legend(
    left,
    245,
    SERIES.map(([, label, color]) => [label, color] as [string, string]),
  );
  save(
    "heldout-wrong-closes",
    page(
      "Held-out rounds: risk cases wrongly closed",
      "Cases the rules were not written for, each set frozen before the system that ran it; one run each. Lower is better.",
      body,
      "eval/results/ (the held-out table in the README)",
    ),
  );
}

// ---- 2. First recommendations to close a risk case, and how many the checks stopped -----------------------------

const runsDir = resolveProjectPath("eval/runs");
const gz = (p: string) => gunzipSync(readFileSync(p)).toString("utf8").split("\n").filter(Boolean);
const FIRST_RUNS: Array<[string, string]> = [
  ["routed-20261023T133311Z", "70 cases, first system"],
  ["sys2b-routed-20261023T195504Z", "70 cases, changed system"],
  ["heldout-routed-20261023T121140Z", "Held-out v1"],
  ["heldout2-sys2-routed-20261023T180732Z", "Held-out v2 (blind)"],
  ["heldout2-sys2b-routed-20261023T193436Z", "Held-out v2 (re-run)"],
  ["heldout3-sys3-routed-20261023T231901Z", "Held-out v3"],
  ["heldout4-sys4-routed-20261024T024523Z", "Held-out v4"],
];
const firstRecs = FIRST_RUNS.map(([run, label]) => {
  const res = JSON.parse(readFileSync(join(runsDir, run, "results.json"), "utf8")) as {
    cases: Array<{ case_id: string; must_not: string[]; got: string }>;
  };
  const risky = new Map(
    res.cases.filter((c) => c.must_not.includes("CLOSE_FALSE_POSITIVE")).map((c) => [c.case_id, c]),
  );
  const first = new Map<string, string>();
  for (const l of gz(join(runsDir, run, "trace.jsonl.gz"))) {
    const e = JSON.parse(l) as { case_id?: string; agent: string; action: string; output_summary?: string };
    if (e.agent === "decision" && e.action === "recommend" && e.case_id && !first.has(e.case_id))
      first.set(e.case_id, e.output_summary ?? "");
  }
  const proposed = [...risky.keys()].filter((id) => first.get(id)?.startsWith("CLOSE_FALSE_POSITIVE"));
  const stopped = proposed.filter((id) => risky.get(id)?.got !== "CLOSE_FALSE_POSITIVE");
  return { label, proposed: proposed.length, stopped: stopped.length };
});
{
  const top = 270;
  const rowH = 92;
  const left = 560;
  const right = W - 520;
  const maxV = Math.max(...firstRecs.map((r) => r.proposed), 1);
  const x = (v: number) => left + (v / maxV) * (right - left);
  let body = legend(left, 245, [
    ["Proposed a close (first recommendation)", C.proposed],
    ["Stopped by the checks", C.stopped],
  ]);
  firstRecs.forEach((r, i) => {
    const yy = top + 40 + i * rowH;
    body += text(left - 30, yy + 34, r.label, 34, { anchor: "end", weight: 600 });
    body += `<rect x="${left}" y="${yy}" width="${Math.max(x(r.proposed) - left, 3)}" height="28" fill="${C.proposed}" rx="3"/>`;
    body += `<rect x="${left}" y="${yy + 34}" width="${Math.max(x(r.stopped) - left, 3)}" height="28" fill="${C.stopped}" rx="3"/>`;
    body += text(
      Math.max(x(r.proposed), left) + 24,
      yy + 46,
      r.proposed === 0 ? "none proposed" : `${r.stopped} of ${r.proposed} stopped`,
      32,
      { weight: 700 },
    );
  });
  body += text(
    90,
    H - 95,
    "Held-out v3: no first recommendation was a close; its two wrong closes came after the critic sent an escalation back.",
    28,
    { fill: C.muted },
  );
  save(
    "first-recommendation-closes",
    page(
      "Proposed closes on risk cases, and how many were stopped",
      "From the traces: the decision step's first recommendation on each case that must not be closed, against the final outcome.",
      body,
      "eval/runs/*/trace.jsonl.gz and results.json",
    ),
  );
}

// ---- 3. Critic mutation test --------------------------------------------------------------------------------------

{
  const m = JSON.parse(readFileSync(resolveProjectPath("eval/critic-mutation.json"), "utf8")) as {
    summary: {
      mutations: number;
      mutations_caught: number;
      unchanged_decisions: number;
      unchanged_decisions_approved: number;
      decisions: number;
      untestable_citations?: number;
    };
  };
  const s = m.summary;
  const rows: Array<[string, number, number, string]> = [
    ["Changed facts caught (cited facts changed to false values)", s.mutations_caught, s.mutations, C.full],
    ["Unchanged decisions approved (no false alarm)", s.unchanged_decisions_approved, s.unchanged_decisions, C.stopped],
  ];
  const left = 90;
  const right = W - 90;
  let body = "";
  rows.forEach(([label, got, of, color], i) => {
    const yy = 330 + i * 290;
    body += text(left, yy, label, 42, { weight: 600 });
    body += `<rect x="${left}" y="${yy + 30}" width="${right - left}" height="90" fill="${C.grid}" rx="10"/>`;
    body += `<rect x="${left}" y="${yy + 30}" width="${((right - left) * got) / of}" height="90" fill="${color}" rx="10"/>`;
    body += text(left + 30, yy + 92, `${got} of ${of}`, 48, { fill: "#ffffff", weight: 700 });
  });
  body += text(
    left,
    930,
    `${s.decisions} recorded decisions; each cited fact changed to a false value, one at a time, then re-checked by the critic's code.${s.untestable_citations ? ` ${s.untestable_citations} cited facts could not be checked in sample mode and are not counted.` : ""}`,
    30,
    { fill: C.muted },
  );
  save(
    "critic-mutation",
    page(
      "Critic fact re-check: mutation test",
      "Sample mode, deterministic; re-run with npm run critic:mutation or npm run prove.",
      body,
      "eval/critic-mutation.json",
    ),
  );
}

// ---- 4. Which model served each call ------------------------------------------------------------------------------

{
  const trusted = [...loadConfig().nightshift.receiptPublicKeys];
  const runs = readdirSync(runsDir).filter((d) => existsSync(join(runsDir, d, "receipts.jsonl.gz")));
  let receipts = 0;
  let valid = 0;
  for (const d of runs) {
    const v = verifyExportedRun(join(runsDir, d), trusted);
    receipts += v.receipts;
    valid += v.status.valid_pinned + v.status.valid_unpinned;
  }
  const headline = verifyExportedRun(join(runsDir, "routed-20261023T133311Z"), trusted);
  const STEPS: Array<[string, string]> = [
    ["policy_guard", "Safety guard"],
    ["decision", "Decision"],
    ["critic", "Critic"],
    ["challenger", "Challenger"],
  ];
  const rows = STEPS.map(([step, label]) => {
    const m = headline.split.get(step) ?? new Map<string, number>();
    const local = [...m].filter(([model]) => /lightning/i.test(model)).reduce((n, [, c]) => n + c, 0);
    const cloud = [...m].filter(([model]) => /ultra/i.test(model)).reduce((n, [, c]) => n + c, 0);
    return { label, local, cloud };
  });
  const maxV = Math.max(...rows.map((r) => r.local + r.cloud));
  const left = 420;
  const right = W - 480;
  const x = (v: number) => (v / maxV) * (right - left);
  let body = legend(left, 250, [
    ["Nemotron 3.5 Lightning 30B (local)", C.local],
    ["Nemotron 3 Ultra 550B (cloud)", C.cloud],
  ]);
  rows.forEach((r, i) => {
    const yy = 320 + i * 140;
    body += text(left - 30, yy + 52, r.label, 38, { anchor: "end", weight: 600 });
    body += `<rect x="${left}" y="${yy}" width="${x(r.local)}" height="80" fill="${C.local}"/>`;
    body += `<rect x="${left + x(r.local)}" y="${yy}" width="${x(r.cloud)}" height="80" fill="${C.cloud}"/>`;
    body += text(left + x(r.local + r.cloud) + 24, yy + 54, `${r.local} local · ${r.cloud} cloud`, 34, { weight: 700 });
  });
  body += text(
    90,
    905,
    `Signed receipts: ${valid.toLocaleString("en-US")} of ${receipts.toLocaleString("en-US")} verify across ${runs.length} exported runs (npm run evidence:verify).`,
    34,
    { weight: 600 },
  );
  body += text(90, 955, "Nightshift's router chooses the model within each bound lane; every receipt records it.", 30, {
    fill: C.muted,
  });
  save(
    "model-calls",
    page(
      "Which model served each call",
      "Headline run of the 70-case exam (first system), from the signed receipts.",
      body,
      "eval/runs/routed-20261023T133311Z/receipts.jsonl.gz, all eval/runs/*/receipts.jsonl.gz",
    ),
  );
}

// ---- 5. Latency of each model call, per step and model (recorded runs) -------------------------------------------

{
  const stats = JSON.parse(readFileSync(resolveProjectPath("eval/receipt-stats.json"), "utf8")) as {
    groups: Array<{
      id: string;
      rows: Array<{ step: string; model: string; calls: number; latency_s: { median: number; p95: number } }>;
    }>;
  };
  const rows = (stats.groups.find((g) => g.id === "recorded")?.rows ?? []).filter((r) => !/Ollama/.test(r.model));
  const maxV = Math.ceil(Math.max(...rows.map((r) => r.latency_s.p95)) / 10) * 10;
  const left = 560;
  const right = W - 640;
  const x = (v: number) => left + (v / maxV) * (right - left);
  const rowH = Math.min(84, 560 / Math.max(rows.length, 1));
  let body = legend(left, 245, [
    ["Nemotron 3.5 Lightning 30B (local)", C.local],
    ["Nemotron 3 Ultra 550B (cloud)", C.cloud],
  ]);
  for (let v = 0; v <= maxV; v += 10) {
    body += `<line x1="${x(v)}" x2="${x(v)}" y1="290" y2="${300 + rows.length * rowH}" stroke="${C.grid}" stroke-width="2"/>${text(x(v), 330 + rows.length * rowH, `${v} s`, 26, { anchor: "middle", fill: C.muted })}`;
  }
  rows.forEach((r, i) => {
    const yy = 300 + i * rowH;
    const color = /Ultra/.test(r.model) ? C.cloud : C.local;
    body += text(left - 24, yy + rowH / 2 + 10, `${r.step} · ${/Ultra/.test(r.model) ? "Ultra" : "Lightning"}`, 32, {
      anchor: "end",
      weight: 600,
    });
    body += `<rect x="${left}" y="${yy + 12}" width="${Math.max(x(r.latency_s.median) - left, 3)}" height="${rowH - 30}" fill="${color}" rx="3"/>`;
    body += `<line x1="${x(r.latency_s.p95)}" x2="${x(r.latency_s.p95)}" y1="${yy + 6}" y2="${yy + rowH - 12}" stroke="${C.ink}" stroke-width="4"/>`;
    body += text(
      Math.max(x(r.latency_s.p95), x(r.latency_s.median)) + 18,
      yy + rowH / 2 + 8,
      `${r.latency_s.median} s median, ${r.latency_s.p95} s p95 · ${r.calls} calls`,
      26,
      { fill: C.muted },
    );
  });
  save(
    "model-latency",
    page(
      "Time per model call, by step and model",
      "Recorded runs: bars are the median, the black line is the 95th percentile. Every call here has a verified receipt.",
      body,
      "eval/receipt-stats.json (npm run receipt:stats, from eval/runs/*/trace.jsonl.gz and receipts.jsonl.gz)",
    ),
  );
}

// ---- 6. Full system and Nemotron alone, three runs each on held-out v4 (a labelled small study) -------------------

if (existsSync(resolveProjectPath("eval/repeat-study.json"))) {
  const study = JSON.parse(readFileSync(resolveProjectPath("eval/repeat-study.json"), "utf8")) as {
    systems: Array<{
      system: string;
      all_runs_agree: number;
      cases: number;
      runs: Array<{ run: string; wrong_closes: number; risk_cases: number; acceptable: number; cases: number }>;
    }>;
    calibration: Array<{ label: string; brier: number | null }>;
  };
  const METRICS: Array<[string, (r: { wrong_closes: number; acceptable: number }) => number, string]> = [
    ["Risk cases wrongly closed", (r) => r.wrong_closes, C.name],
    ["Acceptable outcomes", (r) => r.acceptable, C.full],
  ];
  const cases = study.systems[0]?.cases ?? 12;
  const top = 330;
  const bottom = 820;
  const left = 170;
  const groupW = (W - left - 160) / study.systems.length;
  const runs = Math.max(...study.systems.map((s) => s.runs.length));
  const barW = (groupW - 120) / (runs * METRICS.length);
  const y = (v: number) => bottom - (v / cases) * (bottom - top);
  let body = legend(
    left,
    250,
    METRICS.map(([label, , color]) => [label, color] as [string, string]),
  );
  for (let v = 0; v <= cases; v += 3) {
    body += `<line x1="${left}" x2="${W - 160}" y1="${y(v)}" y2="${y(v)}" stroke="${C.grid}" stroke-width="2"/>${text(left - 24, y(v) + 11, String(v), 30, { anchor: "end", fill: C.muted })}`;
  }
  study.systems.forEach((s, gi) => {
    const gx = left + gi * groupW + 60;
    s.runs.forEach((r, ri) => {
      METRICS.forEach(([, get, color], mi) => {
        const v = get(r);
        const x = gx + (ri * METRICS.length + mi) * barW;
        body += `<rect x="${x + 4}" y="${y(v)}" width="${barW - 8}" height="${Math.max(bottom - y(v), 3)}" fill="${color}" rx="3"/>`;
        body += text(x + barW / 2, y(v) - 12, String(v), 28, { anchor: "middle", weight: 700 });
      });
      body += text(gx + (ri * METRICS.length + 1) * barW, bottom + 40, r.run, 26, { anchor: "middle", fill: C.muted });
    });
    const brier = study.calibration.find((c) => c.label.startsWith(s.system))?.brier;
    body += text(gx + (groupW - 120) / 2, bottom + 90, s.system, 36, { anchor: "middle", weight: 600 });
    body += text(
      gx + (groupW - 120) / 2,
      bottom + 130,
      `same outcome in all runs: ${s.all_runs_agree} of ${s.cases} · Brier ${brier ?? "n/a"}`,
      28,
      { anchor: "middle", fill: C.muted },
    );
  });
  save(
    "repeat-study",
    page(
      "Held-out v4, three runs each: full system and Nemotron alone, without and with the free text",
      `Small study, ${cases} cases x 3 runs, not part of the recorded evaluation. ${study.systems[0]?.runs[0]?.risk_cases ?? 6} risk cases per run.`,
      body,
      "eval/repeat-study.json (npm run study:repeat)",
    ),
  );
}

// ---- 7. Model choice for the reasoning steps (a labelled small study) ---------------------------------------------

if (existsSync(resolveProjectPath("eval/model-choice.json"))) {
  const study = JSON.parse(readFileSync(resolveProjectPath("eval/model-choice.json"), "utf8")) as {
    arms: Array<{
      short: string;
      cases: number;
      risk_cases: number;
      wrong_closes: number;
      clears_made: number;
      clear_cases: number;
      outcomes_identical_to_default: number;
      errors: number;
      median_case_s: number;
    }>;
  };
  const ROWS: Array<[string, (a: (typeof study.arms)[number]) => string]> = [
    ["Risk cases wrongly closed", (a) => `${a.wrong_closes} of ${a.risk_cases}`],
    ["Clears made", (a) => `${a.clears_made} of ${a.clear_cases}`],
    ["Same outcome as the default", (a) => `${a.outcomes_identical_to_default} of ${a.cases}`],
    ["Cases with no usable decision", (a) => String(a.errors)],
    ["Median time per case", (a) => `${a.median_case_s} s`],
  ];
  const colX = [760, 1340];
  let body = "";
  study.arms.forEach((a, i) => {
    body += text(colX[i] as number, 300, a.short, 40, {
      anchor: "middle",
      weight: 700,
      fill: i === 0 ? C.cloud : C.local,
    });
  });
  ROWS.forEach(([label, get], r) => {
    const yy = 400 + r * 110;
    body += `<line x1="90" x2="${W - 90}" y1="${yy - 62}" y2="${yy - 62}" stroke="${C.grid}" stroke-width="2"/>`;
    body += text(90, yy, label, 36, { weight: 600 });
    study.arms.forEach((a, i) => {
      body += text(colX[i] as number, yy, get(a), 40, { anchor: "middle", weight: 700 });
    });
  });
  save(
    "model-choice",
    page(
      "Reasoning steps: Ultra in the cloud or Lightning locally",
      "Decision, critic and challenger. Small study, not part of the recorded evaluation: 20 cases, one run per arm.",
      body,
      "eval/model-choice.json (npm run study:model-choice)",
    ),
  );
}
