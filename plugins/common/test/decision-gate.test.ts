import { createHash } from "node:crypto";
import { mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  consumeDecisionPermit,
  grantDecisionPermits,
  normalizeDecisionProposal,
  type DecisionProposal,
} from "../src/decision-gate";

async function repository(): Promise<{ root: string; file: string; hash: string }> {
  const root = await mkdtemp(join(tmpdir(), "ai-review-gate-"));
  const file = join(root, "src", "change.ts");
  await Bun.write(file, "export const value = 1;\n");
  const hash = createHash("sha256").update("export const value = 1;\n", "utf8").digest("hex");
  return { root, file, hash };
}

function proposal(root: string, hash: string): DecisionProposal {
  return {
    repositoryRoot: root,
    targets: [{ path: "src/change.ts", lineStart: 1, lineEnd: 1 }],
    judgment: "the change preserves the invariant",
    rationale: "the focused branch keeps the existing guard",
    checks: [],
    openQuestions: [],
  };
}

describe("decision gate", () => {
  test("normalizes a proposal with current target hashes and session defaults", async () => {
    const current = await repository();
    const normalized = await normalizeDecisionProposal(proposal(current.root, current.hash), {
      sessionId: "session-1",
    });

    expect(normalized.sessionId).toBe("session-1");
    expect(normalized.repositoryRoot).toBe(await realpath(current.root));
    expect(normalized.targets[0]?.contentHash).toBe(current.hash);
    expect(normalized.targets[0]?.revision).toEqual(normalized.revision);
  });

  test("grants a permit only after the record submission succeeds", async () => {
    const current = await repository();
    const normalized = await normalizeDecisionProposal(proposal(current.root, current.hash), {
      sessionId: "session-2",
    });
    const result = await grantDecisionPermits(normalized, {
      recordId: "record-2",
      gateRoot: join(current.root, ".gate-state"),
    });

    expect(result.permits).toBe(1);
    expect(await consumeDecisionPermit({
      sessionId: "session-2",
      repositoryRoot: current.root,
      filePath: current.file,
      gateRoot: join(current.root, ".gate-state"),
    })).toBe(true);
    expect(await consumeDecisionPermit({
      sessionId: "session-2",
      repositoryRoot: current.root,
      filePath: current.file,
      gateRoot: join(current.root, ".gate-state"),
    })).toBe(false);
  });

  test("rejects a permit when the target changed after the judgment", async () => {
    const current = await repository();
    const normalized = await normalizeDecisionProposal(proposal(current.root, current.hash), {
      sessionId: "session-3",
    });
    await grantDecisionPermits(normalized, {
      recordId: "record-3",
      gateRoot: join(current.root, ".gate-state"),
    });
    await writeFile(current.file, "export const value = 2;\n", "utf8");

    expect(await consumeDecisionPermit({
      sessionId: "session-3",
      repositoryRoot: current.root,
      filePath: current.file,
      gateRoot: join(current.root, ".gate-state"),
    })).toBe(false);
  });
  test("rejects a symlink target even when the link itself is inside the repository", async () => {
    const current = await repository();
    const outside = await mkdtemp(join(tmpdir(), "ai-review-outside-"));
    const outsideFile = join(outside, "outside.ts");
    await writeFile(outsideFile, "export const secret = true;\n", "utf8");
    const link = join(current.root, "src", "link.ts");
    await symlink(outsideFile, link);

    let rejected = false;
    try {
      await normalizeDecisionProposal({
        repositoryRoot: current.root,
        targets: [{ path: "src/link.ts", lineStart: 1, lineEnd: 1 }],
        judgment: "judgment",
        rationale: "rationale",
      }, { sessionId: "session-symlink" });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});
