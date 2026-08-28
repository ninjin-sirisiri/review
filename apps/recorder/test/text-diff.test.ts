import { describe, expect, test } from "bun:test";
import { ERROR_CODES } from "../../../packages/contracts/src/index";
import { diffText, TextDiffError } from "../src/source/text-diff";

describe("text diff", () => {
  test("returns the existing three-line-context hunk model", () => {
    const result = diffText(
      "src/example.ts",
      "line 1\nline 2\nline 3\nline 4\nline 5\n",
      "line 1\nchanged 2\nline 3\nline 4\nline 5\n",
      { maxWork: 100_000 },
    );

    expect(result.binary).toBe(false);
    expect(result.hunks).toEqual([
      {
        oldStart: 1,
        newStart: 1,
        lines: [
          { type: "context", oldLine: 1, newLine: 1, content: "line 1" },
          { type: "del", oldLine: 2, newLine: null, content: "line 2" },
          { type: "add", oldLine: null, newLine: 2, content: "changed 2" },
          { type: "context", oldLine: 3, newLine: 3, content: "line 3" },
          { type: "context", oldLine: 4, newLine: 4, content: "line 4" },
          { type: "context", oldLine: 5, newLine: 5, content: "line 5" },
        ],
      },
    ]);
  });

  test("uses zero lines for an empty side rather than a phantom empty line", () => {
    const result = diffText("created.ts", "", "created\n", { maxWork: 100_000 });

    expect(result.binary).toBe(false);
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]?.lines).toEqual([
      { type: "add", oldLine: null, newLine: 1, content: "created" },
      { type: "add", oldLine: null, newLine: 2, content: "" },
    ]);
  });

  test("returns binary content without hunks", () => {
    expect(diffText("blob.bin", "before\0", "after\0", { maxWork: 100_000 })).toEqual({
      binary: true,
      hunks: [],
    });
  });

  test("returns no hunk for identical content", () => {
    expect(diffText("same.ts", "same\n", "same\n", { maxWork: 100_000 })).toEqual({
      binary: false,
      hunks: [],
    });
  });

  test("throws PAYLOAD_TOO_LARGE when the diff work budget is exhausted", () => {
    expect(() => diffText("dense.ts", ["old", "old", "old"].join("\n"), ["new", "new", "new"].join("\n"), { maxWork: 1 })).toThrow(
      expect.objectContaining({
        name: "TextDiffError",
        code: ERROR_CODES.PAYLOAD_TOO_LARGE,
      }),
    );
    expect(() => diffText("dense.ts", "old", "new", { maxWork: 1 })).toThrow(TextDiffError);
  });

  test("throws PAYLOAD_TOO_LARGE when the rendered diff exceeds its output-byte budget", () => {
    const options = { maxWork: 100_000, maxOutputBytes: 64 } as never;

    expect(() => diffText("large.ts", "a".repeat(100), "b".repeat(100), options)).toThrow(
      expect.objectContaining({
        name: "TextDiffError",
        code: ERROR_CODES.PAYLOAD_TOO_LARGE,
      }),
    );
  });
});
