import { PERMISSIONS, type Permission, ROLES } from "@sanctions-desk/shared";

/**
 * The "Authentication and access" section, written once: the OpenAPI description (and so the published API page)
 * includes it, and `npm run openapi:export` copies it into docs/API.md. The roles table is built from the same
 * permission map the API enforces.
 */

const WHAT: Record<Permission, string> = {
  run: "start a review, replay a list change, check a draft for a customer, compare a policy draft",
  decide: "approve or override a recommendation, give a second approval, reopen an automatic close",
  approveBlock: "give the second approval of a block or of an override to a close",
  overrideTowardsLessCaution: "override towards a less cautious outcome (it then waits for a second approver)",
  proposePolicy: "propose, reload or roll back a policy draft",
  publishPolicy: "publish a policy draft",
  stopAutonomy: "stop automatic closing",
  restoreAutonomy: "switch automatic closing back on",
};

function rolesTable(): string {
  const rows = ROLES.map((role) => {
    const can = (Object.keys(PERMISSIONS) as Permission[])
      .filter((p) => (PERMISSIONS[p] as readonly string[]).includes(role))
      .map((p) => WHAT[p]);
    return `| \`${role}\` | read everything${can.length ? `; ${can.join("; ")}` : " (read only)"} |`;
  });
  return ["| Role | What it may do |", "| --- | --- |", ...rows].join("\n");
}

export const AUTH_GUIDE = `## Authentication and access

**Get a token.** An administrator adds each person to the users file, which is kept outside the repository and named by \`DESK_USERS_FILE\`:

\`\`\`bash
npm run users:add -- --file ~/.sanctions-desk/users.json --id olga --role approver --by admin --expires 90d
\`\`\`

The token (\`sd_\` and 32 characters, 192 random bits) is printed once; the file keeps only its SHA-256. \`npm run users:rotate\` issues a new token and the old one stops working; \`npm run users:revoke\` stops a token at once; \`--expires\` (for example \`90d\` or an ISO time) makes a token stop working at that time. A running server reads the file again when it changes, so these take effect on the next request. Every change is logged in \`users-audit.jsonl\` beside the file (who, when, what; never a token). A token in any other form is refused, and with sign-in on the server will not start while the file holds a token that \`users:add\` did not make.

**When sign-in is on.** The setting is the environment variable \`AUTH_MODE\` (\`server.auth\` in the configuration files), and it defaults to \`auto\`. \`auto\` means sign-in is on in live mode and demo users in sample mode. \`on\` works in both modes. \`demo\` and \`off\` are refused in live mode, and in live mode without a users file (\`DESK_USERS_FILE\`) the server refuses to start, so the API never runs live with sign-in off.

**Runs without the API.** Two things do not go through the API's sign-in, because they open no port and whoever runs them already controls the process: \`npm run case\` (one review, in-process) and the evaluation tools (\`npm run exam\` and the study and guard tools), which call the review pipeline directly.

**Send it.** \`Authorization: Bearer <token>\` on every request. Every route except \`/health\` needs it when sign-in is on (the default outside sample mode). No token, or an unknown, malformed, expired or revoked one: \`401\`. A role that may not do this: \`403\`.

\`\`\`bash
export DESK_TOKEN=...   # your token, from users:add; never put it in a file in the repository
curl -s https://desk.example.com/run -H "Authorization: Bearer $DESK_TOKEN" -H 'content-type: application/json' -d '{"alert_id": "ALR-0004"}'
\`\`\`

**Roles.**

${rolesTable()}

**Four-eyes.** A block (an approved block recommendation, or an override to a block), and an override to a close from any other recommendation, wait for a second, different approver. In sample mode \`approver_demo\` and \`approver2_demo\` can be the two approvers. A policy draft must be published by a different person from the one who proposed it.

**Rate limits.** Per caller (the signed-in user; without sign-in, the address), in a fixed window: by default 60 changes a minute, 10 reviews a minute, and 4 reviews running at once across all callers; above a limit the answer is \`429\` with \`Retry-After\`, and nothing is queued. Reads and \`/health\` are not limited. The counts are kept in the memory of one server process: they reset when it restarts and are not shared between processes. Set them in \`config\` (\`server.rateLimit\`) or with \`RATE_LIMIT_WRITES\`, \`RATE_LIMIT_REVIEWS\`, \`RATE_LIMIT_REVIEWS_IN_FLIGHT\` and \`RATE_LIMIT_WINDOW_MS\`. For limits shared across several processes or machines, put a gateway or proxy with its own limits in front (for example nginx \`limit_req\` or an API gateway).

**TLS.** With \`DESK_TLS_CERT_FILE\` and \`DESK_TLS_KEY_FILE\` set, the server serves HTTPS only. Without them it serves plain HTTP and should stay on \`127.0.0.1\`, as by default; it logs a warning at start-up if it is bound to any other address without TLS. For a deployment, terminate TLS in a proxy in front, for example Caddy:

\`\`\`
desk.example.com {
  reverse_proxy 127.0.0.1:8000
}
\`\`\`

**Sample mode.** With \`SAMPLE_MODE=true\` and sign-in not on, the built-in demo users (\`analyst_demo\`, \`approver_demo\`, \`approver2_demo\`, \`admin_demo\`) can be chosen with the \`X-Demo-User\` header, and reading and running a review need no token. The demo users are ignored when sign-in is on and never work in live mode.`;
