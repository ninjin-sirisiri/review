import { realpath } from "node:fs/promises";
import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { runAdapter } from "../../common/src/adapter-contract";
import { AGENT_TYPE, gateToolUse, gateToolUseAfter, recordDecision, registerSession } from "./gate";

const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit", "notebookedit"]);
const GATED_TOOLS = new Set([...EDIT_TOOLS, "bash"]);

function sessionIdFromEvent(event: unknown): string | null {
  if (typeof event !== "object" || event === null) return null;
  const properties = (event as { properties?: unknown }).properties;
  if (typeof properties !== "object" || properties === null) return null;
  const container = properties as { info?: unknown; sessionID?: unknown; id?: unknown };
  if (typeof container.info === "object" && container.info !== null) {
    const id = (container.info as { id?: unknown }).id;
    if (typeof id === "string" && id.trim().length > 0) return id;
  }
  if (typeof container.sessionID === "string" && container.sessionID.trim().length > 0) return container.sessionID;
  if (typeof container.id === "string" && container.id.trim().length > 0) return container.id;
  return null;
}

function logWarning(client: Parameters<Plugin>[0]["client"], message: string): void {
  try {
    void client?.app
      ?.log?.({
        body: { service: "ai-code-review-evidence", level: "warn", message },
      })
      ?.catch(() => undefined);
  } catch {
    // Logging must never break session registration handling.
  }
}

const plugin: Plugin = async ({ client, directory, worktree }) => {
  const repositoryRoot = await realpath(worktree || directory).catch(() => worktree || directory);
  const registrations = new Map<string, Promise<void>>();

  async function ensureRegistered(sessionId: string): Promise<void> {
    let pending = registrations.get(sessionId);
    if (pending === undefined) {
      pending = registerSession(sessionId, repositoryRoot).then(
        () => undefined,
        (error: unknown) => {
          registrations.delete(sessionId);
          logWarning(client, `Recorder registration failed: ${error instanceof Error ? error.message : String(error)}`);
        },
      );
      registrations.set(sessionId, pending);
    }
    await pending;
  }

  function gateContext(sessionId: string) {
    return { sessionId, repositoryRoot };
  }

  return {
    event: async ({ event }) => {
      if (event.type !== "session.created") return;
      const sessionId = sessionIdFromEvent(event);
      if (sessionId === null) return;
      await ensureRegistered(sessionId).catch(() => undefined);
    },

    "shell.env": async (input, output) => {
      if (input.sessionID !== undefined && input.sessionID.trim().length > 0) output.env.AI_REVIEW_SESSION_ID = input.sessionID;
      output.env.AI_REVIEW_REPOSITORY_ROOT = repositoryRoot;
      output.env.AI_REVIEW_AGENT_TYPE = AGENT_TYPE;
    },

    "tool.execute.before": async (input, output) => {
      if (!GATED_TOOLS.has(input.tool.toLowerCase())) return;
      await ensureRegistered(input.sessionID).catch(() => undefined);
      const reason = await gateToolUse({ tool: input.tool, args: output.args }, gateContext(input.sessionID));
      if (reason !== null) throw new Error(reason);
    },

    "tool.execute.after": async (input, output) => {
      await gateToolUseAfter(
        { tool: input.tool, args: input.args },
        gateContext(input.sessionID),
      );
    },

    tool: {
      review_record_judgment: tool({
        description:
          "Record a structured judgment (decision record) for code you are about to change. The ai-review evidence gate blocks every edit or write until a judgment targeting the file at its current content hash has been stored. Call this before the first edit of each target and again after unrelated changes shift line numbers.",
        args: {
          targets: tool.schema
            .array(
              tool.schema.object({
                path: tool.schema.string().describe("Repository-relative path of the file the judgment applies to"),
                lineStart: tool.schema.number().int().min(1).describe("First affected line (1-based)"),
                lineEnd: tool.schema.number().int().optional().describe("Last affected line; defaults to the end of the file"),
              }),
            )
            .min(1)
            .describe("Files and line ranges the judgment covers"),
          judgment: tool.schema.string().min(1).describe("The decision being made about the change"),
          rationale: tool.schema.string().min(1).describe("Why this change is safe or correct"),
          checks: tool.schema.optional(
            tool.schema.array(
              tool.schema.object({
                name: tool.schema.string(),
                status: tool.schema.enum(["passed", "failed", "not-run"]),
                details: tool.schema.optional(tool.schema.string()),
              }),
            ),
          ),
          openQuestions: tool.schema.optional(tool.schema.array(tool.schema.string())),
        },
        async execute(args, context) {
          await ensureRegistered(context.sessionID);
          const result = await recordDecision(
            {
              targets: args.targets.map((target) => ({
                path: target.path,
                lineStart: target.lineStart,
                ...(target.lineEnd === undefined ? {} : { lineEnd: target.lineEnd }),
              })),
              judgment: args.judgment,
              rationale: args.rationale,
              ...(args.checks === undefined ? {} : { checks: args.checks }),
              ...(args.openQuestions === undefined ? {} : { openQuestions: args.openQuestions }),
            },
            gateContext(context.sessionID),
          );
          return JSON.stringify(result);
        },
      }),
    },
  };
};

export default {
  id: "ai-code-review-evidence",
  server: plugin,
} satisfies PluginModule;

if (import.meta.main) {
  await runAdapter(AGENT_TYPE, process.stdin, process.stdout);
}
