/**
 * A Model Context Protocol server for the review desk, as a plain message handler (JSON-RPC 2.0). It lets an AI
 * assistant read the alert queue, ask for a review, read a case and its case file, and check a signed receipt.
 *
 * What it cannot do, by design: approve, override, reopen, change policy or touch autonomy. The desk recommends and a
 * person decides; there is no tool here that decides, so an assistant cannot either. Every call goes through the
 * desk's own API with the credentials the operator gives it, so the API's sign-in and roles apply as they do for a person.
 */

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface McpOptions {
  /** Where the desk's API listens, for example http://localhost:8000. */
  baseUrl: string;
  /** Headers that identify the caller: a bearer token, or a demo user in sample mode. */
  headers?: Record<string, string>;
  fetchImpl?: Fetch;
  timeoutMs?: number;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>, api: Api) => Promise<unknown>;
}

interface Api {
  get: (path: string) => Promise<unknown>;
  getText: (path: string) => Promise<string>;
  post: (path: string, body: unknown) => Promise<unknown>;
}

const alertId = {
  type: "string",
  pattern: "^[A-Za-z0-9._-]{1,100}$",
  description: "The alert id, for example ALR-0004",
};
const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || v === "") throw new McpError(-32602, `${name} is required`);
  return v;
};

export class McpError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const TOOLS: readonly Tool[] = [
  {
    name: "list_alerts",
    description:
      "List the alerts in the review queue with the latest recommendation and where people have taken it (waiting, human-approved, block approval pending, auto-closed, QA sample).",
    inputSchema: {
      type: "object",
      properties: {
        alert_type: { type: "string", enum: ["customer", "payment"] },
        reviewed: {
          type: "boolean",
          description: "true: only alerts that have a recommendation; false: only those without",
        },
      },
      additionalProperties: false,
    },
    async run(args, api) {
      const body = (await api.get("/alerts")) as { alerts: Array<Record<string, unknown>> };
      const alerts = body.alerts.filter(
        (a) =>
          (args.alert_type === undefined || a.alert_type === args.alert_type) &&
          (args.reviewed === undefined || (a.recommendation !== null) === args.reviewed),
      );
      return {
        count: alerts.length,
        alerts: alerts.map((a) => ({
          alert_id: a.alert_id,
          alert_type: a.alert_type,
          matched_name: a.matched_name,
          match_score: a.match_score,
          recommendation: a.recommendation,
          human_status: a.human_status,
        })),
      };
    },
  },
  {
    name: "review_alert",
    description:
      "Run the desk's review of one alert and return its RECOMMENDATION with the evidence that decided it. This is a recommendation for a person: nothing is decided, blocked, sent or written to a source system.",
    inputSchema: {
      type: "object",
      properties: { alert_id: alertId },
      required: ["alert_id"],
      additionalProperties: false,
    },
    async run(args, api) {
      const r = (await api.post("/run", { alert_id: str(args.alert_id, "alert_id") })) as Record<string, unknown>;
      return {
        recommendation: r.decision,
        confidence: r.confidence,
        rationale: r.rationale,
        key_evidence: r.key_evidence,
        path: r.path,
        guards: r.guards,
        critic: r.critic,
        human_review_required: r.human_review_required,
        record_hash: r.record_hash,
        note: "A person decides. This tool cannot approve or override.",
      };
    },
  },
  {
    name: "get_case",
    description:
      "Where a case stands: the recommendation, what people did (approvals, overrides, second approvals), and the records prepared after their decision.",
    inputSchema: {
      type: "object",
      properties: { alert_id: alertId },
      required: ["alert_id"],
      additionalProperties: false,
    },
    run: (args, api) => api.get(`/cases/${encodeURIComponent(str(args.alert_id, "alert_id"))}/human`),
  },
  {
    name: "get_case_file",
    description:
      "The case file for an alert as Markdown: recommendation, facts, what people did, what was prepared next, the models and the record hash.",
    inputSchema: {
      type: "object",
      properties: { alert_id: alertId },
      required: ["alert_id"],
      additionalProperties: false,
    },
    run: (args, api) => api.getText(`/cases/${encodeURIComponent(str(args.alert_id, "alert_id"))}/file?format=md`),
  },
  {
    name: "verify_receipt",
    description:
      "Check a stored signed Nightshift receipt: whether the signature verifies, whether the key is pinned, and which Nemotron model served the call under which app and mode.",
    inputSchema: {
      type: "object",
      properties: { receipt_id: { type: "string", pattern: "^[A-Za-z0-9._-]{1,100}$" } },
      required: ["receipt_id"],
      additionalProperties: false,
    },
    run: (args, api) => api.get(`/receipts/${encodeURIComponent(str(args.receipt_id, "receipt_id"))}/verify`),
  },
  {
    name: "explain_policy",
    description:
      "The active policy in brief: version, autonomy level and what is locked, thresholds, and who must approve what.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(_args, api) {
      const p = (await api.get("/policy")) as {
        version: number;
        hash: string;
        policy: { matching?: { nameSimilarityThreshold?: number }; ownership?: { thresholdPercent?: number } };
      };
      const autonomy = (await api.get("/autonomy")) as Record<string, unknown>;
      return {
        version: p.version,
        hash: p.hash,
        name_similarity_threshold: p.policy.matching?.nameSimilarityThreshold,
        ownership_threshold_percent: p.policy.ownership?.thresholdPercent,
        autonomy,
        locked: [
          "an escalation or a request for information always goes to a person",
          "a recommended block needs two different approvers",
          "no automatic block, no message to a customer, no write to a source system",
        ],
      };
    },
  },
];

export const MCP_TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);

const PROTOCOL = "2024-11-05";

export function createMcpHandler(options: McpOptions) {
  const doFetch: Fetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const base = options.baseUrl.replace(/\/$/, "");
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const res = await doFetch(`${base}${path}`, {
      ...init,
      headers: { ...options.headers, ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(options.timeoutMs ?? 180_000),
    });
    if (!res.ok) {
      let message = `the desk answered HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        if (body.error?.message) message = body.error.message;
      } catch {
        // keep the status text
      }
      throw new McpError(-32000, message);
    }
    return res;
  };
  const api: Api = {
    get: async (path) => (await call(path)).json(),
    getText: async (path) => (await call(path)).text(),
    post: async (path, body) =>
      (
        await call(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).json(),
  };

  /** Handle one JSON-RPC message. Returns the reply, or undefined for a notification. */
  return async function handle(message: unknown): Promise<Record<string, unknown> | undefined> {
    const m = message as {
      jsonrpc?: string;
      id?: number | string | null;
      method?: string;
      params?: Record<string, unknown>;
    };
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: m.id ?? null, result });
    const fail = (code: number, text: string) => ({ jsonrpc: "2.0", id: m.id ?? null, error: { code, message: text } });
    if (typeof m !== "object" || m === null || m.jsonrpc !== "2.0" || typeof m.method !== "string")
      return fail(-32600, "not a JSON-RPC 2.0 request");
    if (m.id === undefined) return undefined; // a notification gets no answer
    switch (m.method) {
      case "initialize":
        return reply({
          protocolVersion: PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "sanctions-desk", version: "1.0.0" },
          instructions:
            "A sanctions-screening review desk. You can read the queue, ask for a recommendation, read a case and check a receipt. A person makes the final call; automatic closing is off by default, and no tool here can approve, override, block or change policy.",
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
      case "tools/call": {
        const tool = TOOLS.find((t) => t.name === m.params?.name);
        if (!tool) return fail(-32602, `unknown tool ${String(m.params?.name)}`);
        try {
          const out = await tool.run((m.params?.arguments ?? {}) as Record<string, unknown>, api);
          const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
          return reply({ content: [{ type: "text", text }] });
        } catch (err) {
          if (err instanceof McpError && err.code === -32602) return fail(err.code, err.message);
          const text = err instanceof Error ? err.message : String(err);
          return reply({ isError: true, content: [{ type: "text", text }] });
        }
      }
      default:
        return fail(-32601, `method ${m.method} is not supported`);
    }
  };
}
