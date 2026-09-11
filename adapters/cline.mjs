import { begin, finish, observe } from "../src/gate.mjs";

let state;

function eventFor(context = {}) {
  return {
    session_id: context.sessionId ?? "cline",
    turn_id: context.runId ?? "current",
    cwd: context.workspaceInfo?.rootPath ?? process.cwd(),
  };
}

const completionTool = {
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
  async execute(input, context) {
    const event = {
      ...(state?.event ?? eventFor(context)),
      last_assistant_message: input.status === "blocked"
        ? `Blocked: ${input.summary}\nEvidence: ${input.evidence}`
        : `Verification: ${input.evidence}`,
    };
    const result = finish(event, state);
    if (input.status === "verified" && !result.allow) throw new Error(result.retry ?? result.stop);
    if (input.status === "blocked" && !input.evidence.trim()) throw new Error("Blocked completion requires evidence.");
    return { status: input.status, summary: input.summary };
  },
};

const plugin = {
  name: "bullseye",
  manifest: { capabilities: ["tools", "hooks"] },
  setup(api) {
    api.registerTool(completionTool);
  },
  hooks: {
    beforeRun(context) {
      const event = eventFor(context);
      state = { event, baseline: begin(event), receipt: null };
    },
    afterTool({ input, result }) {
      if (!state?.baseline) return;
      observe({ ...state.event, tool_input: input, result }, state);
    },
  },
};

export { plugin };
export default plugin;
