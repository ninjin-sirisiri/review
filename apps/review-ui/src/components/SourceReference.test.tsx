import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SourceReference } from "./SourceReference";
import type { SourceReferenceData } from "../api";

const target = {
  repository_id: "repo-1",
  path: "src/example.ts",
  line_start: 4,
  line_end: 5,
  revision: { kind: "commit" as const, sha: "abc123" },
  content_hash: "expected-hash",
};

describe("SourceReference", () => {
  it("renders resolved source as escaped text with line numbers and revision metadata", () => {
    const source: SourceReferenceData = {
      state: "resolved",
      repository_id: "repo-1",
      path: "src/example.ts",
      revision: { kind: "commit", sha: "abc123" },
      target,
      content: "const html = \"<script>alert('unsafe')</script>\";\nreturn html;",
      content_hash: "expected-hash",
    };

    render(<SourceReference source={source} />);

    expect(screen.getByRole("heading", { name: "src/example.ts" })).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.getByText("const html = \"<script>alert('unsafe')</script>\";")).toBeTruthy();
    expect(screen.getByText(/commit abc123/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    ["hash-mismatch", "Source changed since the decision"],
    ["revision-not-found", "The recorded revision is no longer available"],
    ["source-unavailable", "Source is unavailable"],
  ] as const)("renders the %s state without showing fallback code", (state, message) => {
    const source: SourceReferenceData = {
      state,
      repository_id: "repo-1",
      path: "src/example.ts",
      revision: { kind: "commit", sha: "abc123" },
      target,
      expected_hash: "expected-hash",
      actual_hash: state === "hash-mismatch" ? "actual-hash" : undefined,
      message: "The requested historical source cannot be trusted.",
    };

    render(<SourceReference source={source} />);

    const alert = screen.getAllByRole("alert").at(-1);
    expect(alert?.textContent).toContain(message);
    expect(screen.getAllByText("The requested historical source cannot be trusted.").at(-1)).toBeTruthy();
    expect(screen.queryAllByText(/const html/)).toHaveLength(0);
  });
});
