/**
 * Take the screenshots of the main screens, from a running review desk, with headless Chrome (no extra package: it
 * talks to the browser over the DevTools protocol). Each page's text is checked first for local paths, user names,
 * e-mail addresses and tokens; a page that shows one is not saved.
 *
 *   npm run screenshots -- --web http://localhost:3001 --alert ALR-0004 --out docs/media/screenshots
 *
 * The API must be running and, for the case screens, the alert must already have a recommendation (run a review
 * first). Pick the demo user with --user analyst_demo (sample mode only).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectPath } from "@sanctions-desk/shared";
// @ts-expect-error plain JavaScript module shared with the evidence export and the repository scan
import { matches } from "../scripts/redaction-patterns.mjs";

const arg = (n: string, d?: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const web = (arg("--web", "http://localhost:3001") as string).replace(/\/$/, "");
const alert = arg("--alert", "ALR-0004") as string;
/** A case whose free text gives a risk signal, for the signals panel. */
const signalsAlert = arg("--signals-alert", "ALR-0073") as string;
const out = resolveProjectPath(arg("--out", "docs/media/screenshots") as string);
const demoUser = arg("--user", "analyst_demo") as string;
const chrome = arg("--chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") as string;
const port = Number(arg("--port", "9333"));
const width = Number(arg("--width", "1280"));

if (!existsSync(chrome)) throw new Error(`Chrome was not found at ${chrome}; pass --chrome <path>`);
mkdirSync(out, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "desk-shots-"));
const browser: ChildProcess = spawn(
  chrome,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--hide-scrollbars",
    "--no-first-run",
    "--disable-gpu",
    `--window-size=${width},900`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function connect() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const tabs = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as Array<{
        type: string;
        webSocketDebuggerUrl: string;
      }>;
      const page = tabs.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error("the browser did not start");
}

const socket = new WebSocket(await connect());
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let id = 0;
const waiting = new Map<number, (v: Record<string, unknown>) => void>();
socket.addEventListener("message", (m) => {
  const msg = JSON.parse(String(m.data)) as { id?: number; result?: Record<string, unknown> };
  if (msg.id !== undefined) waiting.get(msg.id)?.(msg.result ?? {});
});
const send = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<Record<string, unknown>>((resolve) => {
    id += 1;
    waiting.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async <T>(expression: string): Promise<T> => {
  const r = (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as {
    result?: { value: T };
  };
  return r.result?.value as T;
};
const waitFor = async (expression: string, ms = 20_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await evaluate<boolean>(`Boolean(${expression})`)) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${expression}`);
};

await send("Page.enable");
// --dark shows the pages in the dark colour scheme, to check contrast there; the published shots are light.
if (process.argv.includes("--dark"))
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: web });
await waitFor("document.readyState === 'complete'");
// Choose the demo user for the whole session (sample mode); a live deployment ignores it.
await evaluate(`localStorage.setItem('desk.demoUser', ${JSON.stringify(demoUser)})`);

interface Shot {
  name: string;
  path: string;
  ready: string;
  before?: string;
  /** A selector inside the panel to show: the shot is clipped to its section instead of the whole page. */
  focus?: string;
}
const shots: Shot[] = [
  { name: "01-alert-queue", path: "/", ready: "document.querySelectorAll('tbody tr').length > 3" },
  { name: "02-case-evidence", path: `/case/${alert}`, ready: "document.querySelector('#evidence-title')" },
  {
    name: "03-decision-panel",
    path: `/case/${alert}`,
    ready: "document.querySelector('#decision-h')",
    focus: "#decision-h",
  },
  {
    name: "04-routing-and-receipts",
    path: `/case/${alert}`,
    ready: "document.querySelector('#routing-title')",
    before: `(async()=>{const b=[...document.querySelectorAll('button')].find(x=>/Verify receipt/.test(x.getAttribute('aria-label')||''));if(b){b.click();await new Promise(r=>setTimeout(r,1500));}})()`,
    focus: "#routing-title",
  },
  { name: "05-policy-studio", path: "/policy", ready: "document.querySelector('[data-testid=autonomy-card]')" },
  { name: "06-governance", path: "/governance", ready: "document.querySelector('#g-oversight')" },
  { name: "07-exam-results", path: "/exam", ready: "document.querySelector('table')" },
  { name: "08-help", path: "/help", ready: "document.querySelector('#help-start')" },
  {
    name: "09-risk-signals",
    path: `/case/${signalsAlert}`,
    ready: "document.querySelector('#signals-title')",
    focus: "#signals-title",
  },
  {
    name: "10-list-change",
    path: "/",
    ready: "document.querySelector('#list-change-title')",
    before: `(async()=>{const b=[...document.querySelectorAll('button')].find(x=>/Check earlier decisions/.test(x.textContent||''));if(b){b.click();for(let i=0;i<40&&!document.querySelector('[data-testid=list-change]');i++)await new Promise(r=>setTimeout(r,250));}})()`,
    focus: "#list-change-title",
  },
  {
    name: "12-agent-map",
    path: `/case/${signalsAlert}`,
    ready: "[...document.querySelectorAll('button')].some(x=>/Review this alert/.test(x.textContent||''))",
    before: `(async()=>{const b=[...document.querySelectorAll('button')].find(x=>/Review this alert/.test(x.textContent||''));if(b){b.click();for(let i=0;i<60&&!/finished/.test(document.querySelector('[data-testid=critic-rounds]')?.textContent||'');i++)await new Promise(r=>setTimeout(r,250));}})()`,
    focus: "#graph-title",
  },
  {
    name: "11-heldout-rounds",
    path: "/exam",
    ready: "document.querySelector('[data-testid=heldout-rounds]')",
    focus: "[data-testid=heldout-rounds]",
  },
];

const problems: string[] = [];
for (const shot of shots) {
  await send("Page.navigate", { url: `${web}${shot.path}` });
  await sleep(500);
  try {
    await waitFor(shot.ready);
  } catch (err) {
    problems.push(`${shot.name}: ${(err as Error).message}`);
    continue;
  }
  await sleep(800);
  if (shot.before) await evaluate(shot.before);
  await sleep(400);
  const text = await evaluate<string>("document.body.innerText");
  const found = matches(text) as string[];
  if (found.length > 0) {
    problems.push(`${shot.name}: the page shows ${found.join(", ")}; not saved`);
    continue;
  }
  const size = (await send("Page.getLayoutMetrics")) as { cssContentSize?: { width: number; height: number } };
  const height = Math.min(Math.ceil(size.cssContentSize?.height ?? 900), 4000);
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  const clip = shot.focus
    ? await evaluate<string>(
        `(()=>{const e=document.querySelector(${JSON.stringify(shot.focus)});const p=e&&(e.closest('section')||e.closest('.panel')||e);if(!p)return '';const r=p.getBoundingClientRect();return JSON.stringify({x:Math.max(0,r.x-8),y:Math.max(0,r.y+window.scrollY-8),width:Math.min(${width},r.width+16),height:r.height+16,scale:1});})()`,
      )
    : "";
  const png = (await send("Page.captureScreenshot", {
    format: "png",
    ...(clip ? { clip: JSON.parse(clip), captureBeyondViewport: true } : {}),
  })) as { data: string };
  writeFileSync(join(out, `${shot.name}.png`), Buffer.from(png.data, "base64"));
  await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
  console.log(`saved ${shot.name}.png (${height}px high)`);
}

socket.close();
browser.kill();
await sleep(500);
rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
if (problems.length > 0) {
  console.error(`\n${problems.join("\n")}`);
  process.exit(1);
}
