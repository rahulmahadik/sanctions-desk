/**
 * The data harness, counted from the code in this repository: what it takes to reach each source directly and what it
 * takes through Zetaris, where the data-quality rules live, and where each business definition is stated.
 *
 *   npm run zetaris:harness             # writes eval/zetaris-harness.json and the block in docs/ZETARIS.md
 *   npm run zetaris:harness -- --check  # exits 1 if either would change (CI)
 *
 * Reads committed files only; it calls no service. Every count names its file and line range. A line counts when it
 * is not blank and not a comment-only line (`//`, `/*`, `*`, `--`, `#`). Ranges are found by markers in the files, so
 * a moved function is followed and a missing one stops the tool instead of counting the wrong lines.
 *
 * The query times come from eval/zetaris-timing.json, written by `npm run zetaris:timing` (a live run); until that file
 * exists the block says "not measured yet".
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { formatMarkdown } from "./lib/format-markdown.js";

type Source = "bank" | "payments" | "lists" | "all";
type Locator = { whole: true } | { fn: string } | { from: RegExp; to: RegExp } | { from: RegExp; lines: number };

interface Spec {
  file: string;
  at: Locator;
  what: string;
}

interface Counted {
  file: string;
  lines: string;
  loc: number;
  what: string;
}

const read = (file: string): string[] => readFileSync(resolveProjectPath(file), "utf8").split("\n");

const isCode = (line: string): boolean => {
  const t = line.trim();
  if (t === "") return false;
  return !/^(\/\/|\/\*|\*|--|#)/.test(t);
};

/** Strip string literals and empty `{}` so braces in them do not move the depth. */
const braces = (line: string): number => {
  const bare = line
    .replace(/`(?:\\.|[^`\\])*`/g, "")
    .replace(/"(?:\\.|[^"\\])*"/g, "")
    .replace(/'(?:\\.|[^'\\])*'/g, "")
    .replace(/\{\s*\}/g, "");
  return (bare.match(/\{/g)?.length ?? 0) - (bare.match(/\}/g)?.length ?? 0);
};

function locate(file: string, lines: string[], at: Locator): [number, number] {
  if ("whole" in at) return [1, lines.length];
  const find = (re: RegExp, from = 0): number => {
    const i = lines.findIndex((l, n) => n >= from && re.test(l));
    if (i < 0) throw new Error(`${file}: marker ${re} not found; update tools/zetaris-harness.ts`);
    return i;
  };
  if ("fn" in at) {
    const start = find(new RegExp(`^(export )?(async )?function ${at.fn}\\b`));
    let depth = 0;
    let opened = false;
    for (let i = start; i < lines.length; i += 1) {
      depth += braces(lines[i] ?? "");
      if (depth > 0) opened = true;
      if (opened && depth === 0) return [start + 1, i + 1];
    }
    throw new Error(`${file}: end of function ${at.fn} not found`);
  }
  const start = find(at.from);
  if ("lines" in at) return [start + 1, start + at.lines];
  return [start + 1, find(at.to, start) + 1];
}

function count(spec: Spec): Counted {
  const lines = read(spec.file);
  const [a, b] = locate(spec.file, lines, spec.at);
  const loc = lines.slice(a - 1, b).filter(isCode).length;
  return { file: spec.file, lines: `${a}-${b}`, loc, what: spec.what };
}

const sum = (xs: Counted[]): number => xs.reduce((n, x) => n + x.loc, 0);

// ---- 1. connection code per source --------------------------------------------------------------------------------

/** The direct path: compare/hand-coded reads each source without Zetaris. It is a comparison program, not the desk. */
const DIRECT: Record<Source, Spec[]> = {
  bank: [
    {
      file: "compare/hand-coded/connectors.mjs",
      at: { fn: "readBank" },
      what: "Postgres client: connect, log in, read",
    },
  ],
  payments: [
    {
      file: "compare/hand-coded/connectors.mjs",
      at: { fn: "readPayments" },
      what: "HTTP client: key header, timeout, status, parse",
    },
    { file: "compare/hand-coded/cache.mjs", at: { whole: true }, what: "cache of the REST answer" },
  ],
  lists: [{ file: "compare/hand-coded/connectors.mjs", at: { fn: "readList" }, what: "read and parse a list file" }],
  all: [
    {
      file: "compare/hand-coded/retry.mjs",
      at: { whole: true },
      what: "retries, shared by the bank and payments reads",
    },
    {
      file: "compare/hand-coded/connectors.mjs",
      at: { from: /^import /, to: /^import \{ withRetry/ },
      what: "imports of the connectors",
    },
  ],
};

/** The Zetaris path: the onboarding SQL per source (generated), the TypeScript that writes it, and the runtime client. */
const ZETARIS_SQL: Record<Exclude<Source, "all">, Spec[]> = {
  bank: [{ file: "zetaris/sql/03_bankdb_create.sql", at: { whole: true }, what: "JDBC data source, read-only login" }],
  payments: [{ file: "zetaris/sql/04_payments_create.sql", at: { whole: true }, what: "REST table and CACHE TABLE" }],
  lists: [{ file: "zetaris/sql/01_lists_create.sql", at: { whole: true }, what: "file-store tables" }],
};
const ZETARIS_GENERATOR: Record<Exclude<Source, "all">, Spec[]> = {
  bank: [
    {
      file: "packages/zetaris/src/usl-sql.ts",
      at: { from: /^const BANKDB = /, lines: 3 },
      what: "the script's header",
    },
    { file: "packages/zetaris/src/usl-sql.ts", at: { fn: "bankdbScript" }, what: "writes 03_bankdb_create.sql" },
  ],
  payments: [
    {
      file: "packages/zetaris/src/usl-sql.ts",
      at: { fn: "paymentsScript" },
      what: "writes 04_payments_create.sql",
    },
  ],
  lists: [
    { file: "packages/zetaris/src/usl-sql.ts", at: { fn: "filestore" }, what: "one file-store table" },
    { file: "packages/zetaris/src/usl-sql.ts", at: { fn: "listsScript" }, what: "writes 01_lists_create.sql" },
  ],
};
/** What every agent read goes through, whatever the source. */
const ZETARIS_RUNTIME: Spec[] = [
  {
    file: "packages/zetaris/src/client.ts",
    at: { whole: true },
    what: "the one client: token per role, timeout, query record (also runs the SQL guard)",
  },
  {
    file: "packages/shared/src/http.ts",
    at: { whole: true },
    what: "fetch with a hard timeout (shared with the model calls)",
  },
];
/** Reaches a source without Zetaris, but writes or probes; no agent reads through it. Listed, not compared. */
const DIRECT_NOT_READS: Array<Spec & { source: Source }> = [
  ...["heldout", "heldout2", "heldout3", "heldout4"].flatMap(
    (h): Array<Spec & { source: Source }> => [
      {
        source: "bank",
        file: `tools/${h}-load.ts`,
        at: { from: /^const sql = \["BEGIN;"/, to: /^\);$/ },
        what: "inserts held-out rows with psql as bank_admin (a write, run by hand)",
      },
      {
        source: "payments",
        file: `tools/${h}-load.ts`,
        at: { from: /docker", \["restart", "sanctions-payments-api"/, lines: 1 },
        what: "restarts the payments service so it serves the new rows",
      },
    ],
  ),
  {
    source: "bank",
    file: "docker/bankdb/init/03_reader.sh",
    at: { whole: true },
    what: "creates the read-only login Zetaris uses",
  },
  {
    source: "lists",
    file: "packages/data/src/sources.ts",
    at: { fn: "fetchSource" },
    what: "downloads the public lists",
  },
  {
    source: "all",
    file: "tools/check-isolation.ts",
    at: { whole: true },
    what: "proves only Zetaris can reach the bank database and the payments service",
  },
];

/** Names that would show agent runtime code reaching a source directly. */
const SOURCE_NAMES: Record<Exclude<Source, "all">, RegExp> = {
  bank: /sanctions_bankdb|sanctions_bank_files|from ["']pg["']|BANKDB_|jdbc:/,
  payments: /sanctions_payments|payments_raw|PAYMENTS_(URL|API_KEY)|payments-api:8100/,
  lists: /sanctions_lists|data\/sample\/(list_|business_definition)/,
};
const AGENT_RUNTIME_DIRS = ["packages/agents/src/", "apps/api/src/"];
const AGENT_RUNTIME_FILES = ["client", "guard", "tools", "metadata", "access", "audit", "replay", "index"].map(
  (f) => `packages/zetaris/src/${f}.ts`,
);

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: resolveProjectPath("."), encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const runtimeFiles = tracked.filter(
  (f) =>
    /\.(ts|tsx|mjs)$/.test(f) && (AGENT_RUNTIME_DIRS.some((d) => f.startsWith(d)) || AGENT_RUNTIME_FILES.includes(f)),
);
const sourceRefs = Object.fromEntries(
  (Object.keys(SOURCE_NAMES) as Array<keyof typeof SOURCE_NAMES>).map((s) => [
    s,
    runtimeFiles.flatMap((f) =>
      read(f).flatMap((l, i) => (SOURCE_NAMES[s].test(l) && isCode(l) ? [`${f}:${i + 1}`] : [])),
    ),
  ]),
) as Record<keyof typeof SOURCE_NAMES, string[]>;

const perSource = (["bank", "payments", "lists"] as const).map((source) => {
  const direct = DIRECT[source].map(count);
  const sql = ZETARIS_SQL[source].map(count);
  const generator = ZETARIS_GENERATOR[source].map(count);
  return {
    source,
    direct: { loc: sum(direct), files: direct },
    zetaris_sql: { loc: sum(sql), files: sql },
    zetaris_generator: { loc: sum(generator), files: generator },
    agent_code_naming_this_source: sourceRefs[source],
  };
});
const directShared = DIRECT.all.map(count);
const runtime = ZETARIS_RUNTIME.map(count);
const notReads = DIRECT_NOT_READS.map((s) => ({ source: s.source, ...count(s) }));

// ---- 2. data quality ----------------------------------------------------------------------------------------------

const dqSql = read("zetaris/sql/07_dq_create.sql");
const ddl = read("zetaris/usl/screening_usl.ddl");
const customRules = dqSql.filter((l) => /^REGISTER DQ /.test(l)).map((l) => l.split(" ")[2] as string);
const primaryKeys = ddl.filter((l) => /\bPRIMARY KEY\b/i.test(l)).length;
const foreignKeys = ddl.filter((l) => /\bREFERENCES\b/i.test(l)).length;

const dqInLayer = [
  count({ file: "zetaris/sql/07_dq_create.sql", at: { whole: true }, what: "the eight REGISTER DQ statements" }),
];
const dqAuthoring = [
  count({ file: "packages/zetaris/src/usl-sql.ts", at: { fn: "dqRules" }, what: "the rules, written once" }),
  count({ file: "packages/zetaris/src/usl-sql.ts", at: { fn: "dqScript" }, what: "writes 07_dq_create.sql" }),
];
const dqUse = [
  count({
    file: "packages/agents/src/evidence.ts",
    at: { fn: "checkDataQuality" },
    what: "evidence step: asks Zetaris which records fail each rule the layer lists",
  }),
  count({
    file: "packages/agents/src/ownership.ts",
    at: { fn: "ownershipQuality" },
    what: "ownership step: the same for the register rows",
  }),
  count({
    file: "packages/agents/src/policy-guard.ts",
    at: { from: /^export const DOB_RULE = /, lines: 6 },
    what: "policy guard: a failing rule blocks a close (one named exception)",
  }),
];
const dqOverlap = [
  count({
    file: "packages/data/src/matching/compare.ts",
    at: { from: /if \(!country \|\| !isIso2\(country\)\) return \{ status: "unknown"/, lines: 1 },
    what: "matching treats a counterparty country that is not ISO-2 as unknown (same test as counterparty_country_valid, used to compare, not to flag)",
  }),
  count({
    file: "packages/data/src/matching/compare.ts",
    at: { from: /if \(!customerDob\) return \{ status: "missing_customer"/, lines: 1 },
    what: "matching reports a missing customer date of birth (the case dob_present_for_individuals flags)",
  }),
  count({
    file: "packages/engines/src/domain/ownership.ts",
    at: { fn: "parsePercent" },
    what: "ownership engine treats a missing percentage as unknown (the case ownership_pct_present flags)",
  }),
];
const dqDirect = [
  count({ file: "compare/hand-coded/dq.mjs", at: { whole: true }, what: "rules, registry and run history by hand" }),
];
// The hand-coded rules include one for the new-source test's watchlist table, which the model does not have.
const handRules = read("compare/hand-coded/dq.mjs").filter((l) => /^ {2}[a-z0-9_]+: \{/.test(l)).length;

// ---- 3. business definitions --------------------------------------------------------------------------------------

interface DefinitionRow {
  definition_key: string;
  definition_id: string;
  version: string;
  status: string;
  statement: string;
}
const rows = JSON.parse(
  readFileSync(resolveProjectPath("data/sample/business_definition.json"), "utf8"),
) as DefinitionRow[];
const ids = [...new Set(rows.map((r) => r.definition_id))];

const READ_AT_RUN_TIME = count({
  file: "packages/agents/src/evidence.ts",
  at: { from: /await read\("find_business_definition"/, to: /const definitionCheck = checkDefinitions\(/ },
  what: "evidence step reads the approved rows from business_definition and checks their versions",
});

/** Where the code states a definition again: the executable test, a pinned version, or prompt text. */
const RESTATED: Record<string, Spec[]> = {
  true_match: [
    { file: "packages/data/src/matching/compare.ts", at: { fn: "meetsTrueMatch" }, what: "the test, in code" },
  ],
  false_positive: [
    { file: "packages/data/src/matching/compare.ts", at: { fn: "meetsFalsePositive" }, what: "the test, in code" },
    {
      file: "packages/data/src/matching/compare.ts",
      at: { from: /false_positive: country\.status === "conflict" && identifiers\.status !== "match"/, lines: 1 },
      what: "the payment form of the test, in code (the approved wording speaks of a customer's date of birth and nationality)",
    },
    {
      file: "packages/agents/src/decision.ts",
      at: { from: /^- A matching name alone is never enough to close an alert\./, lines: 1 },
      what: "prompt text that repeats the conditions",
    },
    {
      file: "config/policy.default.json",
      at: { from: /"definition": "false_positive@2"/, lines: 1 },
      what: "the evidence standard names the version",
    },
    {
      file: "packages/shared/src/policy.ts",
      at: { from: /definition: "false_positive@2"/, lines: 1 },
      what: "the default of that setting",
    },
  ],
  counterparty_match: [
    {
      file: "packages/data/src/matching/compare.ts",
      at: { from: /counterparty_match: nameHigh && country\.status === "match"/, lines: 1 },
      what: "the test, in code",
    },
  ],
  strong_identifier: [
    {
      file: "packages/data/src/matching/compare.ts",
      at: { from: /^ {2}const strong =$/, lines: 2 },
      what: "counts strong identifiers (date of birth to the day, nationality, document number)",
    },
    {
      file: "config/policy.default.json",
      at: { from: /"strongIdentifierFields":/, lines: 2 },
      what: "a second list of strong identifier fields with a minimum of 2; validated by the policy schema, read by no step",
    },
  ],
  effective_ownership_threshold: [
    {
      file: "packages/engines/src/domain/ownership.ts",
      at: { fn: "judgeOwner" },
      what: "effective ownership against the threshold",
    },
    {
      file: "packages/engines/src/domain/ownership.ts",
      at: { fn: "blockStatus" },
      what: "the cascade (the 50 percent rule)",
    },
    {
      file: "config/policy.default.json",
      at: { from: /"thresholdPercent": 50/, lines: 1 },
      what: "the threshold (the wording defers to the policy)",
    },
    {
      file: "packages/agents/src/decision.ts",
      at: { from: /^- For an ownership alert \(alert_source "ownership"\)/, lines: 1 },
      what: "prompt text that repeats the rule",
    },
  ],
};
const PINNED = "packages/data/src/definitions.ts";
const pinnedLines = read(PINNED);

/** Is the approved wording itself copied anywhere? A 60-character piece of each statement, searched in every tracked file. */
const WORDING_SKIP = [
  /^data\/sample\/business_definition\.json$/,
  /^data\/sample\/query-cache\.json$/, // saved Zetaris answers for sample mode
  /^eval\/(results|runs|studies|adversarial)\//,
  /^output_examples\//,
  /\.(png|svg|gz|jpg|gif|pdf|lock)$/,
];
const searchable = tracked.filter((f) => !WORDING_SKIP.some((re) => re.test(f)) && f !== "package-lock.json");
const readOrEmpty = (f: string): string => {
  try {
    return readFileSync(resolveProjectPath(f), "utf8");
  } catch {
    return "";
  }
};
const texts = new Map(searchable.map((f) => [f, readOrEmpty(f)]));

const definitions = ids.map((id) => {
  const versions = rows.filter((r) => r.definition_id === id);
  const pinned = pinnedLines.findIndex((l) => new RegExp(`^\\s*${id}: "\\d+",`).test(l));
  const restated = (RESTATED[id] ?? []).map(count);
  const wordingCopies = versions.flatMap((r) => {
    const piece = r.statement.slice(20, 80);
    return [...texts].filter(([, t]) => t.includes(piece)).map(([f]) => `${f} (${r.definition_key})`);
  });
  return {
    definition_id: id,
    versions_in_layer: versions.map((r) => `${r.definition_key} ${r.status}`),
    version_pinned_in_code: pinned >= 0 ? `${PINNED}:${pinned + 1}` : null,
    restated_in_code: restated,
    approved_wording_copied_in: wordingCopies,
  };
});

// ---- 4. query time (live, from npm run zetaris:timing) ------------------------------------------------------------

interface TimingRead {
  read: string;
  source: string;
  zetaris: { median_ms: number; p95_ms: number; n: number } | null;
  direct: { median_ms: number; p95_ms: number; n: number } | null;
}
const timingFile = resolveProjectPath("eval/zetaris-timing.json");
const timing = existsSync(timingFile)
  ? (JSON.parse(readFileSync(timingFile, "utf8")) as { repeats: number; reads: TimingRead[]; notes: string[] })
  : null;

// ---- outputs --------------------------------------------------------------------------------------------------------

/** Agent files that name any source, table, driver or address: the code the data harness keeps free of sources. */
const namingAnySource = new Set(perSource.flatMap((s) => s.agent_code_naming_this_source.map((h) => h.split(":")[0])))
  .size;

const result = {
  agent_files: { scanned: runtimeFiles.length, naming_any_source: namingAnySource },
  note: "Written by npm run zetaris:harness from committed files; do not edit by hand. A line counts when it is not blank and not a comment-only line.",
  counting_rule: "non-blank lines that do not start with //, /*, *, -- or # after trimming",
  connection: {
    per_source: perSource,
    direct_shared: { loc: sum(directShared), files: directShared },
    zetaris_runtime_shared: { loc: sum(runtime), files: runtime },
    direct_but_not_reads: notReads,
  },
  data_quality: {
    in_layer: {
      custom_rules: customRules,
      key_rules: { primary_keys: primaryKeys, foreign_keys: foreignKeys },
      total_rules: customRules.length + primaryKeys + foreignKeys,
      files: dqInLayer,
      loc: sum(dqInLayer),
    },
    authoring: { loc: sum(dqAuthoring), files: dqAuthoring },
    agents_use_results: { loc: sum(dqUse), files: dqUse },
    rules_reimplemented_by_agents: 0,
    overlaps: dqOverlap,
    direct: { rules: handRules, loc: sum(dqDirect), files: dqDirect },
  },
  definitions: {
    rows_in_layer: rows.length,
    ids: ids.length,
    read_at_run_time: READ_AT_RUN_TIME,
    per_definition: definitions,
  },
  timing: timing ? "eval/zetaris-timing.json" : "not measured yet",
};

const link = (c: Counted) => `\`${c.file}\` ${c.lines} (${c.loc})`;
const list = (cs: Counted[]) => cs.map(link).join("; ");
const LABEL = { bank: "Bank database", payments: "Payments service", lists: "List files" } as const;

const block = [
  `**${namingAnySource} of ${runtimeFiles.length} agent files name any source, table or driver.** The agents ask the one governed semantic layer, which holds the business rules and data-quality rules, and Zetaris queries the data where it lives. Switching a source is a semantic-layer change; no agent code changes.`,
  "",
  `Counted by \`npm run zetaris:harness\` from the committed files (${result.counting_rule}); every number below is in [eval/zetaris-harness.json](../eval/zetaris-harness.json) with its file and line range.`,
  "",
  "**Connection code per source.** The direct path is the hand-coded comparison program in [compare/hand-coded/](../compare/hand-coded/), which reads each source without Zetaris; no agent uses it. On the Zetaris path, onboarding a source is a SQL script (generated) and the agents have one client for every source.",
  "",
  "| Source | Direct path (lines of code) | Zetaris path: onboarding SQL | Zetaris path: TypeScript that writes the SQL | Agent code that names this source |",
  "| --- | ---: | ---: | ---: | ---: |",
  ...perSource.map(
    (s) =>
      `| ${LABEL[s.source]} | ${s.direct.loc} | ${s.zetaris_sql.loc} | ${s.zetaris_generator.loc} | ${s.agent_code_naming_this_source.length} |`,
  ),
  `| Shared by all sources | ${sum(directShared)} (retries, imports) | | | ${sum(runtime)} (the one Zetaris client and the timeout wrapper) |`,
  "",
  `Files: direct ${perSource.map((s) => list(s.direct.files)).join("; ")}; shared ${list(directShared)}. Zetaris ${perSource.map((s) => list([...s.zetaris_sql.files, ...s.zetaris_generator.files])).join("; ")}; runtime ${list(runtime)}. "Agent code that names this source" searches ${runtimeFiles.length} files (\`packages/agents/src\`, \`apps/api/src\`, the runtime files of \`packages/zetaris/src\`) for the source's database, table, driver or address names.`,
  "",
  `Not comparable, listed for completeness: code that reaches a source without Zetaris but writes or probes, never reads for a review: ${notReads.map((n) => `${link(n)} ${n.what}`).join("; ")}.`,
  "",
  "**Data-quality rules.**",
  "",
  "| Where | Rules | Lines |",
  "| --- | ---: | ---: |",
  `| Held in the semantic layer: custom rules (\`zetaris/sql/07_dq_create.sql\`) | ${customRules.length} | ${sum(dqInLayer)} |`,
  `| Held in the semantic layer: key rules Zetaris adds (${primaryKeys} primary and ${foreignKeys} foreign keys in \`zetaris/usl/screening_usl.ddl\`) | ${primaryKeys + foreignKeys} | 0 |`,
  `| Our TypeScript that writes the custom rules | (the same ${customRules.length}) | ${sum(dqAuthoring)} |`,
  `| Agents: rules re-implemented | 0 | 0 |`,
  `| Agents: code that asks the layer which records fail and applies the result | | ${sum(dqUse)} |`,
  `| Direct path: rules, registry and run history by hand (\`compare/hand-coded/dq.mjs\`, one rule for the new-source table) | ${handRules} | ${sum(dqDirect)} |`,
  "",
  `The agents take the rule list from the layer's own description (\`LOAD USL\`), so a new rule needs no agent code: ${list(dqUse)}. Overlaps, where the matching code meets the same bad value while comparing, not to flag the record: ${dqOverlap.map((o) => `${link(o)}, ${o.what}`).join("; ")}.`,
  "",
  `**Business definitions.** ${rows.length} approved rows for ${ids.length} terms live in \`business_definition\` in the semantic layer. The evidence step reads them at run time (${link(READ_AT_RUN_TIME)}); every later step gets the rows and the versions from that one read, and each decision record cites id and version with a hash of the statement. The approved wording is copied nowhere else in the repository. The code still states each test in its own form:`,
  "",
  "| Term | Versions in the layer | Version pinned in code | Restated in code |",
  "| --- | --- | --- | --- |",
  ...definitions.map(
    (d) =>
      `| \`${d.definition_id}\` | ${d.versions_in_layer.join(", ")} | ${d.version_pinned_in_code ? `\`${d.version_pinned_in_code}\`` : "none"} | ${d.restated_in_code.map((c) => `${link(c)} ${c.what}`).join("; ") || "none"} |`,
  ),
  "",
  "**Query time on the same reads**, through Zetaris and directly against each source (`npm run zetaris:timing`):",
  "",
  ...(timing
    ? [
        "| Read | Source | Zetaris median ms | Zetaris p95 ms | Direct median ms | Direct p95 ms |",
        "| --- | --- | ---: | ---: | ---: | ---: |",
        ...timing.reads.map(
          (r) =>
            `| ${r.read} | ${r.source} | ${r.zetaris?.median_ms ?? "n/a"} | ${r.zetaris?.p95_ms ?? "n/a"} | ${r.direct?.median_ms ?? "n/a"} | ${r.direct?.p95_ms ?? "n/a"} |`,
        ),
        "",
        `${timing.repeats} repeats per read; ${timing.notes.join(" ")} Data: [eval/zetaris-timing.json](../eval/zetaris-timing.json).`,
      ]
    : ["Not measured yet."]),
].join("\n");

const check = process.argv.includes("--check");
const outFile = resolveProjectPath("eval/zetaris-harness.json");
// Formatted as `npm run lint` expects, so --check compares like with like.
const json = formatMarkdown(`${JSON.stringify(result, null, 2)}\n`, outFile);
let stale = false;
if (!existsSync(outFile) || readFileSync(outFile, "utf8") !== json) {
  stale = true;
  if (!check) writeFileSync(outFile, json);
}
const docFile = resolveProjectPath("docs/ZETARIS.md");
const doc = readFileSync(docFile, "utf8");
const re = /(<!-- zetaris-harness:start -->)[\s\S]*?(<!-- zetaris-harness:end -->)/;
if (!re.test(doc)) throw new Error("docs/ZETARIS.md has no <!-- zetaris-harness:start --> block");
const next = formatMarkdown(doc.replace(re, `$1\n${block}\n$2`), docFile);
if (next !== doc) {
  stale = true;
  if (!check) writeFileSync(docFile, next);
}
if (check && stale) {
  console.error("the data-harness counts are out of date: run npm run zetaris:harness");
  process.exit(1);
}
console.log(
  `${check ? "checked" : "wrote"} eval/zetaris-harness.json and the block in docs/ZETARIS.md: ${perSource.map((s) => `${s.source} direct ${s.direct.loc} / Zetaris SQL ${s.zetaris_sql.loc}`).join(", ")}; DQ rules in layer ${result.data_quality.in_layer.total_rules}; definitions ${ids.length}`,
);
