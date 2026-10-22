/**
 * Compare two normalised snapshots and print what was added, removed (delisted) and changed.
 *
 *   npm run data:diff -- <older snapshot folder> <newer snapshot folder> [--out delta.json]
 */
import { writeFileSync } from "node:fs";
import { affectedEntryIds, diffSnapshots, readSnapshot } from "@sanctions-desk/data";

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const out = outAt >= 0 ? args[outAt + 1] : undefined;
const [fromDir, toDir] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
if (!fromDir || !toDir) {
  console.error("usage: npm run data:diff -- <older snapshot folder> <newer snapshot folder> [--out delta.json]");
  process.exit(2);
}

const delta = diffSnapshots(readSnapshot(fromDir), readSnapshot(toDir));
console.log(
  `${delta.from_snapshot_id}\n  -> ${delta.to_snapshot_id}${delta.synthetic ? `   [synthetic: ${delta.synthetic.label}]` : ""}`,
);
console.log(
  `added ${delta.summary.added}, removed ${delta.summary.removed}, changed ${delta.summary.changed}, unchanged ${delta.summary.unchanged}`,
);
console.log(`entries that could change a screening result: ${affectedEntryIds(delta).length}`);
for (const e of delta.removed.slice(0, 5)) console.log(`  removed  ${e.entry_id}  ${e.primary_name}`);
for (const e of delta.added.slice(0, 5)) console.log(`  added    ${e.entry_id}  ${e.primary_name}`);
for (const e of delta.changed.slice(0, 5))
  console.log(`  changed  ${e.entry_id}  ${e.primary_name}  (${e.changes.map((c) => c.field).join(", ")})`);
if (out) {
  writeFileSync(out, `${JSON.stringify(delta, null, 2)}\n`);
  console.log(`wrote ${out}`);
}
