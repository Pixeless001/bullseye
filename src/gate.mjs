import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const POLICY = "Clarify only material ambiguity. Inspect before editing; reuse before inventing; make the smallest sufficient change. For modifying work, run one relevant proof marked # bullseye:proof, inspect the final diff, then report Verification or an evidence-backed Blocked result. Repair failed checks from evidence and stop once proven.";

const stateDir = join(tmpdir(), "bullseye");

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 3000 });
  return result.status === 0 ? result.stdout : null;
}

function untrackedFingerprint(cwd) {
  const paths = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (paths === null) return null;
  return paths.split("\0").filter(Boolean).map((file) => {
    try {
      return `${file}:${hash(readFileSync(join(cwd, file)))}`;
    } catch {
      return `${file}:missing`;
    }
  }).join("\n");
}

export function snapshot(cwd) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (root === null) return null;
  const repository = resolve(root.trim());
  const diff = git(repository, ["diff", "--binary", "HEAD"]);
  const status = git(repository, ["status", "--porcelain=v1", "-z"]);
  const untracked = untrackedFingerprint(repository);
  const diffCheck = git(repository, ["diff", "--check", "HEAD"]);
  if ([diff, status, untracked, diffCheck].some((value) => value === null)) return null;
  return {
    cwd: repository,
    fingerprint: hash(`${diff}\0${status}\0${untracked}`),
    diffCheck,
  };
}

function stateKey(input) {
  return hash(JSON.stringify([
    input.session_id ?? input.sessionId ?? input.conversation_id ?? "unknown",
    input.turn_id ?? input.turnId ?? "current",
    input.cwd ?? process.cwd(),
  ]));
}

function statePath(input) {
  return join(stateDir, `${stateKey(input)}.json`);
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

function eventName(input) {
  return {
    beforeSubmitPrompt: "UserPromptSubmit",
    postToolUse: "PostToolUse",
    stop: "Stop",
    sessionEnd: "SessionEnd",
  }[input.hook_event_name ?? input.hookEventName ?? input.event] ?? (input.hook_event_name ?? input.hookEventName ?? input.event);
}

function commandFrom(input) {
  return input.tool_input?.command
    ?? input.toolInput?.command
    ?? input.tool_call?.input?.command
    ?? input.input?.command
    ?? input.command
    ?? "";
}

function succeeded(input) {
  const result = input.tool_response ?? input.toolResponse ?? input.result ?? {};
  if (typeof result.exit_code === "number") return result.exit_code === 0;
  if (typeof result.exitCode === "number") return result.exitCode === 0;
  if (typeof result.isError === "boolean") return !result.isError;
  if (typeof result.success === "boolean") return result.success;
  return false;
}

function finalMessage(input) {
  return input.last_assistant_message ?? input.lastAssistantMessage ?? input.message ?? "";
}

function blocker(message) {
  return /(?:^|\n)Blocked:\s*\S/i.test(message) && /(?:^|\n)Evidence:\s*\S/i.test(message);
}

function verification(message) {
  return /(?:^|\n)Verification:\s*\S/i.test(message);
}

export function begin(input) {
  const baseline = snapshot(input.cwd ?? process.cwd());
  if (baseline) save(input, { baseline, receipt: null });
  return baseline;
}

export function observe(input, state = load(input)) {
  const command = commandFrom(input);
  if (!state || !command.includes("# bullseye:proof")) return state;
  const current = snapshot(input.cwd ?? state.baseline.cwd);
  state.receipt = {
    command,
    success: succeeded(input),
    fingerprint: current?.fingerprint ?? null,
  };
  save(input, state);
  return state;
}

export function finish(input, state = load(input)) {
  if (!state?.baseline) return { allow: true };
  const current = snapshot(input.cwd ?? state.baseline.cwd);
  if (!current || current.fingerprint === state.baseline.fingerprint) {
    clear(input);
    return { allow: true };
  }

  const message = finalMessage(input);
  const proof = state.receipt;
  const problem = current.diffCheck !== state.baseline.diffCheck && current.diffCheck
    ? "git diff --check reports new whitespace errors."
    : blocker(message)
      ? null
      : !verification(message)
        ? "Report Verification with the marked proof command, or Blocked with Evidence."
        : !proof?.success
          ? "Run the relevant proof command and end it with # bullseye:proof."
          : proof.fingerprint !== current.fingerprint
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
  return { retry: problem };
}

export function response(input) {
  const name = eventName(input);
  if (name === "UserPromptSubmit") {
    begin(input);
    return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: POLICY } };
  }
  if (name === "PostToolUse") {
    observe(input);
    return {};
  }
  if (name === "Stop") {
    const result = finish(input);
    if (result.retry) return { decision: "block", reason: result.retry };
    if (result.stop) return { continue: false, stopReason: result.stop };
    return {};
  }
  if (name === "SessionEnd" || name === "Interrupt") clear(input);
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

export function validate(root = process.cwd()) {
  const errors = [];
  for (const file of jsonFiles) {
    try {
      JSON.parse(readFileSync(join(root, file), "utf8"));
    } catch (error) {
      errors.push(`${file}: ${error.message}`);
    }
  }
  const skill = join(root, "skills/bullseye/SKILL.md");
  if (!existsSync(skill)) errors.push("skills/bullseye/SKILL.md is missing");
  else if (!readFileSync(skill, "utf8").startsWith("---\nname: bullseye\n")) errors.push("skill frontmatter is invalid");
  if (!existsSync(join(root, "bin/bullseye.mjs"))) errors.push("bin/bullseye.mjs is missing");
  return errors;
}

export function displayName(input) {
  return basename(input.cwd ?? process.cwd());
}
