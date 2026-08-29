import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(pluginRoot, "..", "..");

type GateHooks = {
  version: number;
  hooks: {
    sessionStart: Array<{ command: string }>;
    preToolUse: Array<{ command: string; failClosed?: boolean; matcher?: string }>;
    beforeShellExecution: Array<{ command: string; failClosed?: boolean }>;
    postToolUse: Array<{ command: string; matcher?: string }>;
  };
};

function assertFailClosedGate(hooks: GateHooks, preEditCommand: string, postEditCommand: string, sessionCommand: string) {
  expect(hooks.version).toBe(1);
  expect(hooks.hooks.sessionStart.some((hook) => hook.command === sessionCommand)).toBe(true);
  expect(hooks.hooks.preToolUse.length).toBeGreaterThan(0);
  expect(hooks.hooks.preToolUse.every((hook) => hook.command === preEditCommand && hook.failClosed === true)).toBe(true);
  expect(hooks.hooks.preToolUse.some((hook) => hook.matcher?.includes("Write"))).toBe(true);
  expect(hooks.hooks.beforeShellExecution[0]).toEqual({
    command: preEditCommand,
    timeout: 10,
    failClosed: true,
  });
  expect(hooks.hooks.postToolUse.some((hook) => hook.command === postEditCommand && hook.matcher?.includes("Write"))).toBe(true);
}

test("Cursor plugin hooks fail closed on gated edit and shell events", async () => {
  const hooks = await Bun.file(join(pluginRoot, "hooks/hooks.json")).json() as GateHooks & {
    hooks: { beforeShellExecution: Array<{ command: string; timeout?: number; failClosed?: boolean }> };
  };
  assertFailClosedGate(hooks, "./bin/ai-review-pre-edit", "./bin/ai-review-post-edit", "./bin/ai-review-session-start");
});

test("project Cursor hooks load the same fail-closed gate from the repository", async () => {
  const hooks = await Bun.file(join(repoRoot, ".cursor/hooks.json")).json() as GateHooks & {
    hooks: { beforeShellExecution: Array<{ command: string; timeout?: number; failClosed?: boolean }> };
  };
  assertFailClosedGate(
    hooks,
    "plugins/cursor/bin/ai-review-pre-edit",
    "plugins/cursor/bin/ai-review-post-edit",
    "plugins/cursor/bin/ai-review-session-start",
  );
});

async function runPreEdit(env: NodeJS.ProcessEnv, input: unknown): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([join(pluginRoot, "bin/ai-review-pre-edit")], {
    cwd: repoRoot,
    env,
    stdin: new Response(`${JSON.stringify(input)}\n`),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

test("pre-edit wrapper locates the adapter without CURSOR_PLUGIN_ROOT", async () => {
  const env = { ...process.env };
  delete env.CURSOR_PLUGIN_ROOT;
  const result = await runPreEdit(env, { tool_name: "Read", cwd: repoRoot });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe("");
  expect(result.stderr).not.toContain("CURSOR_PLUGIN_ROOT must be set");
});

test("pre-edit wrapper still denies a Write when CURSOR_PLUGIN_ROOT is unset", async () => {
  const env = { ...process.env };
  delete env.CURSOR_PLUGIN_ROOT;
  const result = await runPreEdit(env, {
    conversation_id: "session-project-hooks",
    cwd: repoRoot,
    tool_name: "Write",
    tool_input: { path: "README.md", contents: "blocked\n" },
  });
  expect(result.exitCode).toBe(0);
  const payload = JSON.parse(result.stdout) as { permission?: string };
  expect(payload.permission).toBe("deny");
});
