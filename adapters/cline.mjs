import { finish, observe, POLICY, start } from "../src/gate.mjs";

const sessions = new Map();

function contextId(context = {}) {
  return context.session?.sessionId
    ?? context.sessionId
    ?? context.context?.session?.sessionId
    ?? context.toolCall?.sessionId;
}

function eventFor(record, context = {}) {
  return {
    session_id: record.id,
    turn_id: context.runId ?? context.run?.id ?? "current",
    cwd: record.cwd,
    prompt: context.prompt ?? context.input,
  };
}

function recordFor(context = {}, input = {}) {
  const id = contextId(context);
  if (id && sessions.has(id)) return sessions.get(id);
  const cwd = input.cwd ?? input.working_directory ?? context.cwd;
  if (cwd) {
    const matches = [...sessions.values()].filter((record) => record.cwd === cwd);
    if (matches.length === 1) return matches[0];
  }
  return sessions.size === 1 ? sessions.values().next().value : null;
}

function completionTool(record) {
  return {
    name: "bullseye_complete",
    description: "End the run only after a marked proof passed, or report an evidence-backed blocker.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["verified", "blocked"] },
        summary: { type: "string" },
        evidence: { type: "string" },
      },
      required: ["status", "summary", "evidence"],
    },
    lifecycle: { completesRun: true },
    async execute(input) {
      if (!input.evidence.trim()) throw new Error("Completion requires evidence.");
      const event = {
        ...record.event,
        loop_count: record.attempts,
        last_assistant_message: input.status === "blocked"
          ? `Blocked: ${input.summary}\nEvidence: ${input.evidence}`
          : `Verification: ${input.evidence}`,
      };
      const result = finish(event, record.state);
      if (result.allow) {
        record.state = null;
        return { status: input.status, summary: input.summary };
      }

      record.attempts += 1;
      const problem = result.retry ?? result.stop;
      if (record.attempts > 1 || result.stop) {
        record.state = null;
        return { status: "blocked", summary: "Bullseye blocked completion", evidence: problem };
      }
      throw new Error(problem);
    },
  };
}

const plugin = {
  name: "bullseye",
  manifest: { capabilities: ["tools", "hooks", "rules"] },
  setup(api, context = {}) {
    const cwd = context.workspaceInfo?.rootPath;
    const id = contextId(context) ?? `cline:${cwd ?? "unknown"}`;
    const record = { id, cwd, event: null, state: null, attempts: 0 };
    sessions.set(id, record);
    api.registerRule({ id: "bullseye", content: POLICY, source: "bullseye" });
    api.registerTool(completionTool(record));
  },
  hooks: {
    beforeRun(context = {}) {
      const record = recordFor(context);
      if (!record) return { stop: true, reason: "Bullseye could not identify the active Cline session." };
      record.event = eventFor(record, context);
      record.state = start(record.event);
      record.attempts = 0;
      return undefined;
    },
    afterTool(context = {}) {
      if (context.toolCall?.toolName !== "run_commands") return undefined;
      const record = recordFor(context, context.input);
      if (!record?.state) return undefined;
      observe({ ...record.event, tool_input: context.input, result: context.result }, record.state);
      return undefined;
    },
  },
};

export { plugin };
export default plugin;
