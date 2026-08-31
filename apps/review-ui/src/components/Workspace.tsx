import { useEffect, useRef, useState } from "react";
import type { FileDiff } from "../../../../packages/contracts/src/index";
import type { ReviewApiError, DecisionRecordDetail, SnapshotDiff, UserDisposition } from "../api";
import type { FileTreeNode } from "../lib/file-tree";
import type { DecisionAnchor, BlockSelection } from "../lib/decision-index";
import type { JudgmentEntry } from "./JudgmentPanel";
import { Explorer } from "./Explorer";
import { DiffView } from "./DiffView";
import { JudgmentPanel } from "./JudgmentPanel";

export interface WorkspaceProps {
  tree: FileTreeNode;
  selectedPath: string | null;
  explorerIsLoading: boolean;
  explorerError: Error | null;
  onExplorerRetry: () => void;
  onOpenFile: (path: string) => void;
  fileIsLoading: boolean;
  fileError: ReviewApiError | Error | null;
  /** spec §4.3-3: 選択ファイルのdiff baseが解決不能(未誕生HEAD)。 */
  fileBaseMissing: boolean;
  diff: FileDiff | null;
  fullText: { content: string; anchors: DecisionAnchor[] } | null;
  onFileRetry: () => void;
  judgments: JudgmentEntry[];
  anchors: DecisionAnchor[];
  transitionAnchors: DecisionAnchor[];
  selectedRecordId: string | null;
  onSelectJudgment: (recordId: string) => void;
  snapshotDiff: SnapshotDiff | null;
  snapshotDiffLoading: boolean;
  snapshotDiffError: ReviewApiError | Error | null;
  onDispositionChange: (recordId: string, disposition: UserDisposition) => Promise<DecisionRecordDetail>;
  onJudgmentRetry: (recordId: string) => void;
}

export function Workspace(props: WorkspaceProps) {
  const {
    tree,
    selectedPath,
    explorerIsLoading,
    explorerError,
    onExplorerRetry,
    onOpenFile,
    fileIsLoading,
    fileError,
    fileBaseMissing,
    diff,
    fullText,
    onFileRetry,
    judgments,
    anchors,
    transitionAnchors,
    selectedRecordId,
    onSelectJudgment,
    snapshotDiff,
    snapshotDiffLoading,
    snapshotDiffError,
    onDispositionChange,
    onJudgmentRetry,
  } = props;

  const [selectedBlock, setSelectedBlock] = useState<BlockSelection | null>(null);
  const [navigateTo, setNavigateTo] = useState<{ line: number; token: number } | null>(null);
  const navigationToken = useRef(0);
  const transitionActive = snapshotDiff !== null || snapshotDiffLoading || snapshotDiffError !== null;

  useEffect(() => {
    setSelectedBlock(null);
  }, [selectedPath, selectedRecordId, snapshotDiff, snapshotDiffLoading, snapshotDiffError]);

  function handleTargetClick(path: string, line: number) {
    if (path !== selectedPath) return;
    navigationToken.current += 1;
    setNavigateTo({ line, token: navigationToken.current });
  }

  return (
    <main id="review-workspace" className="workspace" tabIndex={-1}>
      <Explorer
        tree={tree}
        selectedPath={selectedPath}
        isLoading={explorerIsLoading}
        error={explorerError}
        onRetry={onExplorerRetry}
        onOpenFile={onOpenFile}
      />
      <DiffView
        path={selectedPath}
        isLoading={fileIsLoading}
        error={fileError}
        baseMissing={fileBaseMissing}
        diff={diff}
        anchors={anchors}
        transitionAnchors={transitionAnchors}
        snapshotDiff={snapshotDiff}
        snapshotDiffLoading={snapshotDiffLoading}
        snapshotDiffError={snapshotDiffError}
        selectedBlock={selectedBlock}
        onSelectBlock={setSelectedBlock}
        fullText={fullText}
        navigateTo={navigateTo}
        onRetry={onFileRetry}
      />
      <JudgmentPanel
        path={selectedPath}
        entries={judgments}
        transitionActive={transitionActive}
        selectedRecordId={selectedRecordId}
        onSelectJudgment={onSelectJudgment}
        selectedBlock={selectedBlock}
        onSelectBlock={setSelectedBlock}
        onDispositionChange={onDispositionChange}
        onRetry={onJudgmentRetry}
        onTargetClick={handleTargetClick}
      />
    </main>
  );
}
