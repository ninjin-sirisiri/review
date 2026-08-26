import { createHash } from "node:crypto";
import { mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  consumeDecisionPermit,
  grantDecisionPermits,
  likelyCodeMutation,
  normalizeDecisionProposal,
  peekDecisionPermit,
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

  test("accepts a new file whose parent directories do not exist yet", async () => {
    const current = await repository();
    const normalized = await normalizeDecisionProposal({
      repositoryRoot: current.root,
      targets: [{ path: "docs/nested/README.md", lineStart: 1 }],
      judgment: "documents the decision",
      rationale: "the file will be created by the gated edit",
    }, { sessionId: "session-new-dir" });

    const emptyHash = createHash("sha256").update("", "utf8").digest("hex");
    expect(normalized.targets[0]?.contentHash).toBe(emptyHash);

    await grantDecisionPermits(normalized, { recordId: "record-new-dir", gateRoot: join(current.root, ".gate-state") });
    const missingFile = join(current.root, "docs", "nested", "README.md");
    expect(await peekDecisionPermit({
      sessionId: "session-new-dir",
      repositoryRoot: current.root,
      filePath: missingFile,
      gateRoot: join(current.root, ".gate-state"),
    })).toBe(true);
  });

  test("still rejects paths that escape the repository through missing directories", async () => {
    const current = await repository();
    let rejected = false;
    try {
      await normalizeDecisionProposal({
        repositoryRoot: current.root,
        targets: [{ path: "../outside-new/README.md", lineStart: 1 }],
        judgment: "judgment",
        rationale: "rationale",
      }, { sessionId: "session-escape" });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  test("peeks at a permit without consuming it", async () => {
    const current = await repository();
    const normalized = await normalizeDecisionProposal(proposal(current.root, current.hash), { sessionId: "session-peek" });
    await grantDecisionPermits(normalized, { recordId: "record-peek", gateRoot: join(current.root, ".gate-state") });

    expect(await peekDecisionPermit({
      sessionId: "session-peek",
      repositoryRoot: current.root,
      filePath: current.file,
      gateRoot: join(current.root, ".gate-state"),
    })).toBe(true);
    expect(await peekDecisionPermit({
      sessionId: "session-peek",
      repositoryRoot: current.root,
      filePath: current.file,
      gateRoot: join(current.root, ".gate-state"),
    })).toBe(true);
    expect(await consumeDecisionPermit({
      sessionId: "session-peek",
      repositoryRoot: current.root,
      filePath: current.file,
      gateRoot: join(current.root, ".gate-state"),
    })).toBe(true);
    expect(await consumeDecisionPermit({
      sessionId: "session-peek",
      repositoryRoot: current.root,
      filePath: current.file,
      gateRoot: join(current.root, ".gate-state"),
    })).toBe(false);
  });
});

describe("likelyCodeMutation", () => {
  test("allows branch and worktree creation that does not rewrite history or files", () => {
    expect(likelyCodeMutation("git checkout -b feature/x")).toBe(false);
    expect(likelyCodeMutation("git checkout -B feature/x")).toBe(false);
    expect(likelyCodeMutation("git checkout --quiet -b feature/x main")).toBe(false);
    expect(likelyCodeMutation("git switch -c feature/x")).toBe(false);
    expect(likelyCodeMutation("git switch main")).toBe(false);
    expect(likelyCodeMutation("git worktree add ../review-wt main")).toBe(false);
    expect(likelyCodeMutation("git worktree list")).toBe(false);
    expect(likelyCodeMutation("git status && git checkout -b feature/y && bun test")).toBe(false);
  });

  test("still blocks file-restoring and history-rewriting git operations", () => {
    expect(likelyCodeMutation("git checkout -- src/change.ts")).toBe(true);
    expect(likelyCodeMutation("git checkout src/change.ts")).toBe(true);
    expect(likelyCodeMutation("git restore src/change.ts")).toBe(true);
    expect(likelyCodeMutation("git reset --hard HEAD~1")).toBe(true);
    expect(likelyCodeMutation("git rebase main")).toBe(true);
    expect(likelyCodeMutation("git merge feature/x")).toBe(true);
    expect(likelyCodeMutation("git apply patch.diff")).toBe(true);
    expect(likelyCodeMutation("git worktree remove ../review-wt")).toBe(true);
    expect(likelyCodeMutation("git switch --discard-changes main")).toBe(true);
    expect(likelyCodeMutation("git switch -f main")).toBe(true);
    expect(likelyCodeMutation("git checkout -q main")).toBe(true);
    expect(likelyCodeMutation("git checkout -b feature/z && echo done > src/change.ts")).toBe(true);
  });

  test("does not treat /dev/null redirects as mutations while real redirects stay blocked", () => {
    expect(likelyCodeMutation("bun test 2>/dev/null")).toBe(false);
    expect(likelyCodeMutation("grep pattern src/change.ts >/dev/null")).toBe(false);
    expect(likelyCodeMutation("bun run build > /dev/null 2>&1")).toBe(false);
    expect(likelyCodeMutation("echo hi >> /dev/null")).toBe(false);
    expect(likelyCodeMutation("bun test > results.txt")).toBe(true);
    expect(likelyCodeMutation("echo note 2> error.log")).toBe(true);
    expect(likelyCodeMutation("cat input | tee copy.txt")).toBe(true);
  });
});
