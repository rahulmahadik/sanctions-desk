import { readFileSync } from "node:fs";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { z } from "zod";

/**
 * Business definitions: the approved wording of terms the desk applies ("true match", "strong identifier",
 * "effective ownership threshold"). They live as data in the semantic layer, with a version, and every
 * decision cites the definitions it applied by id and version.
 */

export const BusinessDefinitionSchema = z.strictObject({
  definition_key: z.string().regex(/^[a-z_]+@\d+$/),
  definition_id: z.string().regex(/^[a-z_]+$/),
  version: z.string().regex(/^\d+$/),
  name: z.string().min(1),
  statement: z.string().min(20),
  status: z.enum(["draft", "approved", "retired"]),
  owner: z.string().min(1),
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type BusinessDefinition = z.infer<typeof BusinessDefinitionSchema>;

/** The versions the matching code implements. A newer approved version in the data means the code must be reviewed first. */
export const IMPLEMENTED_DEFINITIONS: Readonly<Record<string, string>> = {
  true_match: "1",
  false_positive: "1",
  strong_identifier: "1",
  effective_ownership_threshold: "1",
};

export function loadBusinessDefinitions(path = "data/sample/business_definition.json"): BusinessDefinition[] {
  return BusinessDefinitionSchema.array().parse(JSON.parse(readFileSync(resolveProjectPath(path), "utf8")));
}

export interface DefinitionCheck {
  /** Definitions in use, newest approved version of each. */
  applied: Array<{ definition_id: string; version: string }>;
  /** Definitions whose newest approved version differs from the one the code implements. */
  mismatched: Array<{ definition_id: string; approved: string; implemented: string | undefined }>;
}

/** Pick the newest approved version of each definition and compare it with what the code implements. */
export function checkDefinitions(
  rows: ReadonlyArray<Pick<BusinessDefinition, "definition_id" | "version" | "status">>,
): DefinitionCheck {
  const newest = new Map<string, string>();
  for (const r of rows) {
    if (r.status !== "approved") continue;
    const current = newest.get(r.definition_id);
    if (current === undefined || Number(r.version) > Number(current)) newest.set(r.definition_id, r.version);
  }
  const applied = [...newest]
    .map(([definition_id, version]) => ({ definition_id, version }))
    .sort((a, b) => a.definition_id.localeCompare(b.definition_id));
  const mismatched = applied
    .filter((d) => IMPLEMENTED_DEFINITIONS[d.definition_id] !== d.version)
    .map((d) => ({
      definition_id: d.definition_id,
      approved: d.version,
      implemented: IMPLEMENTED_DEFINITIONS[d.definition_id],
    }));
  for (const [id, version] of Object.entries(IMPLEMENTED_DEFINITIONS)) {
    if (!newest.has(id)) mismatched.push({ definition_id: id, approved: "none", implemented: version });
  }
  return { applied, mismatched };
}
