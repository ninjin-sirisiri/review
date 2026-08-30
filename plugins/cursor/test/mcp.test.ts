import { createHash } from "node:crypto";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, expect, test } from "bun:test";
import type { AdapterBridge, SubmitResult } from "../../common/src/adapter-contract";
import type { RecorderSetupClient } from "../../common/src/recorder-setup";
import type { ReviewSession } from "../../../packages/contracts/src/index";
import { handleSessionStart } from "../src/gate";
import { dispatchMcpMessage } from "../src/mcp";

const GATED_ENV_KEYS = [
  "AI_REVIEW_SESSION_ID",
  "AI_REVIEW_REPOSITORY_ROOT",
  "AI_REVIEW_AGENT_TYPE",
  "AI_REVIEW_GATE_ROOT",
  "AI_REVIEW_CURSOR_SESSION_ROOT",
  "CURSOR_PROJECT_DIR",
  "CURSOR_PLUGIN_ROOT",
];
const preservedEnv: Record<string, string | undefined> = {};

function passingSetupClient(): Pick<RecorderSetupClient, "ensureSession"> {
  return {
    ensureSession: async (root: string, session: ReviewSession) => ({
      repository: { repository_id: "repository-setup", root, created_at: "2026-08-29T00:00:00.000Z" },
      session,
    }),
  } as unknown as Pick<RecorderSetupClient, "ensureSession">;
}

beforeEach(() => {
  for (const key of GATED_ENV_KEYS) {
    preservedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterAll(() => {
  for (const [key, value] of Object.entries(preservedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function fixture(): Promise<{ root: string; gateRoot: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ai-review-cursor-mcp-")));
  await Bun.write(join(root, "src", "change.ts"), "export const value = 1;\n");
  return { root, gateRoot: join(root, "gate-state") };
}

test("initialize and tools/list advertise review_record_judgment", async () => {
  const initialized = await dispatchMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  expect(initialized).toMatchObject({
    jsonrpc: "2.0",
    id: 1,
    result: { serverInfo: { name: "ai-code-review-cursor" }, capabilities: { tools: {} } },
  });
  expect(await dispatchMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();

  const listed = await dispatchMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  expect(JSON.stringify(listed)).toContain("review_record_judgment");
});

test("tools/call records a judgment and grants a permit", async () => {
  const current = await fixture();
  const bridge: AdapterBridge = {
    submit: async (record): Promise<SubmitResult> => ({ success: true, status: 201, duplicate: false, recordId: record.record_id }),
  };

  const result = await dispatchMcpMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "review_record_judgment",
      arguments: {
        targets: [{ path: "src/change.ts", lineStart: 1 }],
        judgment: "the change preserves the invariant",
        rationale: "the focused branch keeps the existing guard",
      },
    },
  }, { sessionId: "session-mcp", repositoryRoot: current.root, gateRoot: current.gateRoot, bridge });

  expect(result).toMatchObject({ jsonrpc: "2.0", id: 3 });
  const payload = result as { result: { content: Array<{ text: string }>; isError?: boolean } };
  expect(payload.result.isError).toBeFalsy();
  expect(JSON.parse(payload.result.content[0]?.text ?? "")).toMatchObject({ success: true, permits: 1 });
});

test("tools/call returns a structured failure for an unknown tool", async () => {
  const result = await dispatchMcpMessage({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "not_a_tool", arguments: {} },
  });
  expect(result).toMatchObject({ jsonrpc: "2.0", id: 4 });
  const payload = result as { result: { isError?: boolean } };
  expect(payload.result.isError).toBe(true);
});

test("tools/call recovers the persisted Cursor session when MCP has no sessionStart env", async () => {
  const current = await fixture();
  await handleSessionStart({
    session_id: "session-mcp-env",
    cwd: current.root,
  }, {
    setupClient: passingSetupClient(),
    sessionStoreRoot: join(current.root, "cursor-sessions"),
  });
  process.env.CURSOR_PROJECT_DIR = current.root;
  const bridge: AdapterBridge = {
    submit: async (record): Promise<SubmitResult> => {
      expect(record.session_id).toBe("session-mcp-env");
      expect(record.repository_id).toBe(createHash("sha256").update(current.root, "utf8").digest("hex"));
      return { success: true, status: 201, duplicate: false, recordId: record.record_id };
    },
  };

  const result = await dispatchMcpMessage({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "review_record_judgment",
      arguments: {
        targets: [{ path: "src/change.ts", lineStart: 1 }],
        judgment: "the change preserves the invariant",
        rationale: "the focused branch keeps the existing guard",
      },
    },
  }, { gateRoot: current.gateRoot, sessionStoreRoot: join(current.root, "cursor-sessions"), bridge });

  const payload = result as { result: { content: Array<{ text: string }>; isError?: boolean } };
  expect(payload.result.isError).toBeFalsy();
  expect(JSON.parse(payload.result.content[0]?.text ?? "")).toMatchObject({ success: true, permits: 1 });
});
