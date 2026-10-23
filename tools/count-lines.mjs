// Count lines of code (no blanks, no comment-only lines) per file, for the hand-coded comparison.
import { readFileSync } from "node:fs";

for (const file of process.argv.slice(2)) {
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "" && !l.trim().startsWith("//") && !l.trim().startsWith("--"));
  console.log(String(lines.length).padStart(5), file);
}
