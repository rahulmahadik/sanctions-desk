/**
 * What must not appear in anything published from a run: tokens, local paths, hostnames and addresses other than
 * the local machine, usernames and e-mail addresses. Shared by the evidence export (which redacts and then refuses
 * to write if anything still matches) and by the public-repository scan (which looks inside the exported files).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";

const PATH_TAIL = "[^\\s\"'\\\\,)\\]}]*";

/** Account names too common to be a person's, which CI runners and containers use. */
const SERVICE_ACCOUNTS = new Set([
  "runner",
  "root",
  "node",
  "admin",
  "administrator",
  "ubuntu",
  "user",
  "users",
  "docker",
]);
const escapeRegExp = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const quietly = (fn) => {
  try {
    return fn();
  } catch {
    return "";
  }
};

/**
 * The names that identify the person running this, worked out on their own machine rather than written here: the
 * account name, the git user name, the part of the git e-mail address before the "@" (unless it is a no-reply
 * address), and the owner of the repository in package.json.
 */
export function personalNames() {
  const email = quietly(() => execFileSync("git", ["config", "user.email"], { encoding: "utf8" }).trim());
  const repository = quietly(() => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return /github\.com\/([^/]+)\//.exec(pkg.repository?.url ?? "")?.[1] ?? "";
  });
  const names = [
    quietly(() => userInfo().username),
    quietly(() => execFileSync("git", ["config", "user.name"], { encoding: "utf8" }).trim()),
    /noreply/i.test(email) ? "" : email.split("@")[0],
    repository,
  ];
  return [...new Set(names.map((n) => n.toLowerCase()))].filter(
    (n) => n.length >= 5 && /^[\w.-]+$/.test(n) && !SERVICE_ACCOUNTS.has(n),
  );
}

const names = personalNames();
/** Matches any of those names as a whole word; matches nothing when none is known. */
export const USERNAME = names.length > 0 ? new RegExp(`\\b(?:${names.map(escapeRegExp).join("|")})\\b`, "gi") : /(?!)/g;

export const REDACTIONS = [
  { name: "bearer token", re: /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/g, with: "Bearer [redacted]" },
  { name: "authorization value", re: /("?[Aa]uthorization"?\s*[:=]\s*"?)[^",\s}]{8,}/g, with: "$1[redacted]" },
  {
    name: "local path",
    re: new RegExp(
      `(?:/Users/|/private/(?:tmp|var)/|/var/folders/|/home/(?!zetaris/)|[A-Za-z]:\\\\Users\\\\)${PATH_TAIL}`,
      "g",
    ),
    with: "[local path]",
  },
  { name: "address", re: /\b(?!127\.0\.0\.1\b|0\.0\.0\.0\b)(?:\d{1,3}\.){3}\d{1,3}\b/g, with: "[address]" },
  { name: "hostname", re: /\b[a-z0-9-]+\.(?:local|lan|home|internal|corp)\b/gi, with: "[host]" },
  {
    name: "e-mail address",
    re: /\b[\w.+-]+@(?!example\.(?:com|org|test)\b|users\.noreply\.github\.com\b|sanctions-desk\.local\b)[\w-]+(?:\.[\w-]+)+\b/g,
    with: "[email]",
  },
  { name: "username", re: USERNAME, with: "[user]" },
];

/** Names of the patterns that still match a piece of text. */
export function matches(text) {
  return REDACTIONS.filter((r) => {
    r.re.lastIndex = 0;
    return r.re.test(text);
  }).map((r) => r.name);
}
