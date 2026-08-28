import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, test } from "bun:test";
import type { DecisionRecordInput } from "../../../packages/contracts/src/index";
import { mapHostEvent, runAdapter, type HostDecisionEvent, type SubmitResult } from "../src/adapter-contract";
import { RecorderBridge } from "../src/bridge";

const revision = { kind: "commit" as const, sha: "a".repeat(40) };
const event: HostDecisionEvent = {
  sessionId: "session-001",
  repositoryRoot: "/tmp/review-repository",
  revision,
  targets: [
    {
      path: "src/example.ts",
      lineStart: 10,
      lineEnd: 14,
      revision,
      contentHash: "b".repeat(64),
    },
  ],
  judgment: "The change is safe.",
  rationale: "The error branch preserves the invariant.",
  checks: [{ name: "focused tests", status: "passed", details: "all green" }],
  openQuestions: ["Should this be covered by an integration test?"],
  recordId: "record-001",
  createdAt: "2026-08-20T00:00:00.000Z",
};

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function tokenFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ai-review-plugin-"));
  const path = join(directory, "token");
  await writeFile(path, "owner-token\n", "utf8");
  return path;
}

describe("host adapter mapper", () => {
  test("normalizes the same host event into a source-free canonical record", () => {
    const claude = mapHostEvent("claude-code", event);
    const codex = mapHostEvent("codex", event);
    expect(claude).toEqual({ ...codex, agent_type: "claude-code" });
    expect(claude.repository_id).toBe(createHash("sha256").update(event.repositoryRoot).digest("hex"));
    expect(JSON.stringify(claude)).not.toContain("source");
    expect(JSON.stringify(claude)).not.toContain("transcript");
  });

  test("rejects unsupported host fields and malformed targets", () => {
    expect(() => mapHostEvent("claude-code", { ...event, transcript: "secret" } as unknown as HostDecisionEvent)).toThrow();
    expect(() => mapHostEvent("claude-code", { ...event, targets: [{ ...event.targets[0], sourceBody: "secret" }] } as unknown as HostDecisionEvent)).toThrow();
    expect(() => mapHostEvent("claude-code", { ...event, openQuestions: ["ok", 4] } as unknown as HostDecisionEvent)).toThrow();
  });
});

describe("RecorderBridge", () => {
  test("posts an automatic snapshot to the record-specific endpoint", async () => {
    const requests: Request[] = [];
    const bridge = new RecorderBridge({
      endpoint: "http://127.0.0.1:4318/v1/decision-records",
      tokenPath: await tokenFile(),
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init));
        return response(201, { success: true, data: { snapshot_id: "snapshot-1" } });
      },
    });

    const result = await bridge.captureAutomaticSnapshot({
      recordId: "record-1",
      captureId: "capture-1",
      sourcePath: "src/a.ts",
      content: "before\n",
      beforeMissing: false,
    });

    expect(result.success).toBe(true);
    expect(new URL(requests[0]!.url).pathname).toBe("/v1/decision-records/record-1/automatic-snapshot");
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer owner-token");
    expect(await requests[0]!.json()).toEqual({
      capture_id: "capture-1",
      source_path: "src/a.ts",
      content: "before\n",
      before_missing: false,
    });
  });

  test("retries automatic snapshot requests within the existing bounded policy", async () => {
    let calls = 0;
    const bridge = new RecorderBridge({
      endpoint: "http://127.0.0.1:4318/v1/decision-records",
      tokenPath: await tokenFile(),
      maxAttempts: 2,
      retryBaseDelayMs: 0,
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? response(503, { success: false, error: { code: "SOURCE_UNAVAILABLE", message: "try again" } })
          : response(201, { success: true, data: { snapshot_id: "snapshot-2" } });
      },
    });

    const result = await bridge.captureAutomaticSnapshot({
      recordId: "record-2",
      captureId: "capture-2",
      sourcePath: "src/a.ts",
      content: "before\n",
      beforeMissing: false,
    });

    expect(result.success).toBe(true);
    expect(calls).toBe(2);
  });

  test("preserves the exact server failure after automatic snapshot retry exhaustion", async () => {
    let calls = 0;
    const message = "automatic snapshot service is unavailable";
    const bridge = new RecorderBridge({
      endpoint: "http://127.0.0.1:4318/v1/decision-records",
      tokenPath: await tokenFile(),
      maxAttempts: 2,
      retryBaseDelayMs: 0,
      fetchImpl: async () => {
        calls += 1;
        return response(503, { success: false, error: { code: "SOURCE_UNAVAILABLE", message } });
      },
    });

    const result = await bridge.captureAutomaticSnapshot({
      recordId: "record-2b",
      captureId: "capture-2b",
      sourcePath: "src/a.ts",
      content: "before\n",
      beforeMissing: false,
    });

    expect(result).toMatchObject({ success: false, code: "SOURCE_UNAVAILABLE", message, error: message, attempts: 2, status: 503 });
    expect(calls).toBe(2);
  });

  test("preserves an explicit failure envelope returned with a 2xx status", async () => {
    const message = "automatic snapshot was rejected";
    const bridge = new RecorderBridge({
      endpoint: "http://127.0.0.1:4318/v1/decision-records",
      tokenPath: await tokenFile(),
      fetchImpl: async () => response(200, { success: false, error: { code: "HASH_MISMATCH", message } }),
    });

    const result = await bridge.captureAutomaticSnapshot({
      recordId: "record-2c",
      captureId: "capture-2c",
      sourcePath: "src/a.ts",
      content: "before\n",
      beforeMissing: false,
    });

    expect(result).toMatchObject({ success: false, code: "HASH_MISMATCH", message, error: message, status: 200 });
  });

  test("returns the exact non-retryable automatic snapshot failure without leaking the token", async () => {
    const message = "automatic snapshot content does not match the current target state";
    const bridge = new RecorderBridge({
      endpoint: "http://127.0.0.1:4318/v1/decision-records",
      tokenPath: await tokenFile(),
      fetchImpl: async (_input, init) => {
        expect(String(init?.body)).not.toContain("owner-token");
        return response(422, { success: false, error: { code: "HASH_MISMATCH", message } });
      },
    });

    const result = await bridge.captureAutomaticSnapshot({
      recordId: "record-3",
      captureId: "capture-3",
      sourcePath: "src/a.ts",
      content: "before\n",
      beforeMissing: false,
    });

    expect(result).toMatchObject({ success: false, code: "HASH_MISMATCH", message });
  });

  test("deduplicates concurrent automatic snapshot calls by capture ID", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const bridge = new RecorderBridge({
      endpoint: "http://127.0.0.1:4318/v1/decision-records",
      tokenPath: await tokenFile(),
      fetchImpl: async () => {
        calls += 1;
        entered.resolve();
        await release.promise;
        return response(201, { success: true, data: { snapshot_id: "snapshot-4" } });
      },
    });
    const input = {
      recordId: "record-4",
      captureId: "capture-4",
      sourcePath: "src/a.ts",
      content: "before\n",
      beforeMissing: false,
    };

    const first = bridge.captureAutomaticSnapshot(input);
    await entered.promise;
    const second = bridge.captureAutomaticSnapshot(input);
    release.resolve();

    const results = await Promise.all([first, second]);
    expect(results[0]).toEqual(results[1]);
    expect(calls).toBe(1);
  });

  test("submits with a token read from the configured token file", async () => {
    const path = await tokenFile();
    let request: Request | undefined;
    const bridge = new RecorderBridge({
      endpoint: "http://127.0.0.1:4318/v1/decision-records",
      tokenPath: path,
      fetchImpl: async (input, init) => {
        request = new Request(input, init);
        return response(201, { success: true, data: { record: mapHostEvent("claude-code", event) } });
      },
    });

    const result = await bridge.submit(mapHostEvent("claude-code", event));
    expect(result.success).toBe(true);
    expect(result.status).toBe(201);
    expect(request?.headers.get("authorization")).toBe("Bearer owner-token");
    expect(request?.headers.get("content-type")).toBe("application/json");
    expect(await request?.text()).not.toContain("transcript");
  });

  test("treats a Recorder duplicate response as an idempotent success", async () => {
    const bridge = new RecorderBridge({
      endpoint: "http://127.0.0.1:4318/v1/decision-records",
      tokenPath: await tokenFile(),
      fetchImpl: async () => response(200, { success: true, data: { duplicate: true } }),
    });
    const result = await bridge.submit(mapHostEvent("claude-code", event));
    expect(result.success).toBe(true);
    if (result.success) expect(result.duplicate).toBe(true);
  });

  test("returns a bounded unavailable result after retry exhaustion", async () => {
    let calls = 0;
    const bridge = new RecorderBridge({
      endpoint: "http://127.0.0.1:4318/v1/decision-records",
      tokenPath: await tokenFile(),
      maxAttempts: 2,
      retryBaseDelayMs: 1,
      fetchImpl: async () => {
        calls += 1;
        throw new Error("connection refused");
      },
    });
    const result = await bridge.submit(mapHostEvent("claude-code", event));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.code).toBe("RECORDER_UNAVAILABLE");
    expect(calls).toBe(2);
  });

  test("reports queue exhaustion without blocking the coding operation", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const bridge = new RecorderBridge({
      endpoint: "http://127.0.0.1:4318/v1/decision-records",
      tokenPath: await tokenFile(),
      queueCapacity: 1,
      maxAttempts: 1,
      fetchImpl: async () => {
        entered.resolve();
        await release.promise;
        return response(201, { success: true, data: {} });
      },
    });
    const first = bridge.submit(mapHostEvent("claude-code", event));
    await entered.promise;
    const second = await bridge.submit({ ...mapHostEvent("claude-code", event), record_id: "record-002" });
    expect(second.success).toBe(false);
    if (!second.success) expect(second.code).toBe("QUEUE_EXHAUSTED");
    release.resolve();
    expect((await first).success).toBe(true);
  });
});

describe("runAdapter", () => {
  test("emits exactly one bounded result for each input line, including malformed JSON", async () => {
    const outputs: string[] = [];
    const bridge = {
      submit: async (record: DecisionRecordInput): Promise<SubmitResult> => ({
        success: true,
        status: 201,
        duplicate: false,
        recordId: record.record_id,
      }),
    };
    await runAdapter("claude-code", Readable.from([`${JSON.stringify(event)}\nnot-json\n`]), { write: (value: string) => { outputs.push(value); return true; } }, bridge);
    expect(outputs).toHaveLength(2);
    expect(JSON.parse(outputs[0] ?? "").success).toBe(true);
    expect(JSON.parse(outputs[1] ?? "").success).toBe(false);
  });
});
