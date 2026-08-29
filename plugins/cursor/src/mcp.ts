import { isRecord } from "../../../packages/contracts/src/index";
import { recordDecision, type RecordDecisionOptions, type RecordDecisionResult } from "./gate";

export interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface McpDispatchOptions extends RecordDecisionOptions {}

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "ai-code-review-cursor", version: "0.2.0" };

const REVIEW_TOOL = {
  name: "review_record_judgment",
  description:
    "Record a structured judgment (decision record) for code you are about to change. The ai-review evidence gate blocks every Write, StrReplace, ApplyPatch, Delete, or notebook edit until a judgment targeting the file at its current content hash has been stored. Call this before the first edit of each target and again after unrelated changes shift line numbers.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["targets", "judgment", "rationale"],
    properties: {
      targets: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "lineStart"],
          properties: {
            path: { type: "string", description: "Repository-relative path of the file the judgment applies to" },
            lineStart: { type: "integer", minimum: 1, description: "First affected line (1-based)" },
            lineEnd: { type: "integer", description: "Last affected line; defaults to the end of the file" },
          },
        },
      },
      judgment: { type: "string", minLength: 1, description: "The decision being made about the change" },
      rationale: { type: "string", minLength: 1, description: "Why this change is safe or correct" },
      checks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            status: { type: "string", enum: ["passed", "failed", "not-run"] },
            details: { type: "string" },
          },
          required: ["name", "status"],
        },
      },
      openQuestions: { type: "array", items: { type: "string" } },
    },
  },
};

function rpcResult(id: unknown, result: unknown): object {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string): object {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolText(result: RecordDecisionResult | { success: false; recordId: string; code: string; message: string }, isError = false): object {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    ...(isError || result.success === false ? { isError: true } : {}),
  };
}

async function callReviewTool(params: unknown, options: McpDispatchOptions): Promise<RecordDecisionResult> {
  const record = isRecord(params) ? params : {};
  const args = isRecord(record.arguments) ? record.arguments : record;
  return recordDecision(args, options);
}

export async function dispatchMcpMessage(message: JsonRpcRequest, options: McpDispatchOptions = {}): Promise<object | null> {
  const method = typeof message.method === "string" ? message.method : "";
  const id = message.id;
  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === "notifications/initialized" || method.startsWith("notifications/")) return null;
  if (method === "tools/list") return rpcResult(id, { tools: [REVIEW_TOOL] });
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/call") {
    const params = isRecord(message.params) ? message.params : {};
    const name = typeof params.name === "string" ? params.name : "";
    if (name !== "review_record_judgment") {
      return rpcResult(id, { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true });
    }
    try {
      const recorded = await callReviewTool(params, options);
      return rpcResult(id, toolText(recorded, !recorded.success));
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      return rpcResult(id, toolText({ success: false, recordId: "", code: "INVALID_RECORD", message: messageText }, true));
    }
  }
  if (id === undefined) return null;
  return rpcError(id, -32601, `Method not found: ${method}`);
}

export async function runMcpServer(): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.trim().length > 0) {
        let parsed: JsonRpcRequest;
        try {
          parsed = JSON.parse(line) as JsonRpcRequest;
        } catch {
          process.stdout.write(`${JSON.stringify(rpcError(null, -32700, "Parse error"))}\n`);
          newline = buffer.indexOf("\n");
          continue;
        }
        const response = await dispatchMcpMessage(parsed);
        if (response !== null) process.stdout.write(`${JSON.stringify(response)}\n`);
      }
      newline = buffer.indexOf("\n");
    }
  }
}
