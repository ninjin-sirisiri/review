import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "bun:test";
import type { Plugin } from "@opencode-ai/plugin";
import pluginModule from "../src/index";
import { grantDecisionPermits, normalizeDecisionProposal } from "../../common/src/decision-gate";

const pluginFactory = pluginModule.server;

const GATED_ENV_KEYS = ["AI_REVIEW_SESSION_ID", "AI_REVIEW_REPOSITORY_ROOT", "AI_REVIEW_AGENT_TYPE", "AI_REVIEW_GATE_ROOT", "RECORDER_URL", "RECORDER_TOKEN_PATH"];
const preservedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of GATED_ENV_KEYS) {
    preservedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

async function fixture(): Promise<{ root: string; file: string; gateRoot: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ai-review-opencode-plugin-")));
  const file = join(root, "src", "change.ts");
  await Bun.write(file, "export const value = 1;\n");
  return { root, file, gateRoot: join(root, "gate-state") };
}

type PluginInput = Parameters<Plugin>[0];

function pluginInput(current: { root: string }): PluginInput {
  return {
    client: {},
    project: {},
    directory: current.root,
    worktree: current.root,
    experimental_workspace: { register: () => undefined },
    serverUrl: new URL("http://127.0.0.1:4096"),
    $: {},
  } as unknown as PluginInput;
}

async function buildHooks(current: { root: string }) {
  const hooks = await pluginFactory(pluginInput(current));
  if (!hooks) throw new Error("plugin returned no hooks");
  return hooks;
}

test("the plugin gates edits before any judgment exists", async () => {
  const current = await fixture();
  process.env.AI_REVIEW_GATE_ROOT = current.gateRoot;
  const hooks = await buildHooks(current);
  const before = hooks["tool.execute.before"];
  if (before === undefined) throw new Error("tool.execute.before hook missing");

  let denied = "";
  try {
    await before({ tool: "edit", sessionID: "ses_gate-001", callID: "call-1" }, { args: { filePath: current.file } });
  } catch (error) {
    denied = error instanceof Error ? error.message : String(error);
  }

  expect(denied).toContain("blocked");
});

test("the plugin consumes a permit only when an edit actually completes", async () => {
  const current = await fixture();
  process.env.AI_REVIEW_GATE_ROOT = current.gateRoot;
  const hooks = await buildHooks(current);
  const before = hooks["tool.execute.before"];
  const after = hooks["tool.execute.after"];
  if (before === undefined || after === undefined) throw new Error("gate hooks missing");

  const event = await normalizeDecisionProposal({
    repositoryRoot: current.root,
    targets: [{ path: "src/change.ts", lineStart: 1, lineEnd: 1 }],
    judgment: "the change preserves the invariant",
    rationale: "the focused branch keeps the existing guard",
  }, { sessionId: "ses_gate-002" });
  await grantDecisionPermits(event, { recordId: "record-gate-002", gateRoot: current.gateRoot });

  await before({ tool: "edit", sessionID: "ses_gate-002", callID: "call-2" }, { args: { filePath: current.file } });
  await after({ tool: "edit", sessionID: "ses_gate-002", callID: "call-2", args: { filePath: current.file } }, { title: "x", output: "", metadata: {} });
  await expect(before({ tool: "edit", sessionID: "ses_gate-002", callID: "call-3" }, { args: { filePath: current.file } })).rejects.toThrow("blocked");
});

test("an edit blocked outside the gate leaves the permit usable on retry", async () => {
  const current = await fixture();
  process.env.AI_REVIEW_GATE_ROOT = current.gateRoot;
  const hooks = await buildHooks(current);
  const before = hooks["tool.execute.before"];
  const after = hooks["tool.execute.after"];
  if (before === undefined || after === undefined) throw new Error("gate hooks missing");

  const event = await normalizeDecisionProposal({
    repositoryRoot: current.root,
    targets: [{ path: "src/change.ts", lineStart: 1, lineEnd: 1 }],
    judgment: "the change preserves the invariant",
    rationale: "the focused branch keeps the existing guard",
  }, { sessionId: "ses_gate-004" });
  await grantDecisionPermits(event, { recordId: "record-gate-004", gateRoot: current.gateRoot });

  await before({ tool: "edit", sessionID: "ses_gate-004", callID: "call-6" }, { args: { filePath: current.file } });
  await before({ tool: "edit", sessionID: "ses_gate-004", callID: "call-7" }, { args: { filePath: current.file } });

  await after({ tool: "edit", sessionID: "ses_gate-004", callID: "call-7", args: { filePath: current.file } }, { title: "x", output: "", metadata: {} });
  await expect(before({ tool: "edit", sessionID: "ses_gate-004", callID: "call-8" }, { args: { filePath: current.file } })).rejects.toThrow("blocked");
});

test("shell mutations are rejected while reads stay ungated", async () => {
  const current = await fixture();
  process.env.AI_REVIEW_GATE_ROOT = current.gateRoot;
  const hooks = await buildHooks(current);
  const before = hooks["tool.execute.before"];
  if (before === undefined) throw new Error("tool.execute.before hook missing");

  await expect(before({ tool: "bash", sessionID: "ses_gate-003", callID: "call-4" }, { args: { command: "git checkout -- src/change.ts" } })).rejects.toThrow("Shell command blocked");
  await before({ tool: "read", sessionID: "ses_gate-003", callID: "call-5" }, { args: { filePath: current.file } });
});

test("shell.env exports the ai-review environment for CLI fallbacks", async () => {
  const current = await fixture();
  process.env.AI_REVIEW_GATE_ROOT = current.gateRoot;
  const hooks = await buildHooks(current);
  const shellEnv = hooks["shell.env"];
  if (shellEnv === undefined) throw new Error("shell.env hook missing");

  const output = { env: {} as Record<string, string> };
  await shellEnv({ cwd: current.root, sessionID: "ses_env-001" }, output);

  expect(output.env.AI_REVIEW_SESSION_ID).toBe("ses_env-001");
  expect(output.env.AI_REVIEW_REPOSITORY_ROOT).toBe(current.root);
  expect(output.env.AI_REVIEW_AGENT_TYPE).toBe("opencode");
});

test("the review_record_judgment tool validates targets against the repository boundary", async () => {
  const current = await fixture();
  process.env.AI_REVIEW_GATE_ROOT = current.gateRoot;
  process.env.RECORDER_URL = "http://127.0.0.1:9/v1/decision-records";
  process.env.RECORDER_TOKEN_PATH = join(current.gateRoot, "missing-token");
  const hooks = await buildHooks(current);
  const recordTool = hooks.tool?.review_record_judgment;
  if (recordTool === undefined) throw new Error("review_record_judgment tool missing");

  await expect(recordTool.execute({
    targets: [{ path: "../outside.ts", lineStart: 1 }],
    judgment: "safe",
    rationale: "checked",
  }, { sessionID: "ses_tool-001" } as unknown as Parameters<typeof recordTool.execute>[1])).rejects.toThrow();

  expect(await recordTool.execute({
    targets: [{ path: "missing-file.ts", lineStart: 1 }],
    judgment: "safe",
    rationale: "unchecked missing file",
  }, { sessionID: "ses_tool-001" } as unknown as Parameters<typeof recordTool.execute>[1])).toContain('"success":false');
});
