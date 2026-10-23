import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { modelLabel, routingSplit } from "../src/index.js";

const ULTRA = "nvidia/nemotron-3-ultra-550b-a55b";
const LIGHT = "local-runtime/nemotron-3.5-lightning-30b-a3b";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "split-"));
  mkdirSync(join(dir, "receipts"));
  const events: string[] = [];
  let n = 0;
  const call = (agent: string, model: string, kind: string, ts = "2026-10-23T05:00:00.000Z") => {
    n += 1;
    const id = `rcpt_${n}`;
    writeFileSync(
      join(dir, "receipts", `${id}.json`),
      JSON.stringify({
        body: {
          receipt: {
            winning_route: { kind, model },
            app_policy: { mode_coerced: true },
            routing: { policy: "learned-router" },
          },
        },
      }),
    );
    events.push(JSON.stringify({ ts, agent, action: "model_answer", receipt: { receipt_id: id } }));
  };
  return {
    dir,
    call,
    write: () => writeFileSync(join(dir, "trace-eval-routed-EX-001.jsonl"), `${events.join("\n")}\n`),
  };
}

describe("routingSplit", () => {
  it("counts, per step, which model the receipts say served each call", () => {
    const s = setup();
    for (let i = 0; i < 49; i += 1) s.call("decision", ULTRA, "cloud");
    s.call("critic", ULTRA, "cloud");
    s.call("critic", LIGHT, "local");
    for (let i = 0; i < 4; i += 1) s.call("policy_guard", LIGHT, "local");
    s.call("decision", ULTRA, "cloud", "2026-10-23T03:00:00.000Z"); // before the run started
    s.write();
    const split = routingSplit(s.dir, "routed", "2026-10-23T04:52:42");
    expect(split.rows.map((r) => [r.step, r.calls])).toEqual([
      ["Safety guard", 4],
      ["Decision", 49],
      ["Critic", 2],
    ]);
    expect(split.rows[0]?.models).toEqual([{ model: LIGHT, kind: "local", calls: 4, share: 1 }]);
    expect(split.rows[1]?.models[0]).toMatchObject({ model: ULTRA, kind: "cloud", share: 1 });
    expect(split.rows[2]?.models.map((m) => [m.kind, m.share])).toEqual([
      ["cloud", 0.5],
      ["local", 0.5],
    ]);
    expect(split).toMatchObject({ receipts: 55, mode_coerced: 55, routers: ["learned-router"] });
  });

  it("copes with a folder that is missing, and ignores a receipt it cannot find", () => {
    expect(routingSplit(join(tmpdir(), "no-such-folder-xyz"), "routed", "")).toMatchObject({ rows: [], receipts: 0 });
    const s = setup();
    s.call("decision", ULTRA, "cloud");
    s.write();
    expect(routingSplit(s.dir, "single", "").rows).toEqual([]);
  });

  it("names the Nemotron models plainly", () => {
    expect(modelLabel(ULTRA)).toBe("Nemotron 3 Ultra 550B");
    expect(modelLabel(LIGHT)).toBe("Nemotron 3.5 Lightning 30B");
    expect(modelLabel("other/model")).toBe("other/model");
  });
});
