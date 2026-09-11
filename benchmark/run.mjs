import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const output = process.argv.includes("--output")
  ? resolve(process.argv[process.argv.indexOf("--output") + 1])
  : join(root, "results");
const cases = readdirSync(join(root, "fixtures"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const file = join(root, "fixtures", entry.name, "case.json");
    const test = JSON.parse(readFileSync(file, "utf8"));
    for (const field of ["id", "category", "prompt", "acceptance"]) {
      if (!test[field]) throw new Error(`${entry.name}: missing ${field}`);
    }
    if (test.id !== entry.name) throw new Error(`${entry.name}: id must match its directory`);
    if (!Array.isArray(test.acceptance) || test.acceptance.length === 0) {
      throw new Error(`${entry.name}: acceptance must be a non-empty array`);
    }
    return test;
  });

mkdirSync(output, { recursive: true });
writeFileSync(join(output, "manifest.json"), JSON.stringify({
  cases: cases.map(({ id, category, acceptance, clarificationRequired }) => ({
    id, category, acceptance, clarificationRequired,
  })),
  generatedAt: new Date().toISOString(),
}, null, 2));
process.stdout.write(`Validated and prepared ${cases.length} benchmark fixtures in ${output}.\n`);
