/**
 * Write the Postgres schema and load scripts for the synthetic bank from the row definitions.
 *
 *   npm run bankdb:schema
 */
import { writeFileSync } from "node:fs";
import { renderBankdbLoad, renderBankdbSchema } from "@sanctions-desk/data";
import { resolveProjectPath } from "@sanctions-desk/shared";

writeFileSync(resolveProjectPath("docker/bankdb/init/01_schema.sql"), renderBankdbSchema());
writeFileSync(resolveProjectPath("docker/bankdb/init/02_load.sql"), renderBankdbLoad());
console.log("wrote docker/bankdb/init/01_schema.sql and 02_load.sql");
