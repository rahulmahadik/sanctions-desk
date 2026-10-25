import { describe, expect, it } from "vitest";
import { createMcpHandler, MCP_TOOL_NAMES } from "../src/index.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function server(routes: Record<string, (init?: RequestInit) => Response>, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const handle = createMcpHandler({
    baseUrl: "http://desk.test/",
    headers,
    fetchImpl: async (url, init) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        headers: init?.headers as Record<string, string>,
        body: init?.body as string | undefined,
      });
      const key = Object.keys(routes).find((k) => url.endsWith(k));
      if (!key) return json({ error: { message: `no route ${url}` } }, 404);
      return (routes[key] as (i?: RequestInit) => Response)(init);
    },
  });
  const ask = (method: string, params?: unknown, id: number | null = 1) =>
    handle({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params });
  return { ask, calls, handle };
}

describe("the MCP server", () => {
  it("introduces itself and says who decides", async () => {
    const { ask } = server({});
    const r = (await ask("initialize")) as {
      result: { protocolVersion: string; serverInfo: { name: string }; instructions: string };
    };
    expect(r.result.protocolVersion).toBe("2024-11-05");
    expect(r.result.serverInfo.name).toBe("sanctions-desk");
    expect(r.result.instructions).toContain("A person makes the final call; automatic closing is off by default");
  });

  it("lists read and review tools only: nothing that approves, overrides, reopens, blocks or changes policy", async () => {
    const { ask } = server({});
    const r = (await ask("tools/list")) as {
      result: { tools: Array<{ name: string; inputSchema: { additionalProperties: boolean } }> };
    };
    const names = r.result.tools.map((t) => t.name);
    expect(names).toEqual([
      "list_alerts",
      "review_alert",
      "get_case",
      "get_case_file",
      "verify_receipt",
      "explain_policy",
    ]);
    expect(MCP_TOOL_NAMES).toEqual(names);
    for (const n of names)
      expect(n).not.toMatch(/approve|decide|override|reopen|block|publish|kill|autonomy|policy_change|draft/i);
    expect(r.result.tools.every((t) => t.inputSchema.additionalProperties === false)).toBe(true);
  });

  it("reads the queue through the desk's API, with the caller's own credentials, and filters it", async () => {
    const { ask, calls } = server(
      {
        "/alerts": () =>
          json({
            alerts: [
              {
                alert_id: "A1",
                alert_type: "customer",
                matched_name: "X",
                match_score: 0.9,
                recommendation: "ESCALATE_L2",
                human_status: "awaiting",
                customer_id: "secret-ish",
              },
              {
                alert_id: "A2",
                alert_type: "payment",
                matched_name: "Y",
                match_score: 0.8,
                recommendation: null,
                human_status: "awaiting",
              },
            ],
          }),
      },
      { authorization: "Bearer t-1" },
    );
    const r = (await ask("tools/call", { name: "list_alerts", arguments: { reviewed: true } })) as {
      result: { content: Array<{ text: string }> };
    };
    const out = JSON.parse(r.result.content[0]?.text ?? "{}");
    expect(out.count).toBe(1);
    expect(out.alerts[0]).toEqual({
      alert_id: "A1",
      alert_type: "customer",
      matched_name: "X",
      match_score: 0.9,
      recommendation: "ESCALATE_L2",
      human_status: "awaiting",
    });
    expect(calls[0]?.headers.authorization).toBe("Bearer t-1");
  });

  it("asks for a recommendation and returns it as one, saying a person decides", async () => {
    const { ask, calls } = server({
      "/run": () =>
        json({
          decision: "CLOSE_FALSE_POSITIVE",
          confidence: 0.9,
          rationale: "r",
          key_evidence: ["a"],
          path: "confirm",
          guards: [],
          critic: { rounds: 1 },
          human_review_required: true,
          record_hash: "h".repeat(64),
        }),
    });
    const r = (await ask("tools/call", { name: "review_alert", arguments: { alert_id: "ALR-0004" } })) as {
      result: { content: Array<{ text: string }> };
    };
    const out = JSON.parse(r.result.content[0]?.text ?? "{}");
    expect(out.recommendation).toBe("CLOSE_FALSE_POSITIVE");
    expect(out.note).toContain("A person decides");
    expect(calls[0]).toMatchObject({ method: "POST", body: JSON.stringify({ alert_id: "ALR-0004" }) });
  });

  it("returns the case file as text and checks a receipt", async () => {
    const { ask } = server({
      "/cases/ALR-1/file?format=md": () => new Response("# Case file", { status: 200 }),
      "/receipts/r1/verify": () => json({ status: "valid_unpinned", served_by: "nvidia/nemotron-3-ultra-550b-a55b" }),
    });
    const file = (await ask("tools/call", { name: "get_case_file", arguments: { alert_id: "ALR-1" } })) as {
      result: { content: Array<{ text: string }> };
    };
    expect(file.result.content[0]?.text).toBe("# Case file");
    const receipt = (await ask("tools/call", { name: "verify_receipt", arguments: { receipt_id: "r1" } })) as {
      result: { content: Array<{ text: string }> };
    };
    expect(receipt.result.content[0]?.text).toContain("valid_unpinned");
  });

  it("encodes what it puts in a path, so a crafted id cannot reach another route", async () => {
    const { ask, calls } = server({});
    await ask("tools/call", { name: "get_case", arguments: { alert_id: "../policy" } });
    expect(calls[0]?.url).toBe("http://desk.test/cases/..%2Fpolicy/human");
  });

  it("reports a failed call as a tool error with the desk's own words, not as a protocol error", async () => {
    const { ask } = server({
      "/cases/ALR-9/human": () => json({ error: { message: "alert ALR-9 has no recommendation yet" } }, 404),
    });
    const r = (await ask("tools/call", { name: "get_case", arguments: { alert_id: "ALR-9" } })) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0]?.text).toBe("alert ALR-9 has no recommendation yet");
  });

  it("refuses an unknown tool and a missing argument, answers ping, ignores notifications, and rejects a malformed request", async () => {
    const { ask, handle } = server({});
    expect(
      ((await ask("tools/call", { name: "approve_alert", arguments: {} })) as { error: { code: number } }).error.code,
    ).toBe(-32602);
    expect(
      ((await ask("tools/call", { name: "get_case", arguments: {} })) as { error: { message: string } }).error.message,
    ).toContain("alert_id is required");
    expect(await ask("ping")).toMatchObject({ result: {} });
    expect(await ask("notifications/initialized", undefined, null)).toBeUndefined();
    expect(await handle({ not: "jsonrpc" })).toMatchObject({ error: { code: -32600 } });
    expect(((await ask("resources/list")) as { error: { code: number } }).error.code).toBe(-32601);
  });
});
