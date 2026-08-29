import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { ReviewSession } from "../../../packages/contracts/src/index";
import { parseSetupCliArgs, setupRecorder, type SetupClient } from "../src/setup";

test("parseSetupCliArgs parses explicit setup options", () => {
  expect(parseSetupCliArgs([
    "--root", "/tmp/repository",
    "--session-id", "session-setup",
    "--agent-type", "codex",
    "--recorder-url", "http://127.0.0.1:4318/v1/decision-records",
    "--token-path", "/tmp/token",
  ])).toEqual({
    root: "/tmp/repository",
    sessionId: "session-setup",
    agentType: "codex",
    endpoint: "http://127.0.0.1:4318/v1/decision-records",
    tokenPath: "/tmp/token",
  });
  expect(parseSetupCliArgs(["--agent-type", "cursor"]).agentType).toBe("cursor");
});

test("parseSetupCliArgs rejects unknown flags and missing values", () => {
  expect(() => parseSetupCliArgs(["--unknown"])).toThrow("unknown argument");
  expect(() => parseSetupCliArgs(["--root"])).toThrow("--root requires a value");
});

test("setupRecorder registers canonical repository and session without returning token content", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-review-setup-cli-"));
  const canonicalRoot = await realpath(root);
  let registeredRoot = "";
  let registeredSession: Record<string, unknown> | undefined;
  const client: SetupClient = {
    ensureSession: async (repositoryRoot: string, session: ReviewSession) => {
      registeredRoot = repositoryRoot;
      registeredSession = session as unknown as Record<string, unknown>;
      return {
        repository: { repository_id: "repository-setup", root: repositoryRoot, created_at: session.started_at },
        session: { ...session },
      };
    },
  };

  const result = await setupRecorder({ root, sessionId: "session-setup", agentType: "claude-code", tokenPath: "/tmp/secret-token" }, client);

  expect(result.success).toBe(true);
  expect(result.repositoryId).toBe("repository-setup");
  expect(result.sessionId).toBe("session-setup");
  expect(result.root).toBe(canonicalRoot);
  expect(result.tokenPath).toBe("/tmp/secret-token");
  expect(registeredRoot).toBe(canonicalRoot);
  expect(registeredSession).toMatchObject({ session_id: "session-setup", agent_type: "claude-code" });
  expect(JSON.stringify(result)).not.toContain("owner-token");
});
