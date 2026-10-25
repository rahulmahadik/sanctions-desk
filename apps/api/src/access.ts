import type { Permission } from "@sanctions-desk/shared";

/**
 * What a route needs. Reading needs only a signed-in user; these are the exceptions. `path` is the pattern of the
 * route that matched (for example `/policy/drafts/:version/publish`), never the text the caller sent: the router
 * decodes percent escapes, so `/policy/drafts/%32/publish` reaches the same handler as `/policy/drafts/2/publish`.
 */
export function permissionFor(method: string, path: string): Permission | undefined {
  if (method === "GET" || method === "HEAD") return undefined;
  if (path === "/run" || path === "/list-change/replay" || path === "/guard/outbound" || path === "/policy/whatif")
    return "run";
  if (/^\/cases\/[^/]+\/(decision|second-approval|reopen)$/.test(path)) return "decide";
  if (path === "/autonomy/kill-switch") return "stopAutonomy";
  if (/^\/policy\/drafts\/[^/]+\/publish$/.test(path)) return "publishPolicy";
  if (path.startsWith("/policy/")) return "proposePolicy";
  return undefined;
}
