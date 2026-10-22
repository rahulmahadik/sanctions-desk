/**
 * Build a small extract of GLEIF LEI records and parent relationships (CC0 1.0) into
 * data/reference/gleif/. The limits and countries come from config/data-sources.json.
 *
 *   npm run data:gleif
 */
import { fetchGleifExtract, loadDataSources, writeGleifExtract } from "@sanctions-desk/data";

const config = loadDataSources();
const extract = await fetchGleifExtract(config);
const dir = writeGleifExtract(config, extract);
const parents = new Set(extract.relationships.map((r) => r.parent_lei));
console.log(`GLEIF golden copy ${extract.publishDate}`);
console.log(
  `${extract.lei.length} LEI records, ${extract.relationships.length} parent links, ${parents.size} distinct parents`,
);
console.log(`written to ${dir}`);
