/**
 * Record the short animated GIFs of the review desk (docs/media/gifs/) from a running desk in sample mode. Playwright
 * drives the installed Google Chrome and records Chrome's screencast (every painted frame; sharper than a compressed
 * video). ffmpeg turns the useful part into a looping GIF in two passes: a palette, then the GIF.
 *
 *   npm run gifs -- --web http://localhost:3021 --out docs/media/gifs
 *
 * Start the desk first, on a production build (no development badge), for example:
 *   NEXT_PUBLIC_API_URL=http://localhost:8020 npm run build -w @sanctions-desk/web
 *   SAMPLE_MODE=true PORT=8020 WEB_ORIGINS=http://localhost:3021 npm start      (the API)
 *   (cd apps/web && npx next start -p 3021)                                       (the desk)
 *
 * Options: --only case-review,receipts records just those scenes; --fps 12; --width 1280; --height 720;
 * --max-mb 4 (a larger GIF fails the run); --user analyst_demo; --chrome <path> (default: the installed Google Chrome);
 * --keep keeps the recorded frames in the output folder's .frames/ for checking.
 *
 * Each scene presses the real buttons; the only additions to the page are an outline or a tint. A scene whose page
 * text shows a local path, user name, e-mail address or token is not saved.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { type Browser, chromium, type Page } from "playwright-core";
// @ts-expect-error plain JavaScript module shared with the evidence export and the repository scan
import { matches } from "../scripts/redaction-patterns.mjs";

const arg = (n: string, d?: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const web = (arg("--web", "http://localhost:3021") as string).replace(/\/$/, "");
const out = resolveProjectPath(arg("--out", "docs/media/gifs") as string);
const demoUser = arg("--user", "analyst_demo") as string;
const chrome = arg("--chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") as string;
const fps = Number(arg("--fps", "12"));
const width = Number(arg("--width", "1280"));
const height = Number(arg("--height", "720"));
const maxBytes = Number(arg("--max-mb", "4")) * 1024 * 1024;
const keep = process.argv.includes("--keep");
const only = arg("--only")?.split(",");

if (!existsSync(chrome)) throw new Error(`Chrome was not found at ${chrome}; pass --chrome <path>`);
if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0) throw new Error("ffmpeg is not installed");
mkdirSync(out, { recursive: true });

/** The part of the recording (wall-clock seconds) that becomes the GIF. */
interface Clip {
  start: number;
  end: number;
}
type Scene = (page: Page, now: () => number) => Promise<Clip>;

const OUTLINE_CSS = ".gif-focus{outline:3px solid #d97706!important;outline-offset:4px;border-radius:6px}";

/**
 * Run a snippet in the page. The snippets are strings: the tools are type-checked without the browser's types, and
 * the TypeScript runner would rename inner functions with a helper the page does not have.
 */
const inPage = <T = unknown>(page: Page, code: string): Promise<T> => page.evaluate(code) as Promise<T>;
const q = (value: unknown) => JSON.stringify(value);

/** Scroll so the element sits `offset` pixels below the top of the window, gently, over `ms`. */
async function glideTo(page: Page, selector: string, ms = 900, offset = 90): Promise<void> {
  await inPage(
    page,
    `(async () => {
      const el = document.querySelector(${q(selector)});
      if (!el) throw new Error("no element " + ${q(selector)});
      const from = window.scrollY;
      const to = Math.max(0, el.getBoundingClientRect().top + from - ${offset});
      const t0 = performance.now();
      await new Promise((done) => {
        function step(now) {
          const t = Math.min(1, (now - t0) / ${ms});
          const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
          window.scrollTo(0, from + (to - from) * eased);
          if (t < 1) requestAnimationFrame(step);
          else done();
        }
        requestAnimationFrame(step);
      });
    })()`,
  );
}

/** Cut straight to an element (a long scroll past unrelated panels only adds noise and size). */
async function jumpTo(page: Page, selector: string, offset = 20): Promise<void> {
  await inPage(
    page,
    `(() => {
      const el = document.querySelector(${q(selector)});
      if (el) window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - ${offset}));
    })()`,
  );
}

async function point(page: Page, selector: string | null): Promise<void> {
  await inPage(
    page,
    `(() => {
      for (const e of document.querySelectorAll(".gif-focus")) e.classList.remove("gif-focus");
      const selector = ${q(selector)};
      if (selector) document.querySelector(selector)?.classList.add("gif-focus");
    })()`,
  );
}

/** Mark the element matching `inner` (or its nearest section) with a name the scene can find again. */
async function tag(page: Page, inner: string, name: string): Promise<string> {
  await inPage(
    page,
    `(() => {
      const e = document.querySelector(${q(inner)});
      (e?.closest("section") ?? e?.closest(".panel") ?? e)?.setAttribute("data-gif", ${q(name)});
    })()`,
  );
  return `[data-gif="${name}"]`;
}

/** Mark the first element of `kind` whose text matches `pattern` (or the element after it, with `next`). */
async function tagText(page: Page, kind: string, pattern: string, name: string, next = false): Promise<string> {
  await inPage(
    page,
    `(() => {
      const e = [...document.querySelectorAll(${q(kind)})].find((x) => new RegExp(${q(pattern)}).test(x.textContent ?? ""));
      (${next} ? e?.nextElementSibling : e)?.setAttribute("data-gif", ${q(name)});
    })()`,
  );
  return `[data-gif="${name}"]`;
}

/** Press "Review this alert" and wait for the review to finish (sample mode: the agents on the saved data). */
async function review(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Review this alert" }).click();
  await page.getByTestId("critic-rounds").filter({ hasText: "finished" }).first().waitFor({ timeout: 120_000 });
  // The trace, signals, routing and replay are read once the review is recorded.
  await page.waitForSelector("#routing-title", { timeout: 30_000 });
  await page.waitForSelector("#replay-range", { timeout: 30_000 });
}

/** Move the replay slider with the keyboard, one recorded event at a time, up to event `to`. */
async function replay(page: Page, to: number, perEventMs: number): Promise<void> {
  await page.locator("#replay-range").focus();
  await page.keyboard.press("Home");
  for (let i = 0; i < to; i += 1) {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(perEventMs);
  }
}

/** The 1-based number of the first recorded event whose line matches `pattern`. */
const eventNumber = (page: Page, pattern: string) =>
  inPage<number>(
    page,
    `[...document.querySelectorAll("ol.events li")].findIndex((li) => new RegExp(${q(pattern)}).test(li.textContent ?? "")) + 1`,
  );

async function openCase(page: Page, alertId: string): Promise<void> {
  await page.goto(`${web}/case/${alertId}`);
  await page.waitForSelector("#evidence-title", { timeout: 30_000 });
  await page.addStyleTag({ content: OUTLINE_CSS });
  await page.waitForTimeout(400);
}

const scenes: Record<string, Scene> = {
  /** ALR-0073: the review, the step lights, the "Tehran" risk signal, the banner and the checks that keep it open. */
  "case-review": async (page, now) => {
    await openCase(page, "ALR-0073");
    const start = now();
    await page.waitForTimeout(900);
    await point(page, "main p button");
    await page.waitForTimeout(700);
    await point(page, null);
    await review(page);
    // The replay's step map lights up from the recorded events of this run.
    await jumpTo(page, "#replay-title");
    await page.waitForTimeout(300);
    await replay(page, await page.locator("ol.events li").count(), 45);
    await page.waitForTimeout(700);
    await jumpTo(page, await tag(page, "#signals-title", "signals"));
    await point(page, "[data-testid=signal-span]");
    await page.waitForTimeout(1800);
    await point(page, "[data-testid=case-banner]");
    await jumpTo(page, "body", 0);
    await page.waitForTimeout(1500);
    // What keeps a close from happening: the screener's flag and the watched jurisdiction.
    const checks = await tagText(page, "h2", "^Checks$", "checks");
    await tagText(page, "li", "^screener: flag", "screener-check");
    await tagText(page, "li", "^jurisdiction:", "jurisdiction-check");
    await page.addStyleTag({
      content: '[data-gif="screener-check"],[data-gif="jurisdiction-check"]{background:#fef3c7}',
    });
    await point(page, null);
    await glideTo(page, checks, 900, 60);
    await page.waitForTimeout(2000);
    return { start, end: now() };
  },

  /** ALR-0043: the ownership step and why it escalates (a 60 percent holder is blocked, so its 70 percent counts). */
  "ownership-cascade": async (page, now) => {
    await openCase(page, "ALR-0043");
    await review(page);
    await jumpTo(page, "body", 0);
    await page.waitForTimeout(300);
    const start = now();
    await page.waitForTimeout(1200);
    await jumpTo(page, "#replay-title");
    await page.waitForTimeout(300);
    await replay(page, await eventNumber(page, "ownership/evaluate"), 70);
    await point(page, "[data-testid=replay-current]");
    await page.waitForTimeout(2800);
    await point(page, null);
    // The recommendation's "What decided it": the 70 percent counted as a cascade.
    const decided = await tagText(page, "h2", "^What decided it$", "decided", true);
    await jumpTo(page, "#outcome-title");
    await page.waitForTimeout(300);
    await point(page, decided);
    await page.waitForTimeout(2600);
    return { start, end: now() };
  },

  /** ALR-0073: the model chips on each step and the routing panel; sample mode makes no model call, so no receipt. */
  receipts: async (page, now) => {
    await openCase(page, "ALR-0073");
    await review(page);
    await jumpTo(page, "body", 0);
    await page.waitForTimeout(300);
    const start = now();
    await page.waitForTimeout(800);
    await glideTo(page, "#graph-title", 1000, 20);
    await point(page, "[data-testid=node-screener]");
    await page.waitForTimeout(1600);
    await point(page, "[data-testid=node-decision]");
    await page.waitForTimeout(1600);
    await point(page, null);
    const routing = await tag(page, "#routing-title", "routing");
    await jumpTo(page, routing);
    // Tint the receipt columns: "none" in sample mode, since the rules-based stand-in makes no model call.
    await inPage(
      page,
      `(() => {
        const rows = [...document.querySelectorAll('[data-gif="routing"] table tr')].map((tr) => [...tr.children]);
        const head = rows[0]?.map((c) => c.textContent) ?? [];
        for (const name of ["Receipt id", "Receipt check"]) {
          const col = head.indexOf(name);
          for (const row of rows) row[col]?.setAttribute("style", "background:#fef3c7");
        }
      })()`,
    );
    await page.waitForTimeout(3200);
    return { start, end: now() };
  },
};

/** One frame from the browser's screencast, with the time (wall-clock seconds) it was painted. */
interface Frame {
  t: number;
  file: string;
}

/**
 * The GIF at a steady frame rate: for each GIF frame, the screencast frame on screen at that moment (Chrome sends a
 * frame only when the page changes, so a still page is one frame held). Written as an ffmpeg concat list.
 */
function toGif(frames: Frame[], clip: Clip, gif: string, work: string): void {
  if (frames.length === 0) throw new Error("no frames were recorded");
  const step = 1 / fps;
  const lines: string[] = [];
  let at = 0;
  let last = "";
  for (let t = clip.start; t < clip.end; t += step) {
    while (at + 1 < frames.length && (frames[at + 1] as Frame).t <= t) at += 1;
    last = (frames[at] as Frame).file;
    lines.push(`file '${last}'`, `duration ${step.toFixed(4)}`);
  }
  // The concat input ignores the duration of its last entry, so the last frame is listed once more.
  lines.push(`file '${last}'`);
  const list = join(work, "frames.txt");
  writeFileSync(list, `${lines.join("\n")}\n`);
  const input = ["-f", "concat", "-safe", "0", "-i", list];
  const filters = `fps=${fps},scale=${width}:-1:flags=lanczos`;
  const palette = join(work, "palette.png");
  const run = (args: string[]) => {
    const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  };
  run([...input, "-vf", `${filters},palettegen=max_colors=128:stats_mode=diff`, palette]);
  run([
    ...input,
    "-i",
    palette,
    "-lavfi",
    `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    "-loop",
    "0",
    gif,
  ]);
}

const problems: string[] = [];
const work = mkdtempSync(join(tmpdir(), "desk-gifs-"));
const browser: Browser = await chromium.launch({ executablePath: chrome, headless: true });
try {
  for (const [name, scene] of Object.entries(scenes).filter(([n]) => !only || only.includes(n))) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: "light" });
    // The sample-mode demo user, chosen the way the user switcher does (this browser's local storage).
    await context.addInitScript((user) => {
      try {
        localStorage.setItem("desk.demoUser", user);
      } catch {
        // storage is blocked; the desk works as a read-only visitor
      }
    }, demoUser);
    const page = await context.newPage();
    // Every painted frame from Chrome's screencast, saved as a PNG with its time.
    const frameDir = join(keep ? join(out, ".frames") : work, name);
    mkdirSync(frameDir, { recursive: true });
    const frames: Frame[] = [];
    const cdp = await context.newCDPSession(page);
    cdp.on("Page.screencastFrame", (f) => {
      const file = join(frameDir, `${String(frames.length).padStart(5, "0")}.png`);
      writeFileSync(file, Buffer.from(f.data, "base64"));
      frames.push({ t: f.metadata.timestamp ?? Date.now() / 1000, file });
      void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined);
    });
    await cdp.send("Page.startScreencast", { format: "png", maxWidth: width, maxHeight: height, everyNthFrame: 1 });
    const now = () => Date.now() / 1000;
    let clip: Clip | undefined;
    try {
      clip = await scene(page, now);
      // All of the page's text, hidden parts included, so nothing slips past the check.
      const found = matches((await page.locator("body").textContent()) ?? "") as string[];
      if (found.length > 0) {
        problems.push(`${name}: the page shows ${found.join(", ")}; not saved`);
        clip = undefined;
      }
    } catch (err) {
      problems.push(`${name}: ${(err as Error).message}`);
    }
    await cdp.send("Page.stopScreencast").catch(() => undefined);
    await context.close();
    if (!clip) continue;
    const gif = join(out, `${name}.gif`);
    toGif(frames, clip, gif, work);
    const bytes = statSync(gif).size;
    const seconds = (clip.end - clip.start).toFixed(1);
    if (bytes > maxBytes) problems.push(`${name}.gif is ${(bytes / 1048576).toFixed(1)} MB, over the limit`);
    console.log(`saved ${name}.gif (${seconds} s, ${frames.length} frames, ${(bytes / 1048576).toFixed(2)} MB)`);
  }
} finally {
  await browser.close();
  rmSync(work, { recursive: true, force: true });
}
if (problems.length > 0) {
  console.error(`\n${problems.join("\n")}`);
  process.exit(1);
}
