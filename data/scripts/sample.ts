/**
 * Build the small committed sample from the newest normalised snapshots.
 *
 *   npm run data:sample
 */
import {
  buildListSample,
  latestSnapshotDir,
  loadDataSources,
  readSnapshot,
  writeListSample,
} from "@sanctions-desk/data";

const config = loadDataSources();
const snapshots = config.sources.map((source) => {
  const dir = latestSnapshotDir(config, source.id);
  if (!dir) throw new Error(`no normalised snapshot for ${source.id}; run npm run data:normalise first`);
  return readSnapshot(dir);
});
// Both OFAC files are separate sources, but the sample keeps one entry set per list id.
const sample = buildListSample(snapshots, config.sample);
const dir = writeListSample(config.sample, sample);
console.log(`sample written to ${dir}`);
console.log(JSON.stringify(sample.manifest.counts));
console.log(JSON.stringify(sample.manifest.selected_by_rule));
