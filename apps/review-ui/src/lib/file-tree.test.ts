import { describe, expect, it } from "vitest";
import { buildFileTree, filterTreeToDecisions, treeHasDecisions } from "./file-tree";

describe("buildFileTree", () => {
  it("converts a flat sorted path list into a nested tree with directories first", () => {
    const root = buildFileTree(["src/api.ts", "src/components/App.tsx", "README.md"]);

    expect(root.isFile).toBe(false);
    expect(root.children.map((child) => child.name)).toEqual(["src", "README.md"]);
    const src = root.children[0]!;
    expect(src.isFile).toBe(false);
    expect(src.children.map((child) => child.name)).toEqual(["components", "api.ts"]);
    const components = src.children[0]!;
    expect(components.children[0]!.path).toBe("src/components/App.tsx");
    expect(components.children[0]!.isFile).toBe(true);
    expect(root.children[1]!.path).toBe("README.md");
  });

  it("attaches decision counts to file nodes and leaves directories at zero", () => {
    const counts = new Map([["src/api.ts", 3]]);
    const root = buildFileTree(["src/api.ts", "src/util.ts"], counts);

    const api = root.children[0]!.children[0]!;
    expect(api.decisionCount).toBe(3);
    expect(root.children[0]!.children[1]!.decisionCount).toBe(0);
    expect(root.decisionCount).toBe(0);
  });

  it("returns an empty root for an empty path list", () => {
    const root = buildFileTree([]);
    expect(root.children).toEqual([]);
  });
});

describe("filterTreeToDecisions", () => {
  it("keeps files with judgments and prunes empty directories", () => {
    const counts = new Map([["src/api.ts", 2], ["README.md", 1]]);
    const root = buildFileTree(["src/api.ts", "src/util.ts", "docs/guide.md", "README.md"], counts);
    const filtered = filterTreeToDecisions(root);

    expect(filtered.children.map((child) => child.name)).toEqual(["src", "README.md"]);
    expect(filtered.children[0]!.children.map((child) => child.name)).toEqual(["api.ts"]);
    expect(treeHasDecisions(root)).toBe(true);
    expect(treeHasDecisions(buildFileTree(["src/util.ts"]))).toBe(false);
  });
});
