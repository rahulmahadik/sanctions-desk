/**
 * What must not appear in anything published from a run: tokens, local paths, hostnames and addresses other than
 * the local machine, usernames and e-mail addresses. Shared by the evidence export (which redacts and then refuses
 * to write if anything still matches) and by the public-repository scan (which looks inside the exported files).
 */

const PATH_TAIL = "[^\\s\"'\\\\,)\\]}]*";

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
  { name: "username", re: /\brahulmahadik\b|\brahultkiet\b/gi, with: "[user]" },
];

/** Names of the patterns that still match a piece of text. */
export function matches(text) {
  return REDACTIONS.filter((r) => {
    r.re.lastIndex = 0;
    return r.re.test(text);
  }).map((r) => r.name);
}
