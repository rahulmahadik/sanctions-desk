/**
 * Check that the three runtime identities can really read the model, and fail loudly when they cannot.
 *
 *   npm run check:roles
 *
 * Access Control on a Unified Semantic Layer is set in the Zetaris interface; there is no SQL or REST call to
 * read or write it, and rebuilding the model empties it. This asks the platform itself: each identity's token
 * runs one read on the model, and the answer says whether the access is in place.
 */
import { existsSync } from "node:fs";
import { loadConfig, resolveProjectPath } from "@sanctions-desk/shared";
import { checkRoleAccess, describeAccessFailure } from "@sanctions-desk/zetaris";

const envFile = resolveProjectPath(".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const results = await checkRoleAccess(loadConfig());
for (const r of results)
  console.log(
    `${r.role}: ${r.state === "ok" ? "can read the model" : `${r.state}${r.detail ? ` (${r.detail})` : ""}`}`,
  );
if (results.some((r) => r.state !== "ok")) {
  console.error(`\nROLE ACCESS CHECK FAILED\n${describeAccessFailure(results)}`);
  process.exit(1);
}
console.log("role access check passed");
