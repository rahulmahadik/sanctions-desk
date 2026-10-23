// Definitions: the approved wording and the table and column descriptions, available to every agent.
import { readFileSync } from "node:fs";

export function createDefinitions(definitionRows, descriptionsFile) {
  const descriptions = JSON.parse(readFileSync(descriptionsFile, "utf8"));
  return {
    definition: (id, version) =>
      definitionRows.find((d) => d.definition_id === id && (version === undefined || d.version === String(version))),
    describe: (table, column) =>
      column ? descriptions[table]?.columns?.[column]?.description : descriptions[table]?.description,
    tables: () => Object.keys(descriptions),
  };
}
