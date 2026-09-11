import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const POLICY = "Clarify only material ambiguity. Inspect before editing; reuse before inventing; make the smallest sufficient change. For modifying work, run one relevant proof marked # bullseye:proof, inspect the final diff, then report Verification or an evidence-backed Blocked result. Repair failed checks from evidence and stop once proven.";

const stateDir = join(tmpdir(), "bullseye");
const modifyingPrompt = /\b(add|build|change|complete|create|delete|edit|fix|implement|install|migrate|move|refactor|remove|rename|replace|update|upgrade|write)\b/i;

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return result.stdout;
}

function changedFiles(status) {
  const entries = status.split("\0").filter(Boolean);
  const files = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const code = entry.slice(0, 2);
    files.push(entry.slice(3));
    if (/[RC]/.test(code)) index += 1;
  }
  return files.sort();
}

function worktreeFingerprint(cwd, status) {
  const contents = changedFiles(status).map((file) => {
    try {
      return `${file}:${hash(readFileSync(join(cwd, file)))}`;
    } catch {
      return `${file}:missing`;
    }
  });
  return hash(`${status}\0${contents.join("\n")}`);
}

export function snapshot(cwd) {
  const repository = resolve(git(cwd, ["rev-parse", "--show-toplevel"]).trim());
  const status = git(repository, ["status", "--porcelain=v1", "-z"]);
  return {
    cwd: repository,
    fingerprint: worktreeFingerprint(repository, status),
    diffCheck: git(repository, ["diff", "--check", "HEAD"]),
  };
}

function capture(cwd) {
  try {
    return { value: snapshot(cwd), error: null };
  } catch (error) {
    return { value: null, error: error.message };
  }
}

function sessionId(input) {
  return input.session_id ?? input.sessionId ?? input.conversation_id ?? "unknown";
}

function turnId(input) {
  if (input.conversation_id) return "cursor";
  return input.turn_id ?? input.turnId ?? input.generation_id ?? input.generationId ?? "current";
}

function workspace(input) {
  return input.cwd ?? input.workspace_roots?.[0] ?? process.env.CURSOR_PROJECT_DIR ?? process.cwd();
}

function statePath(input) {
  return join(stateDir, `${hash(JSON.stringify([sessionId(input), turnId(input)]))}.json`);
}

function load(input) {
  try {
    return JSON.parse(readFileSync(statePath(input), "utf8"));
  } catch {
    return null;
  }
}

function save(input, state) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath(input), JSON.stringify(state), "utf8");
}

function clear(input) {
  rmSync(statePath(input), { force: true });
}

function clearSession(input) {
  if (!existsSync(stateDir)) return;
  for (const file of readdirSync(stateDir)) {
    try {
      const path = join(stateDir, file);
      if (JSON.parse(readFileSync(path, "utf8")).session === sessionId(input)) rmSync(path, { force: true });
    } catch {
      // Ignore unrelated or concurrently removed temp files.
    }
  }
}

function eventName(input) {
  return input.hook_event_name ?? input.hookEventName ?? input.event;
}

function asCommands(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string").join("\n");
  return typeof value === "string" ? value : "";
}

function commandFrom(input) {
  const sources = [input.tool_input, input.toolInput, input.tool_call?.input, input.input, input];
  for (const source of sources) {
    const command = asCommands(source?.command) || asCommands(source?.commands);
    if (command) return command;
  }
  return "";
}

function resultFrom(input) {
  const result = input.tool_response ?? input.toolResponse ?? input.result ?? input.tool_output ?? {};
  if (typeof result !== "string") return result;
  try {
    return JSON.parse(result);
  } catch {
    return { output: result };
  }
}

function succeeded(input) {
  const name = eventName(input);
  if (name === "postToolUseFailure" || name === "PostToolUseFailure") return false;
  const result = resultFrom(input);
  if (typeof result.exit_code === "number") return result.exit_code === 0;
  if (typeof result.exitCode === "number") return result.exitCode === 0;
  if (typeof result.code === "number") return result.code === 0;
  if (typeof result.isError === "boolean") return !result.isError;
  if (typeof result.success === "boolean") return result.success;
  if (typeof result.ok === "boolean") return result.ok;
  if (typeof result.status === "string") return /^(completed|success|succeeded)$/i.test(result.status);
  if (name === "postToolUse") return true;
  if (name === "PostToolUse" && !input.turn_id) return true;
  return false;
}

function proofCommand(command) {
  const marker = command.indexOf("# bullseye:proof");
  if (marker < 0) return false;
  const executable = command.slice(0, marker).trim().split(/[;&|\r\n]+/).at(-1)?.trim() ?? "";
  return executable !== "" && !/^(?:true|:|echo(?:\s+.*)?|printf(?:\s+.*)?|write-output(?:\s+.*)?|exit\s+0)$/i.test(executable);
}

function finalMessage(input, state) {
  return input.last_assistant_message ?? input.lastAssistantMessage ?? input.message ?? input.text ?? state?.finalMessage ?? "";
}

function blocker(message) {
  return /(?:^|\n)Blocked:\s*\S/i.test(message) && /(?:^|\n)Evidence:\s*\S/i.test(message);
}

function verification(message) {
  return /(?:^|\n)Verification:\s*\S/i.test(message);
}

export function start(input) {
  const cwd = workspace(input);
  const baseline = capture(cwd);
  const state = {
    session: sessionId(input),
    turn: turnId(input),
    cwd,
    baseline: baseline.value,
    baselineError: baseline.error,
    harness: input.conversation_id ? "cursor" : input.turn_id ? "codex" : "claude",
    requiresProof: modifyingPrompt.test(input.prompt ?? ""),
    receipt: null,
    finalMessage: "",
  };
  save(input, state);
  return state;
}

export function begin(input) {
  return start(input).baseline;
}

export function observe(input, state = load(input)) {
  const command = commandFrom(input);
  if (!state || !proofCommand(command)) return state;
  const current = capture(input.cwd ?? state.cwd);
  state.receipt = {
    command,
    success: succeeded(input),
    fingerprint: current.value?.fingerprint ?? null,
    snapshotError: current.error,
  };
  save(input, state);
  return state;
}

export function rememberFinal(input, state = load(input)) {
  if (!state) return state;
  state.finalMessage = finalMessage(input, state);
  save(input, state);
  return state;
}

export function finish(input, state = load(input)) {
  if (!state) return { retry: "Bullseye state is unavailable; rerun from the user request." };
  const message = finalMessage(input, state);
  if (!state.baseline) {
    if (blocker(message)) {
      clear(input);
      return { allow: true };
    }
    return { retry: `Git baseline unavailable: ${state.baselineError}. Report Blocked with Evidence.` };
  }

  const current = capture(input.cwd ?? state.cwd);
  if (!current.value) {
    if (blocker(message)) {
      clear(input);
      return { allow: true };
    }
    return { retry: `Git verification unavailable: ${current.error}. Report Blocked with Evidence.` };
  }

  const changed = current.value.fingerprint !== state.baseline.fingerprint;
  if (!changed && !state.requiresProof) {
    clear(input);
    return { allow: true };
  }

  const proof = state.receipt;
  const problem = current.value.diffCheck !== state.baseline.diffCheck && current.value.diffCheck
    ? "git diff --check reports new whitespace errors."
    : blocker(message)
      ? proof?.success === false && (state.harness === "claude" || proof.fingerprint === current.value.fingerprint)
        ? null
        : state.harness === "claude" && !proof
          ? null
          : "Blocked completion requires current failed marked proof Evidence."
      : !verification(message)
        ? "Report Verification with the marked proof command, or Blocked with Evidence."
        : !proof?.success
          ? "Run the relevant proof command and end it with # bullseye:proof."
          : proof.fingerprint !== current.value.fingerprint
            ? "Files changed after proof; rerun the marked verification command."
            : null;

  if (!problem) {
    clear(input);
    return { allow: true };
  }
  if (input.stop_hook_active || input.stopHookActive || (input.loop_count ?? input.loopCount ?? 0) > 0) {
    clear(input);
    return { stop: `Bullseye blocked completion: ${problem}` };
  }
  state.pendingRetry = problem;
  save(input, state);
  return { retry: problem };
}

export function response(input) {
  const name = eventName(input);
  if (name === "sessionStart") return { additional_context: POLICY };
  if (name === "beforeSubmitPrompt") {
    const state = load(input);
    if (state?.pendingRetry === input.prompt) {
      state.pendingRetry = null;
      save(input, state);
      return { continue: true };
    }
    start(input);
    return { continue: true };
  }
  if (name === "UserPromptSubmit") {
    start(input);
    return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: POLICY } };
  }
  if (name === "postToolUse" || name === "postToolUseFailure" || name === "PostToolUse" || name === "PostToolUseFailure") {
    observe(input);
    return {};
  }
  if (name === "afterAgentResponse") {
    rememberFinal(input);
    return {};
  }
  if (name === "stop" || name === "Stop") {
    const result = finish(input);
    if (name === "stop") return result.retry ? { followup_message: result.retry } : {};
    if (result.retry) return { decision: "block", reason: result.retry };
    if (result.stop) return { continue: false, stopReason: result.stop };
    return {};
  }
  if (name === "sessionEnd" || name === "SessionEnd") clearSession(input);
  if (name === "Interrupt") clear(input);
  return {};
}

const jsonFiles = [
  "package.json",
  "plugin.json",
  ".codex-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
  "hooks/hooks.json",
  ".cursor-plugin/hooks.json",
];

function requireValue(errors, condition, message) {
  if (!condition) errors.push(message);
}

export function validate(root = process.cwd()) {
  const errors = [];
  const files = new Map();
  for (const file of jsonFiles) {
    try {
      files.set(file, JSON.parse(readFileSync(join(root, file), "utf8")));
    } catch (error) {
      errors.push(`${file}: ${error.message}`);
    }
  }

  const pkg = files.get("package.json");
  if (pkg) {
    requireValue(errors, pkg.type === "module", "package.json: type must be module");
    requireValue(errors, pkg.bin?.bullseye === "./bin/bullseye.mjs", "package.json: bullseye bin is invalid");
    requireValue(errors, pkg.engines?.node === ">=20", "package.json: Node 20+ must be enforced");
    requireValue(errors, Array.isArray(pkg.files) && pkg.files.includes(".codex-plugin/"), "package.json: distributable files must be explicit");
    requireValue(errors, pkg.peerDependencies?.["@cline/core"], "package.json: @cline/core optional peer is required");
    requireValue(errors, pkg.peerDependenciesMeta?.["@cline/core"]?.optional === true, "package.json: @cline/core peer must be optional");
  }

  const portable = files.get("plugin.json");
  requireValue(errors, portable?.name === "bullseye" && portable?.version, "plugin.json: name and version are required");
  const codex = files.get(".codex-plugin/plugin.json");
  requireValue(errors, !codex?.hooks, ".codex-plugin/plugin.json: unsupported hooks field must be omitted");
  requireValue(errors, typeof codex?.author?.name === "string" && codex.author.name, ".codex-plugin/plugin.json: author.name is required");
  for (const field of ["displayName", "shortDescription", "longDescription", "developerName", "category"]) {
    requireValue(errors, typeof codex?.interface?.[field] === "string" && codex.interface[field], `.codex-plugin/plugin.json: interface.${field} is required`);
  }
  requireValue(errors, Array.isArray(codex?.interface?.capabilities) && codex.interface.capabilities.length > 0, ".codex-plugin/plugin.json: interface.capabilities is required");
  requireValue(errors, Array.isArray(codex?.interface?.defaultPrompt) && codex.interface.defaultPrompt.length > 0, ".codex-plugin/plugin.json: interface.defaultPrompt is required");

  const claudeHooks = files.get("hooks/hooks.json")?.hooks;
  requireValue(errors, !claudeHooks?.Interrupt, "hooks/hooks.json: Claude does not support Interrupt");
  for (const event of ["UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"]) {
    requireValue(errors, Array.isArray(claudeHooks?.[event]), `hooks/hooks.json: missing ${event}`);
  }

  const cursorHooks = files.get(".cursor-plugin/hooks.json");
  requireValue(errors, cursorHooks?.version === 1, ".cursor-plugin/hooks.json: version must be 1");
  for (const event of ["sessionStart", "beforeSubmitPrompt", "postToolUse", "postToolUseFailure", "afterAgentResponse", "stop", "sessionEnd"]) {
    requireValue(errors, Array.isArray(cursorHooks?.hooks?.[event]), `.cursor-plugin/hooks.json: missing ${event}`);
  }
  requireValue(errors, cursorHooks?.hooks?.stop?.[0]?.loop_limit === 1, ".cursor-plugin/hooks.json: stop loop_limit must be 1");

  const skill = join(root, "skills/bullseye/SKILL.md");
  if (!existsSync(skill)) errors.push("skills/bullseye/SKILL.md is missing");
  else {
    const frontmatter = readFileSync(skill, "utf8").replaceAll("\r\n", "\n");
    if (!/^---\nname: bullseye\ndescription: (?:"[^"]+"|'[^']+'|[^:\n]+)\n---\n/.test(frontmatter)) errors.push("skill frontmatter is invalid");
  }
  if (!existsSync(join(root, "bin/bullseye.mjs"))) errors.push("bin/bullseye.mjs is missing");
  return errors;
}
