/**
 * The review desk as a Model Context Protocol server over stdio, for an AI assistant that speaks MCP.
 *
 *   DESK_API_URL=http://localhost:8000 DESK_TOKEN=<token> npm run mcp
 *   DESK_API_URL=http://localhost:8000 DESK_DEMO_USER=analyst_demo npm run mcp      (sample mode)
 *
 * It exposes reading the queue, asking for a recommendation, reading a case and its case file, checking a receipt and
 * reading the policy. It has no tool that approves, overrides, reopens or changes policy: a person decides.
 */
import { createInterface } from "node:readline";
import { createMcpHandler } from "@sanctions-desk/shared";

const headers: Record<string, string> = {};
if (process.env.DESK_TOKEN) headers.authorization = `Bearer ${process.env.DESK_TOKEN}`;
else if (process.env.DESK_DEMO_USER) headers["x-demo-user"] = process.env.DESK_DEMO_USER;
const handle = createMcpHandler({ baseUrl: process.env.DESK_API_URL ?? "http://localhost:8000", headers });

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (line.trim() === "") return;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`,
    );
    return;
  }
  void handle(message).then((reply) => {
    if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
  });
});
