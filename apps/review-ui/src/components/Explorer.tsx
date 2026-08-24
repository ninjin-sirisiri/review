import { useState } from "react";
import type { FileTreeNode } from "../lib/file-tree";

export interface ExplorerProps {
  tree: FileTreeNode;
  selectedPath: string | null;
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
  /** ファイル行クリック。引数はルート相対のフルパス。 */
  onOpenFile: (path: string) => void;
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
          onClick={() => onToggleDir(item.path)}
        >
          <span className="explorer__chevron" aria-hidden="true">
            {isCollapsed ? "▸" : "▾"}
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

  function toggleDir(path: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <nav className="explorer" aria-label="Repository explorer">
      <h2 className="explorer__title">Explorer</h2>
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
      ) : (
        <ul className="explorer__root">
          {tree.children.map((child) => (
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
    </nav>
  );
}
