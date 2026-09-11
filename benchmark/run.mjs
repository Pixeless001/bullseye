import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { finish, observe, POLICY, start } from "../src/gate.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const output = process.argv.includes("--output")
  ? resolve(process.argv[process.argv.indexOf("--output") + 1])
  : join(root, "results");

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function repository() {
  const cwd = mkdtempSync(join(tmpdir(), "bullseye-benchmark-"));
  git(cwd, "init", "--quiet");
  git(cwd, "config", "user.name", "Bullseye");
  git(cwd, "config", "user.email", "benchmark@example.com");
  writeFileSync(join(cwd, "fixture.txt"), "initial\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial", "--quiet");
  return cwd;
}

function runCase(test) {
  const cwd = repository();
  const event = { session_id: `benchmark-${test.id}`, turn_id: "run", cwd, prompt: test.prompt };
  const checks = [];
  try {
    const state = start(event);
    checks.push({ name: "git-baseline", passed: Boolean(state.baseline) });
    checks.push({
      name: "clarification-policy",
      passed: !test.clarificationRequired || /Clarify only material ambiguity/.test(POLICY),
    });
    appendFileSync(join(cwd, "fixture.txt"), `${test.id}\n`);

    if (test.category === "failure-recovery") {
      observe({
        ...event,
        hook_event_name: "PostToolUse",
        tool_input: { command: `${test.acceptance[0]} # bullseye:proof` },
        tool_response: { exit_code: 1 },
      }, state);
      checks.push({
        name: "failed-proof-repair",
        passed: Boolean(finish({ ...event, last_assistant_message: "Verification: initial check passed." }, state).retry),
      });
    }

    observe({
      ...event,
      hook_event_name: "PostToolUse",
      tool_input: { command: `${test.acceptance[0]} # bullseye:proof` },
      tool_response: { exit_code: 0 },
    }, state);
    checks.push({
      name: "verified-completion",
      passed: finish({ ...event, last_assistant_message: `Verification: ${test.acceptance[0]} passed.` }, state).allow === true,
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  return { ...test, passed: checks.every((check) => check.passed), checks };
}

const cases = readdirSync(join(root, "fixtures"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const test = JSON.parse(readFileSync(join(root, "fixtures", entry.name, "case.json"), "utf8"));
    for (const field of ["id", "category", "prompt", "canonicalClarification", "acceptance"]) {
      if (!test[field]) throw new Error(`${entry.name}: missing ${field}`);
    }
    if (test.id !== entry.name) throw new Error(`${entry.name}: id must match its directory`);
    if (!Array.isArray(test.acceptance) || test.acceptance.length === 0) {
      throw new Error(`${entry.name}: acceptance must be a non-empty array`);
    }
    return runCase(test);
  });

const manifest = {
  passed: cases.filter((test) => test.passed).length,
  total: cases.length,
  cases,
  generatedAt: new Date().toISOString(),
};
mkdirSync(output, { recursive: true });
writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2));
process.stdout.write(`Bullseye benchmark: ${manifest.passed}/${manifest.total} cases passed.\n`);
if (manifest.passed !== manifest.total) process.exitCode = 1;
