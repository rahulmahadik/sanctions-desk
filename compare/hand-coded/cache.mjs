// Caching of the REST source, so repeated reads do not call the service again.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

export async function cached(dir, key, ttlMs, load) {
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/${key}.json`;
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < ttlMs) {
    return { rows: JSON.parse(readFileSync(file, "utf8")), cache: "hit" };
  }
  const rows = await load();
  writeFileSync(file, JSON.stringify(rows));
  return { rows, cache: "miss" };
}
