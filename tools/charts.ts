/**
 * Draw the four evidence charts from the committed files only, as SVG (1920x1080, light background, large text), and a
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
    };
  };
  const s = m.summary;
  const rows: Array<[string, number, number, string]> = [
    ["False cited facts caught", s.mutations_caught, s.mutations, C.full],
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
    `${s.decisions} recorded decisions; each cited fact changed to a false value, one at a time, then re-checked by the critic's code.`,
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
      "Headline run of the 70-case exam, 23 Oct 2026, from the signed receipts.",
      body,
      "eval/runs/routed-20261023T133311Z/receipts.jsonl.gz, all eval/runs/*/receipts.jsonl.gz",
    ),
  );
}
