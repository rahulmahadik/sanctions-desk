/**
 * Copy the sample list files and the synthetic bank sample into the Zetaris file store.
 *
 *   npm run zetaris:load-files
 */
import { join } from "node:path";
import { loadConfig, resolveProjectPath } from "@sanctions-desk/shared";
import { placeFiles } from "@sanctions-desk/zetaris";

const config = loadConfig();
const sample = resolveProjectPath("data/sample");
const lists = ["list_entry", "list_alias", "list_dob", "list_country", "list_identifier"];
const bank = ["customer", "customer_identifier", "alert"];
const { container, folder } = config.zetaris.fileStore;

const placed = await placeFiles({ container, folder }, [
  ...lists.map((t) => ({ localPath: join(sample, `${t}.json`), subfolder: "sanctions_lists" })),
  ...bank.map((t) => ({ localPath: join(sample, "bank", `${t}.json`), subfolder: "sanctions_bank_files" })),
]);
for (const p of placed) console.log(`${String(p.bytes).padStart(9)}  ${p.remotePath}`);
