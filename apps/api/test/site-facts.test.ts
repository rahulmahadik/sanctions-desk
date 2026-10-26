import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { USL_STEP_ROLES } from "@sanctions-desk/zetaris";
import { afterAll, describe, expect, it } from "vitest";
import { type ExamArmRow, LIGHTNING, ULTRA } from "../../../tools/lib/nemotron-scorecard.js";
import { REPO_URL } from "../../../tools/lib/site-chrome.js";
import {
  badgeOf,
  casesHtml,
  type EnforcementCase,
  enforcementCases,
  fillIndex,
  SiteFactsError,
  STORY_CASE,
  siteFacts,
  stepRowsHtml,
  storyLinksHtml,
} from "../../../tools/lib/site-facts.js";

/**
 * The home page's figures and cards, on made-up committed files: what each guard stops the build for, and what the
 * generators write. The committed data itself is checked in site.test.ts.
 */
const scratch = mkdtempSync(join(tmpdir(), "desk-site-facts-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const figures = (wrong: number, risk: number): NonNullable<ExamArmRow["figures"]> => ({
  wrong,
  risk,
  wrong_range: "0–8%",
  clears_made: 20,
  clears: 27,
  blocks: 2,
  unsupported_blocks: 0,
  not_block_cases: 60,
  unsupported_range: "0–6%",
  unusable: 0,
  answer_from: "Ultra 70",
});
const arm = (label: string, source: string, wrong: number, risk = 43): ExamArmRow => ({
  arm: label,
  source,
  figures: figures(wrong, risk),
});
type StoryCase = { case_id: string; got: string; confidence?: number };
const story = (got: string, confidence = 0.85): StoryCase[] => [{ case_id: STORY_CASE, got, confidence }];

type FakeCheck = {
  receipts: number;
  headline: number;
  from_local_mode: number;
  valid_pinned: number;
  groups: { local_mode: { valid_pinned: number } };
};
/** The receipt check as npm run receipts:check writes it: every receipt verified, the fully local study's set apart. */
const check = (over: Partial<FakeCheck> = {}): FakeCheck => ({
  receipts: 3947,
  headline: 3411,
  from_local_mode: 536,
  valid_pinned: 3947,
  groups: { local_mode: { valid_pinned: 536 } },
  ...over,
});

interface FakeRoot {
  arms?: ExamArmRow[];
  receipts?: FakeCheck;
  results?: Record<string, StoryCase[]>;
}

/** A project root with just the files the home page's figures read, each as given or as a sound default. */
function fakeRoot(over: FakeRoot = {}): string {
  const root = mkdtempSync(join(scratch, "root-"));
  const write = (rel: string, value: unknown) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), JSON.stringify(value));
  };
  const arms = over.arms ?? [
    arm("Full system, first system", "eval/results/full1.json", 2),
    arm("Full system, current system", "eval/results/full2.json", 0),
    arm("Deterministic rules", "eval/results/rules.json", 0),
    arm("Nemotron alone, without the free text", "eval/results/alone-notext.json", 3),
    arm("Nemotron alone, with the free text (sent to the cloud)", "eval/results/alone-text.json", 4),
  ];
  write("eval/nemotron-scorecard.json", { exam_arms: arms });
  write("eval/receipts-check.json", over.receipts ?? check());
  const results = over.results ?? {
    "eval/results/full1.json": story("ESCALATE_L2", 0.7),
    "eval/results/full2.json": story("NEED_MORE_INFO", 0.6),
    "eval/results/rules.json": story("CLOSE_FALSE_POSITIVE"),
    "eval/results/alone-notext.json": story("CLOSE_FALSE_POSITIVE"),
    "eval/results/alone-text.json": story("CLOSE_FALSE_POSITIVE"),
  };
  for (const [rel, cases] of Object.entries(results)) write(rel, { cases });
  return root;
}

describe("the home page's figures", () => {
  it("come from the newest scored arms, the receipt check and the code", () => {
    expect(siteFacts(fakeRoot())).toEqual({
      full_wrong: "0 of 43",
      alone_wrong: "4 of 43",
      receipts: "3,411",
      receipts_local_mode_line: "Fully local study (A3): 536 signed receipts, all verified against the pinned key.",
      step_roles: String(USL_STEP_ROLES.length),
      story_alone_conf: "0.85",
      story_desk_runs: "2 of 2",
      story_desk_now: "ask for more information",
    });
  });

  it("quote the headline without the fully local study's receipts, and say when that study has none yet", () => {
    const none = fakeRoot({
      receipts: check({
        receipts: 3411,
        from_local_mode: 0,
        valid_pinned: 3411,
        groups: { local_mode: { valid_pinned: 0 } },
      }),
    });
    expect(siteFacts(none)).toMatchObject({
      receipts: "3,411",
      receipts_local_mode_line: "Fully local study (A3): no receipts exported yet.",
    });
  });

  it("stop the build when a receipt does not verify against the pinned key, or the two counts do not add up", () => {
    expect(() => siteFacts(fakeRoot({ receipts: check({ valid_pinned: 3946 }) }))).toThrow(
      /do not verify against the pinned key/,
    );
    expect(() => siteFacts(fakeRoot({ receipts: check({ headline: 3410 }) }))).toThrow(/do not add up/);
  });

  it("stop the build when the two arms score different numbers of risk cases", () => {
    const root = fakeRoot({
      arms: [
        arm("Full system, current system", "eval/results/full2.json", 0),
        arm("Nemotron alone, without the free text", "eval/results/alone-notext.json", 3),
        arm("Nemotron alone, with the free text", "eval/results/alone-text.json", 4, 42),
      ],
    });
    expect(() => siteFacts(root)).toThrow(/different numbers of risk cases/);
  });

  it("stop the build when no full-system arm has figures yet", () => {
    const root = fakeRoot({
      arms: [
        { arm: "Full system, current system", source: "eval/results/full2.json", figures: null },
        arm("Nemotron alone, without the free text", "eval/results/alone-notext.json", 3),
        arm("Nemotron alone, with the free text", "eval/results/alone-text.json", 4),
      ],
    });
    expect(() => siteFacts(root)).toThrow(/no scored arm starting "Full system"/);
  });

  it.each([
    ["the Nemotron-alone runs no longer agree on the story case", "eval/results/alone-text.json", "ESCALATE_L2", 0.85],
    [
      "the Nemotron-alone runs close it at different confidences",
      "eval/results/alone-text.json",
      "CLOSE_FALSE_POSITIVE",
      0.7,
    ],
  ])("stop the build when %s", (_name, file, got, confidence) => {
    const root = fakeRoot({
      results: {
        "eval/results/full1.json": story("ESCALATE_L2", 0.7),
        "eval/results/full2.json": story("NEED_MORE_INFO", 0.6),
        "eval/results/rules.json": story("CLOSE_FALSE_POSITIVE"),
        "eval/results/alone-notext.json": story("CLOSE_FALSE_POSITIVE"),
        [file]: story(got, confidence),
      },
    });
    expect(() => siteFacts(root)).toThrow(new RegExp(`no longer both close ${STORY_CASE} at one confidence`));
  });

  it("stop the build when a full-system run closed the story case, or a result file has no such case", () => {
    const base = {
      "eval/results/full1.json": story("ESCALATE_L2", 0.7),
      "eval/results/rules.json": story("CLOSE_FALSE_POSITIVE"),
      "eval/results/alone-notext.json": story("CLOSE_FALSE_POSITIVE"),
      "eval/results/alone-text.json": story("CLOSE_FALSE_POSITIVE"),
    };
    const closed = fakeRoot({ results: { ...base, "eval/results/full2.json": story("CLOSE_FALSE_POSITIVE", 0.9) } });
    expect(() => siteFacts(closed)).toThrow(new RegExp(`a full-system run closed ${STORY_CASE}`));
    const missing = fakeRoot({
      results: { ...base, "eval/results/full2.json": [{ case_id: "EX-001", got: "ESCALATE_L2" }] },
    });
    expect(() => siteFacts(missing)).toThrow(new RegExp(`has no case ${STORY_CASE}`));
    const unreadable = fakeRoot({ results: base });
    expect(() => siteFacts(unreadable)).toThrow(SiteFactsError);
    expect(() => siteFacts(unreadable)).toThrow(/full2\.json cannot be read/);
  });

  it("link the story card to both Nemotron-alone result files and the newest full-system run", () => {
    const links = storyLinksHtml(fakeRoot());
    expect([...links.matchAll(/href="([^"]+)">([^<]+)</g)].map((m) => [m[1], m[2]])).toEqual([
      [`${REPO_URL}/blob/main/eval/results/alone-text.json`, "Nemotron alone, with the free text"],
      [`${REPO_URL}/blob/main/eval/results/alone-notext.json`, "Nemotron alone, without it"],
      [`${REPO_URL}/blob/main/eval/results/full2.json`, "the desk, newest run"],
    ]);
  });
});

describe("the step-to-model card", () => {
  it("gives each model its badge: the Ollama backup first, then Ultra in the cloud, else Lightning on the laptop", () => {
    expect(badgeOf(`${LIGHTNING} (local Ollama)`)).toEqual({
      cls: "badge-backup",
      text: "Ollama · backup, no receipt",
    });
    expect(badgeOf(ULTRA)).toEqual({ cls: "badge-cloud", text: "Nemotron 3 Ultra · cloud" });
    expect(badgeOf(LIGHTNING)).toEqual({ cls: "badge-local", text: "Nemotron 3.5 Lightning · local" });
  });
});

describe("filling the home page", () => {
  const facts = { n: "1 of 2" };
  const page = (blocks: string) => `<!-- steps:start -->old<!-- steps:end -->${blocks}<!--fact:n-->0<!--/fact-->`;

  it("needs the steps block, and rewrites it from the step table", () => {
    expect(() => fillIndex("<!--fact:n-->0<!--/fact-->", facts)).toThrow(/no <!-- steps:start --> block/);
    const out = fillIndex(page(""), facts);
    expect(out).toContain(`<!-- steps:start -->\n${stepRowsHtml()}\n            <!-- steps:end -->`);
    expect(out).not.toContain("old");
    expect(out).toContain("<!--fact:n-->1 of 2<!--/fact-->");
  });

  it("escapes a fact's value", () => {
    expect(fillIndex(page(""), { n: "<b>&" })).toContain("<!--fact:n-->&lt;b&gt;&amp;<!--/fact-->");
  });

  it("leaves the story-links and cases blocks as they are unless given their content", () => {
    const blocks = "<!-- story-links:start -->links<!-- story-links:end --><!-- cases:start -->cards<!-- cases:end -->";
    const kept = fillIndex(page(blocks), facts);
    expect(kept).toContain("<!-- story-links:start -->links<!-- story-links:end -->");
    expect(kept).toContain("<!-- cases:start -->cards<!-- cases:end -->");
    const filled = fillIndex(page(blocks), facts, "<a>x</a>", "<li>y</li>");
    expect(filled).toContain("<!-- story-links:start -->\n<a>x</a>\n          <!-- story-links:end -->");
    expect(filled).toContain("<!-- cases:start -->\n<li>y</li>\n            <!-- cases:end -->");
    expect(filled).not.toContain("-->links<!--");
    expect(filled).not.toContain("-->cards<!--");
  });
});

describe("the enforcement cases", () => {
  const readme = (lines: string[], rows: string[]) =>
    [
      "# Title",
      "",
      "The problem",
      "",
      ...lines,
      "",
      "| Year | Firm | Authority and outcome | Gap | Source |",
      "| --- | --- | --- | --- | --- |",
      ...rows,
      "",
    ].join("\n");
  const line = (firm: string, authority: string, year: string, gap: string) =>
    `- **${firm}** (${authority}, ${year}): ${gap}`;
  const row = (year: string, firm: string, authority: string, outcome: string, label: string, url: string) =>
    `| ${year} | ${firm} | ${authority}: ${outcome} | What was missing | [${label}](${url}) |`;
  const rootWith = (text: string | undefined): string => {
    const root = mkdtempSync(join(scratch, "readme-"));
    if (text !== undefined) writeFileSync(join(root, "README.md"), text);
    return root;
  };

  it("match each short line to its table row by year, authority and firm, and take the full firm name from the row", () => {
    const root = rootWith(
      readme(
        [
          line("Firm A", "OFAC", "2019", "no screening of the other party"),
          line("Firm B Ltd", "NYDFS", "2021", "a stale clearance"),
        ],
        [
          row("2021", "Firm B Ltd", "NYDFS", "$2 penalty", "Consent order", "https://example.org/b"),
          row(
            "2019",
            "Firm A Inc.",
            "OFAC",
            "$1,000 settlement",
            "Enforcement release",
            "https://example.org/a?x=1&y=2",
          ),
        ],
      ),
    );
    expect(enforcementCases(root)).toEqual([
      {
        year: "2019",
        firm: "Firm A Inc.",
        authority: "OFAC",
        outcome: "$1,000 settlement",
        gap: "no screening of the other party",
        sourceLabel: "Enforcement release",
        sourceUrl: "https://example.org/a?x=1&y=2",
      },
      {
        year: "2021",
        firm: "Firm B Ltd",
        authority: "NYDFS",
        outcome: "$2 penalty",
        gap: "a stale clearance",
        sourceLabel: "Consent order",
        sourceUrl: "https://example.org/b",
      },
    ]);
  });

  it("stop the build when the README has no cases, or more lines than rows, or a line with no row", () => {
    expect(() => enforcementCases(rootWith(readme([], [])))).toThrow(/lists 0 enforcement cases/);
    const oneRow = [row("2019", "Firm A", "OFAC", "$1 settlement", "Release", "https://example.org/a")];
    const twoLines = [line("Firm A", "OFAC", "2019", "x"), line("Firm B", "OFAC", "2020", "y")];
    expect(() => enforcementCases(rootWith(readme(twoLines, oneRow)))).toThrow(
      /lists 2 enforcement cases but its table has 1 rows/,
    );
    const wrongYear = [row("2018", "Firm A", "OFAC", "$1 settlement", "Release", "https://example.org/a")];
    expect(() => enforcementCases(rootWith(readme([line("Firm A", "OFAC", "2019", "x")], wrongYear)))).toThrow(
      /no table row for the 2019 Firm A case/,
    );
    expect(() => enforcementCases(rootWith(undefined))).toThrow(/README\.md cannot be read/);
  });

  it("are written as cards that escape every value and open the official release in a new tab", () => {
    const c: EnforcementCase = {
      year: "2019",
      firm: "A & B <Co>",
      authority: "OFAC",
      outcome: '$1 "settlement"',
      gap: "a gap",
      sourceLabel: "Release",
      sourceUrl: "https://example.org/a?x=1&y=2",
    };
    const html = casesHtml([c]);
    expect(html).toContain('<h4 class="case-firm">A &amp; B &lt;Co&gt;</h4>');
    expect(html).toContain('<p class="case-outcome">$1 &quot;settlement&quot;</p>');
    expect(html).toContain(
      '<a class="case-source" href="https://example.org/a?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">Release</a>',
    );
    expect(html.match(/<li class="case">/g)).toHaveLength(1);
    expect(casesHtml([])).toBe("");
  });
});
