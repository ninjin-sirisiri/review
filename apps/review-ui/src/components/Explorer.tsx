import { useState } from "react";
import type { FileTreeNode } from "../lib/file-tree";
import { filterTreeToDecisions, treeHasDecisions } from "../lib/file-tree";

export interface ExplorerProps {
  tree: FileTreeNode;
  selectedPath: string | null;
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
  /** ファイル行クリック。引数はルート相対のフルパス。 */
  onOpenFile: (path: string) => void;
}

function fileLabel(item: FileTreeNode): string {
  if (item.decisionCount <= 0) return item.name;
  const unit = item.decisionCount === 1 ? "decision" : "decisions";
  return `${item.name}, ${item.decisionCount} ${unit}`;
}

function TreeItem(props: {
  item: FileTreeNode;
  selectedPath: string | null;
  collapsed: ReadonlySet<string>;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const { item, selectedPath, collapsed, onToggleDir, onOpenFile } = props;

  if (!item.isFile) {
    const isCollapsed = collapsed.has(item.path);
    return (
      <li className="explorer__item">
        <button
          type="button"
          className="explorer__dir"
          aria-expanded={!isCollapsed}
          title={item.path}
          onClick={() => onToggleDir(item.path)}
        >
          <span className="explorer__chevron" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="12" height="12">
              <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span>{item.name}</span>
        </button>
        {!isCollapsed && (
          <ul className="explorer__group">
            {item.children.map((child) => (
              <TreeItem
                key={child.path}
                item={child}
                selectedPath={selectedPath}
                collapsed={collapsed}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <li className="explorer__item">
      <button
        type="button"
        className="explorer__file"
        aria-current={selectedPath === item.path || undefined}
        aria-label={fileLabel(item)}
        title={item.path}
        onClick={() => onOpenFile(item.path)}
      >
        <span className="explorer__name">{item.name}</span>
        {item.decisionCount > 0 && <span className="explorer__badge">{item.decisionCount}</span>}
      </button>
    </li>
  );
}

export function Explorer({ tree, selectedPath, isLoading, error, onRetry, onOpenFile }: ExplorerProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [judgmentsOnly, setJudgmentsOnly] = useState(false);
  const canFilter = treeHasDecisions(tree);
  const visibleTree = judgmentsOnly ? filterTreeToDecisions(tree) : tree;

  function toggleDir(path: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <nav className="explorer" aria-label="Repository explorer" aria-busy={isLoading || undefined}>
      <div className="pane-header">
        <div className="explorer__toolbar">
          <h2 className="explorer__title">Explorer</h2>
          <button
            type="button"
            className="explorer__filter"
            aria-pressed={judgmentsOnly}
            disabled={!canFilter}
            onClick={() => setJudgmentsOnly((current) => !current)}
          >
            With judgments
          </button>
        </div>
      </div>
      <div className="pane-body">
        {error !== null ? (
          <div className="inline-error" role="alert">
            <p>{error.message}</p>
            <button type="button" onClick={onRetry}>
              Retry
            </button>
          </div>
        ) : isLoading ? (
          <p role="status" className="empty-state">
            Loading repository tree…
          </p>
        ) : tree.children.length === 0 ? (
          <p className="empty-state">No tracked files found.</p>
        ) : visibleTree.children.length === 0 ? (
          <p className="empty-state">No files with judgments.</p>
        ) : (
          <ul className="explorer__root">
            {visibleTree.children.map((child) => (
              <TreeItem
                key={child.path}
                item={child}
                selectedPath={selectedPath}
                collapsed={collapsed}
                onToggleDir={toggleDir}
                onOpenFile={onOpenFile}
              />
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
}
