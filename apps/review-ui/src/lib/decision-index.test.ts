import { describe, expect, it } from "vitest";
import type { DecisionRecordDetail, DecisionRecordSummary, SourceReferenceData } from "../api";
import { buildDecisionIndex, decisionAnchors, diffBaseFor, overlapsBlock, targetAnchor, transitionAnchors } from "./decision-index";

function summary(recordId: string, overrides: Partial<DecisionRecordSummary> = {}): DecisionRecordSummary {
  return {
    record_id: recordId,
    session_id: `session-${recordId}`,
    repository_id: "repo-1",
    agent_type: "codex",
    revision: { kind: "commit", sha: `sha-${recordId}` },
    targets: [
      { repository_id: "repo-1", path: "src/a.ts", line_start: 10, line_end: 12, revision: { kind: "commit", sha: `sha-${recordId}` }, content_hash: "hash-a" },
      { repository_id: "repo-1", path: "src/b.ts", line_start: 1, line_end: 2, revision: { kind: "commit", sha: `sha-${recordId}` }, content_hash: "hash-b" },
    ],
    judgment: `judgment ${recordId}`,
    created_at: "2026-08-20T10:00:00.000Z",
    user_disposition: "unreviewed",
    ...overrides,
  };
}

describe("buildDecisionIndex", () => {
  it("groups decisions per target path newest first without duplicates", () => {
    const older = summary("older", { created_at: "2026-08-19T00:00:00.000Z" });
    const newer = summary("newer", { created_at: "2026-08-21T00:00:00.000Z" });
    const index = buildDecisionIndex([older, newer]);

    expect(index.get("src/a.ts")).toEqual([newer, older]);
    expect(index.get("src/b.ts")).toEqual([newer, older]);
    expect(index.has("src/missing.ts")).toBe(false);
  });

  it("keeps a decision listed once when several targets share a path", () => {
    const duplicated = summary("dup");
    duplicated.targets.push({ ...duplicated.targets[0]! });
    const index = buildDecisionIndex([duplicated]);

    expect(index.get("src/a.ts")).toHaveLength(1);
  });
});

describe("targetAnchor", () => {
  const commitTarget = {
    repository_id: "repo-1",
    path: "src/a.ts",
    line_start: 4,
    line_end: 6,
    revision: { kind: "commit" as const, sha: "abc" },
    content_hash: "expected",
  };

  it("anchors commit-revision targets to the old side without source verification", () => {
    const source: SourceReferenceData = {
      state: "hash-mismatch",
      repository_id: "repo-1",
      path: "src/a.ts",
      revision: { kind: "commit", sha: "abc" },
      target: commitTarget,
      expected_hash: "expected",
    };
    expect(targetAnchor(source)).toEqual({ side: "old", start: 4, end: 6 });
  });

  it("anchors verified working-tree targets to the new side", () => {
    const resolved: SourceReferenceData = {
      state: "resolved",
      repository_id: "repo-1",
      path: "src/a.ts",
      revision: { kind: "working-tree", contentHash: "h1" },
      target: { ...commitTarget, revision: { kind: "working-tree", contentHash: "h1" } },
      content: "code",
      content_hash: "expected",
    };
    expect(targetAnchor(resolved)).toEqual({ side: "new", start: 4, end: 6 });

    const snapshot: SourceReferenceData = { ...resolved, state: "snapshot-resolved" };
    expect(targetAnchor(snapshot)).toEqual({ side: "new", start: 4, end: 6 });
  });

  it.each([
    ["hash-mismatch"],
    ["revision-not-found"],
    ["source-unavailable"],
  ] as const)("returns no anchor for an unverified %s working-tree source", (state) => {
    const source: SourceReferenceData = {
      state,
      repository_id: "repo-1",
      path: "src/a.ts",
      revision: { kind: "working-tree", contentHash: "h1" },
      target: { ...commitTarget, revision: { kind: "working-tree", contentHash: "h1" } },
      expected_hash: "expected",
    };
    expect(targetAnchor(source)).toBeNull();
  });

  it("collects only non-null anchors in target order", () => {
    const detail: DecisionRecordDetail = {
      record: { ...summary("r1"), rationale: "", checks: [], open_questions: [] },
      sources: [
        { state: "resolved", repository_id: "repo-1", path: "src/a.ts", revision: { kind: "commit", sha: "abc" }, target: commitTarget, content: "x", content_hash: "expected" },
        { state: "hash-mismatch", repository_id: "repo-1", path: "src/b.ts", revision: { kind: "working-tree", contentHash: "h" }, target: { ...commitTarget, path: "src/b.ts", revision: { kind: "working-tree", contentHash: "h" } }, expected_hash: "expected" },
      ],
    };
    expect(decisionAnchors(detail)).toEqual([{ side: "old", start: 4, end: 6 }]);
  });
});

describe("overlapsBlock", () => {
  it("matches old-side anchors strictly against the old range of the block", () => {
    const anchor = { side: "old" as const, start: 5, end: 7 };
    expect(overlapsBlock(anchor, { oldStart: 5, oldEnd: 9, newStart: null, newEnd: null })).toBe(true);
    expect(overlapsBlock(anchor, { oldStart: 8, oldEnd: 9, newStart: null, newEnd: null })).toBe(false);
    // pure-add blocks expose no old range
    expect(overlapsBlock(anchor, { oldStart: null, oldEnd: null, newStart: 5, newEnd: 9 })).toBe(false);
  });

  it("matches new-side anchors strictly against the new range of the block", () => {
    const anchor = { side: "new" as const, start: 2, end: 3 };
    expect(overlapsBlock(anchor, { oldStart: null, oldEnd: null, newStart: 1, newEnd: 2 })).toBe(true);
    expect(overlapsBlock(anchor, { oldStart: 1, oldEnd: 4, newStart: null, newEnd: null })).toBe(false);
    expect(overlapsBlock(anchor, { oldStart: null, oldEnd: null, newStart: 4, newEnd: 6 })).toBe(false);
  });
});

describe("transitionAnchors", () => {
  it("maps only the selected path targets to the old side", () => {
    const detail: DecisionRecordDetail = {
      record: {
        ...summary("transition"),
        rationale: "",
        checks: [],
        open_questions: [],
      },
      sources: [],
    };

    expect(transitionAnchors(detail, "src/a.ts")).toEqual([
      { side: "old", start: 10, end: 12 },
    ]);
  });
});

describe("diffBaseFor", () => {
  it("uses the newest commit-revision decision covering the file", () => {
    const decisions = [
      summary("older", { created_at: "2026-08-19T00:00:00.000Z" }),
      summary("newer", { created_at: "2026-08-21T00:00:00.000Z", revision: { kind: "commit", sha: "sha-newer" } }),
      summary("worktree", { created_at: "2026-08-22T00:00:00.000Z", revision: { kind: "working-tree", contentHash: "h" } }),
    ];
    expect(diffBaseFor(decisions)).toBe("sha-newer");
  });

  it("falls back to HEAD when no commit-revision decision exists", () => {
    expect(diffBaseFor([])).toBe("HEAD");
    expect(diffBaseFor([summary("w", { revision: { kind: "working-tree", contentHash: "h" } })])).toBe("HEAD");
  });
});
