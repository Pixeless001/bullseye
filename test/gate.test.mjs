import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { begin, finish, observe, POLICY, response, start, validate } from "../src/gate.mjs";
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

test("rejects stale failed proof used as blocker evidence", () => {
  const cwd = repository();
  try {
    const input = event(cwd);
    begin(input);
    appendFileSync(join(cwd, "example.txt"), "first\n");
    observe({ ...input, hook_event_name: "PostToolUse", tool_input: { command: "node --test # bullseye:proof" }, result: { exit_code: 1 } });
    appendFileSync(join(cwd, "example.txt"), "second\n");
    assert.match(
      finish({ ...input, last_assistant_message: "Blocked: tests fail\nEvidence: node --test failed" }).retry,
      /current failed marked proof/,
    );
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
    observe({ ...input, hook_event_name: "PostToolUse", tool_input: { command: "node --test # bullseye:proof" }, result: { exit_code: 1 } });
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
    const context = { session: { sessionId: "cline-test" }, runId: "run", workspaceInfo: { rootPath: cwd } };
    plugin.setup({ registerRule() {}, registerTool(tool) { completion = tool; } }, context);
    plugin.hooks.beforeRun(context);
    appendFileSync(join(cwd, "example.txt"), "change\n");
    plugin.hooks.afterTool({
      toolCall: { toolName: "run_commands", sessionId: "cline-test" },
      input: { commands: ["node --test # bullseye:proof"] },
      result: { exit_code: 0 },
    });
    assert.deepEqual(
      await completion.execute({ status: "verified", summary: "changed greeting", evidence: "node --test passed" }),
      { status: "verified", summary: "changed greeting" },
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Cline completion permits only one evidence-driven repair", async () => {
  const cwd = repository();
  try {
    let completion;
    const context = { session: { sessionId: "cline-repair" }, runId: "run", workspaceInfo: { rootPath: cwd }, prompt: "Fix it." };
    plugin.setup({ registerRule() {}, registerTool(tool) { completion = tool; } }, context);
    plugin.hooks.beforeRun(context);
    appendFileSync(join(cwd, "example.txt"), "change\n");
    const request = { status: "verified", summary: "changed", evidence: "tests passed" };
    await assert.rejects(completion.execute(request), /proof command/);
    assert.deepEqual(await completion.execute(request), {
      status: "blocked",
      summary: "Bullseye blocked completion",
      evidence: "Bullseye blocked completion: Run the relevant proof command and end it with # bullseye:proof.",
    });
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
    assert.equal(manifest.passed, 4);
    assert.ok(manifest.cases.every((item) => item.acceptance.includes("node --test")));
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("Cursor native hooks preserve policy, proof, final text, and stop response shapes", () => {
  const cwd = repository();
  try {
    const input = {
      conversation_id: "cursor-test",
      generation_id: "generation",
      workspace_roots: [cwd],
      prompt: "Update the fixture.",
    };
    assert.deepEqual(response({ ...input, hook_event_name: "sessionStart" }), { additional_context: POLICY });
    assert.deepEqual(response({ ...input, hook_event_name: "beforeSubmitPrompt" }), { continue: true });
    appendFileSync(join(cwd, "example.txt"), "change\n");
    response({
      ...input,
      hook_event_name: "postToolUse",
      cwd,
      tool_input: { command: "node --test # bullseye:proof" },
      tool_output: JSON.stringify({ exitCode: 0, stdout: "passed" }),
    });
    response({ ...input, hook_event_name: "afterAgentResponse", text: "Verification: node --test passed." });
    assert.deepEqual(response({ ...input, hook_event_name: "stop", status: "completed", loop_count: 0 }), {});
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Cursor preserves the original baseline across its one automatic repair", () => {
  const cwd = repository();
  try {
    const input = {
      conversation_id: "cursor-repair",
      generation_id: "first",
      workspace_roots: [cwd],
      prompt: "Update the fixture.",
    };
    response({ ...input, hook_event_name: "beforeSubmitPrompt" });
    appendFileSync(join(cwd, "example.txt"), "change\n");
    response({ ...input, hook_event_name: "afterAgentResponse", text: "done" });
    const retry = response({ ...input, hook_event_name: "stop", status: "completed", loop_count: 0 });
    assert.match(retry.followup_message, /marked proof/);

    const repair = { ...input, generation_id: "second", prompt: retry.followup_message };
    response({ ...repair, hook_event_name: "beforeSubmitPrompt" });
    response({ ...repair, hook_event_name: "afterAgentResponse", text: "still done" });
    assert.deepEqual(response({ ...repair, hook_event_name: "stop", status: "completed", loop_count: 1 }), {});
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Claude successful PostToolUse is accepted without an undocumented exit code", () => {
  const cwd = repository();
  try {
    const input = { session_id: "claude-test", cwd, prompt: "Fix the fixture." };
    start(input);
    appendFileSync(join(cwd, "example.txt"), "change\n");
    observe({
      ...input,
      hook_event_name: "PostToolUse",
      tool_input: { command: "node --test # bullseye:proof" },
      tool_response: { stdout: "passed", stderr: "", interrupted: false },
    });
    assert.deepEqual(finish({ ...input, last_assistant_message: "Verification: node --test passed." }), { allow: true });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("rejects no-op proof commands", () => {
  const cwd = repository();
  try {
    const input = event(cwd);
    begin(input);
    appendFileSync(join(cwd, "example.txt"), "change\n");
    observe({ ...input, tool_input: { command: "true # bullseye:proof" }, result: { exit_code: 0 } });
    assert.match(finish({ ...input, last_assistant_message: "Verification: true passed." }).retry, /proof command/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a modifying prompt requires proof even when the worktree is unchanged", () => {
  const cwd = repository();
  try {
    const input = { ...event(cwd), prompt: "Fix the already-correct behavior." };
    start(input);
    assert.match(finish({ ...input, last_assistant_message: "Verification: inspected." }).retry, /proof command/);
    observe({ ...input, tool_input: { command: "node --test # bullseye:proof" }, result: { exit_code: 0 } });
    assert.deepEqual(finish({ ...input, last_assistant_message: "Verification: node --test passed." }), { allow: true });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Git baseline failure requires an evidence-backed blocker", () => {
  const cwd = mkdtempSync(join(tmpdir(), "bullseye-no-git-"));
  try {
    const input = { session_id: "no-git", turn_id: "run", cwd };
    start(input);
    assert.match(finish({ ...input, last_assistant_message: "done" }).retry, /baseline unavailable/);
    assert.deepEqual(
      finish({ ...input, last_assistant_message: "Blocked: no Git repository\nEvidence: git rev-parse failed" }),
      { allow: true },
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("validator accepts CRLF skill frontmatter and enforces semantic contracts", () => {
  const cwd = mkdtempSync(join(tmpdir(), "bullseye-package-"));
  try {
    cpSync(process.cwd(), cwd, { recursive: true, filter: (source) => !source.includes(`${join(process.cwd(), ".git")}`) });
    const skill = join(cwd, "skills/bullseye/SKILL.md");
    writeFileSync(skill, readFileSync(skill, "utf8").replaceAll("\n", "\r\n"));
    assert.deepEqual(validate(cwd), []);
    const pkgPath = join(cwd, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    delete pkg.engines;
    writeFileSync(pkgPath, JSON.stringify(pkg));
    assert.ok(validate(cwd).includes("package.json: Node 20+ must be enforced"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
