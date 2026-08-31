export interface FileTreeNode {
  name: string;
  /** Root-relative POSIX path; "" for the synthetic root. */
  path: string;
  isFile: boolean;
  decisionCount: number;
  children: FileTreeNode[];
}

export function buildFileTree(paths: string[], decisionCounts: ReadonlyMap<string, number> = new Map()): FileTreeNode {
  const root: FileTreeNode = { name: "", path: "", isFile: false, decisionCount: 0, children: [] };
  for (const path of paths) {
    const segments = path.split("/");
    let node = root;
    segments.forEach((segment, index) => {
      const isFile = index === segments.length - 1;
      const nodePath = index === 0 ? segment : `${node.path}/${segment}`;
      let child = node.children.find((candidate) => candidate.name === segment && candidate.isFile === isFile);
      if (child === undefined) {
        child = { name: segment, path: nodePath, isFile, decisionCount: 0, children: [] };
        node.children.push(child);
      }
      if (isFile) child.decisionCount = decisionCounts.get(path) ?? 0;
      node = child;
    });
  }
  const sortChildren = (node: FileTreeNode): void => {
    node.children.sort((a, b) => (a.isFile === b.isFile ? a.name.localeCompare(b.name) : a.isFile ? 1 : -1));
    node.children.forEach(sortChildren);
  };
  sortChildren(root);
  return root;
}

/** Directories that would be empty after dropping files without judgments are omitted. */
export function filterTreeToDecisions(node: FileTreeNode): FileTreeNode {
  if (node.isFile) return node;
  const children: FileTreeNode[] = [];
  for (const child of node.children) {
    if (child.isFile) {
      if (child.decisionCount > 0) children.push(child);
      continue;
    }
    const filtered = filterTreeToDecisions(child);
    if (filtered.children.length > 0) children.push(filtered);
  }
  return { ...node, children };
}

export function treeHasDecisions(node: FileTreeNode): boolean {
  if (node.isFile) return node.decisionCount > 0;
  return node.children.some(treeHasDecisions);
}
