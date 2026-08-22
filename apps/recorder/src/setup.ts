import { randomUUID, createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  RecorderSetupClient,
  RecorderSetupError,
  defaultSetupTokenPath,
} from "../../../plugins/common/src/recorder-setup";
import type { AgentType, ReviewSession } from "../../../packages/contracts/src/index";

export interface SetupCliOptions {
  root?: string;
  sessionId?: string;
  agentType?: AgentType;
  endpoint?: string;
  tokenPath?: string;
}

export type SetupClient = Pick<RecorderSetupClient, "ensureSession">;

export interface SetupResult {
  success: true;
  repositoryId: string;
  sessionId: string;
  root: string;
  agentType: AgentType;
  tokenPath: string;
  sessionGenerated: boolean;
}

const SETUP_USAGE = `Usage: ai-review setup [options]

Register the current repository and session with the local Recorder.

Options:
  --root <path>       Repository root (default: current directory)
  --session-id <id>   Host session ID (default: AI_REVIEW_SESSION_ID or UUID)
  --agent-type <type> claude-code or codex (default: claude-code)
  --recorder-url <url> Loopback Recorder decision endpoint
  --token-path <path> Token file path
  -h, --help          Show this help
`;

function optionValue(args: string[], index: number, flag: string): { value: string; nextIndex: number } {
  const value = args[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return { value, nextIndex: index + 1 };
}

function agentType(value: string): AgentType {
  if (value !== "claude-code" && value !== "codex") throw new Error("--agent-type must be claude-code or codex");
  return value;
}

export function parseSetupCliArgs(args: string[]): SetupCliOptions {
  const options: SetupCliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--root" || argument?.startsWith("--root=")) {
      const value = argument === "--root" ? optionValue(args, index, "--root") : { value: argument.slice("--root=".length), nextIndex: index };
      if (value.value.length === 0) throw new Error("--root requires a value");
      options.root = value.value;
      index = value.nextIndex;
      continue;
    }
    if (argument === "--session-id" || argument?.startsWith("--session-id=")) {
      const value = argument === "--session-id" ? optionValue(args, index, "--session-id") : { value: argument.slice("--session-id=".length), nextIndex: index };
      if (value.value.length === 0) throw new Error("--session-id requires a value");
      options.sessionId = value.value;
      index = value.nextIndex;
      continue;
    }
    if (argument === "--agent-type" || argument?.startsWith("--agent-type=")) {
      const value = argument === "--agent-type" ? optionValue(args, index, "--agent-type") : { value: argument.slice("--agent-type=".length), nextIndex: index };
      if (value.value.length === 0) throw new Error("--agent-type requires a value");
      options.agentType = agentType(value.value);
      index = value.nextIndex;
      continue;
    }
    if (argument === "--recorder-url" || argument?.startsWith("--recorder-url=")) {
      const value = argument === "--recorder-url" ? optionValue(args, index, "--recorder-url") : { value: argument.slice("--recorder-url=".length), nextIndex: index };
      if (value.value.length === 0) throw new Error("--recorder-url requires a value");
      options.endpoint = value.value;
      index = value.nextIndex;
      continue;
    }
    if (argument === "--token-path" || argument?.startsWith("--token-path=")) {
      const value = argument === "--token-path" ? optionValue(args, index, "--token-path") : { value: argument.slice("--token-path=".length), nextIndex: index };
      if (value.value.length === 0) throw new Error("--token-path requires a value");
      options.tokenPath = value.value;
      index = value.nextIndex;
      continue;
    }
    if (argument === "-h" || argument === "--help") {
      throw new Error("__SETUP_HELP__");
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function repositoryId(root: string): string {
  return createHash("sha256").update(root, "utf8").digest("hex");
}

function sessionInput(root: string, sessionId: string, type: AgentType): ReviewSession {
  return {
    session_id: sessionId,
    repository_id: repositoryId(root),
    agent_type: type,
    started_at: new Date().toISOString(),
    status: "active",
  };
}

export async function setupRecorder(options: SetupCliOptions = {}, client?: SetupClient): Promise<SetupResult> {
  const root = await realpath(resolve(options.root ?? process.cwd()));
  const sessionId = options.sessionId ?? process.env.AI_REVIEW_SESSION_ID ?? randomUUID();
  const sessionGenerated = options.sessionId === undefined && process.env.AI_REVIEW_SESSION_ID === undefined;
  const type = options.agentType ?? (process.env.AI_REVIEW_AGENT_TYPE === "codex" ? "codex" : "claude-code");
  const setupClient = client ?? new RecorderSetupClient({
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(options.tokenPath === undefined ? {} : { tokenPath: options.tokenPath }),
  });
  const registration = await setupClient.ensureSession(root, sessionInput(root, sessionId, type));
  return {
    success: true,
    repositoryId: registration.repository.repository_id,
    sessionId: registration.session.session_id,
    root: registration.repository.root,
    agentType: registration.session.agent_type,
    tokenPath: options.tokenPath ?? process.env.RECORDER_TOKEN_PATH ?? defaultSetupTokenPath(),
    sessionGenerated,
  };
}

export async function runSetupProcess(args = process.argv.slice(2)): Promise<void> {
  try {
    const options = parseSetupCliArgs(args);
    const result = await setupRecorder(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.sessionGenerated) {
      process.stderr.write("Session ID was generated for this process; export AI_REVIEW_SESSION_ID before the next hook or use the host-provided session ID.\n");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "__SETUP_HELP__") {
      process.stdout.write(SETUP_USAGE);
      return;
    }
    const code = error instanceof RecorderSetupError ? error.code : "SETUP_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ success: false, code, message })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await runSetupProcess();
