import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { begin, finish, observe, validate } from "../src/gate.mjs";
import plugin from "../adapters/cline.mjs";

function command(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function repository() {
  const cwd = mkdtempSync(join(tmpdir(), "bullseye-test-"));
  command(cwd, "init", "--quiet");
  command(cwd, "config", "user.name", "Test");
  command(cwd, "config", "user.email", "test@example.com");
  writeFileSync(join(cwd, "example.txt"), "initial\n");
  command(cwd, "add", ".");
  command(cwd, "commit", "-m", "initial", "--quiet");
  return cwd;
}

function event(cwd, turn = "one") {
  return { session_id: "test", turn_id: turn, cwd };
}

test("accepts a current successful proof", () => {
  const cwd = repository();
  try {
    const input = event(cwd);
    begin(input);
    appendFileSync(join(cwd, "example.txt"), "change\n");
    observe({ ...input, tool_input: { command: "node --test # bullseye:proof" }, result: { exit_code: 0 } });
    assert.deepEqual(finish({ ...input, last_assistant_message: "Verification: node --test passed." }), { allow: true });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("requires proof after a modifying run", () => {
  const cwd = repository();
  try {
    const input = event(cwd);
    begin(input);
    appendFileSync(join(cwd, "example.txt"), "change\n");
    assert.match(finish({ ...input, last_assistant_message: "Verification: node --test passed." }).retry, /proof command/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("rejects proof made stale by later edits", () => {
  const cwd = repository();
  try {
    const input = event(cwd);
    begin(input);
    appendFileSync(join(cwd, "example.txt"), "first\n");
    observe({ ...input, tool_input: { command: "node --test # bullseye:proof" }, result: { exit_code: 0 } });
    appendFileSync(join(cwd, "example.txt"), "second\n");
    assert.match(finish({ ...input, last_assistant_message: "Verification: node --test passed." }).retry, /changed after proof/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("allows evidence-backed blockers", () => {
  const cwd = repository();
  try {
    const input = event(cwd);
    begin(input);
    appendFileSync(join(cwd, "example.txt"), "partial\n");
    assert.deepEqual(
      finish({ ...input, last_assistant_message: "Blocked: database unavailable\nEvidence: connection refused" }),
      { allow: true },
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("stops after one repair request", () => {
  const cwd = repository();
  try {
    const input = event(cwd);
    begin(input);
    appendFileSync(join(cwd, "example.txt"), "change\n");
    const result = finish({ ...input, stop_hook_active: true, last_assistant_message: "done" });
    assert.match(result.stop, /Bullseye blocked completion/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("package manifests validate", () => {
  assert.deepEqual(validate(process.cwd()), []);
});

test("hook entrypoint emits a JSON retry decision", () => {
  const cwd = repository();
  try {
    const input = event(cwd);
    execFileSync("node", ["./bin/bullseye.mjs", "hook"], {
      cwd: process.cwd(),
      input: JSON.stringify({ ...input, hook_event_name: "UserPromptSubmit" }),
    });
    appendFileSync(join(cwd, "example.txt"), "change\n");
    const output = execFileSync("node", ["./bin/bullseye.mjs", "hook"], {
      cwd: process.cwd(),
      input: JSON.stringify({ ...input, hook_event_name: "Stop", last_assistant_message: "done" }),
      encoding: "utf8",
    });
    assert.equal(JSON.parse(output).decision, "block");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Cline completion tool accepts a marked, current proof", async () => {
  const cwd = repository();
  try {
    let completion;
    plugin.setup({ registerTool(tool) { completion = tool; } });
    const context = { sessionId: "cline-test", runId: "run", workspaceInfo: { rootPath: cwd } };
    plugin.hooks.beforeRun(context);
    appendFileSync(join(cwd, "example.txt"), "change\n");
    plugin.hooks.afterTool({
      input: { command: "node --test # bullseye:proof" },
      result: { exit_code: 0 },
    });
    assert.deepEqual(
      await completion.execute({ status: "verified", summary: "changed greeting", evidence: "node --test passed" }, context),
      { status: "verified", summary: "changed greeting" },
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("benchmark runner emits all fixture contracts", () => {
  const output = mkdtempSync(join(tmpdir(), "bullseye-benchmark-"));
  try {
    execFileSync("node", ["./benchmark/run.mjs", "--output", output], { cwd: process.cwd() });
    const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
    assert.equal(manifest.cases.length, 4);
    assert.ok(manifest.cases.every((item) => item.acceptance.includes("node --test")));
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
