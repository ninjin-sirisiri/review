import { useMemo, useRef, useState } from "react";
import {
  ReviewApi,
  ReviewApiError,
  type DecisionRecordDetail,
  type DecisionRecordSummary,
  type FileDiff,
  type RegisteredRepositorySummary,
  type SnapshotDiff,
  type SnapshotDiffResponse,
  type UserDisposition,
} from "./api";
import { BootstrapScreen } from "./components/BootstrapScreen";
import { ThemeToggle } from "./components/ThemeToggle";
import { Workspace } from "./components/Workspace";
import type { JudgmentEntry } from "./components/JudgmentPanel";
import type { DecisionAnchor } from "./lib/decision-index";
import { buildDecisionIndex, decisionAnchors, diffBaseFor, transitionAnchors } from "./lib/decision-index";
import { buildFileTree } from "./lib/file-tree";
import "./styles.css";

export interface AppProps {
  apiFactory?: (token: string) => ReviewApi;
}

function apiMessage(error: unknown): string {
  if (error instanceof ReviewApiError) {
    if (error.code === "UNAUTHORIZED" || error.status === 401) return "Owner token required or not accepted by Recorder.";
    return error.message;
  }
  return error instanceof Error ? error.message : "Recorder request failed";
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(apiMessage(error));
}

function assertSnapshotResponseMatchesSelection(result: SnapshotDiffResponse, path: string): SnapshotDiffResponse {
  if (result.path !== path) {
    throw new ReviewApiError("Recorder returned a snapshot transition that does not match the requested snapshot transition", {
      code: "INVALID_RESPONSE",
    });
  }
  return result;
}

function assertSnapshotTransitionMatchesSelection(result: SnapshotDiff, recordId: string, path: string): SnapshotDiff {
  const destinationMatches = result.to.kind === "working-tree" || result.to.source_path === path;
  if (result.path !== path || result.from.record_id !== recordId || result.from.source_path !== path || !destinationMatches) {
    throw new ReviewApiError("Recorder returned a snapshot transition that does not match the requested snapshot transition", {
      code: "INVALID_RESPONSE",
    });
  }
  return result;
}

function currentPathEvidence(
  entries: Iterable<JudgmentEntry>,
  path: string | null,
): { anchors: DecisionAnchor[]; fullText: { content: string; anchors: DecisionAnchor[] } | null } {
  if (path === null) return { anchors: [], fullText: null };

  const anchors: DecisionAnchor[] = [];
  let fullText: { content: string; anchors: DecisionAnchor[] } | null = null;
  for (const entry of entries) {
    if (entry.status !== "ready" || entry.detail === undefined) continue;
    const sources = entry.detail.sources.filter((source) => source.path === path);
    if (sources.length === 0) continue;

    const detail = sources.length === entry.detail.sources.length
      ? entry.detail
      : { ...entry.detail, sources };
    const entryAnchors = decisionAnchors(detail);
    anchors.push(...entryAnchors);

    if (fullText === null) {
      const source = sources.find((candidate) => candidate.state === "resolved" || candidate.state === "snapshot-resolved");
      if (source !== undefined && "content" in source) {
        fullText = { content: source.content, anchors: entryAnchors };
      }
    }
  }

  return { anchors, fullText };
}

export function App({ apiFactory = (token) => new ReviewApi(token) }: AppProps) {
  const [tokenInput, setTokenInput] = useState("");
  const [repositories, setRepositories] = useState<RegisteredRepositorySummary[] | null>(null);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState("");
  const [api, setApi] = useState<ReviewApi | null>(null);
  const [repositoryId, setRepositoryId] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<DecisionRecordSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Explorer state
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [explorerIsLoading, setExplorerIsLoading] = useState(false);
  const [explorerError, setExplorerError] = useState<Error | null>(null);

  // Open-file state
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileIsLoading, setFileIsLoading] = useState(false);
  const [fileError, setFileError] = useState<ReviewApiError | Error | null>(null);
  // spec §4.3-3: base=HEADのREVISION_NOT_FOUNDは未誕生HEAD(コミットゼロ)を意味する。エラーではなく
  // 「比較対象なし」状態として別扱いする。baseが記録済みSHAのときは従来どおりfileErrorになる。
  const [fileBaseMissing, setFileBaseMissing] = useState(false);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [snapshotDiff, setSnapshotDiff] = useState<SnapshotDiff | null>(null);
  const [snapshotDiffLoading, setSnapshotDiffLoading] = useState(false);
  const [snapshotDiffError, setSnapshotDiffError] = useState<ReviewApiError | Error | null>(null);
  const [recordStates, setRecordStates] = useState<Record<string, JudgmentEntry>>({});
  // M31: openFileが進める単調トークン。後発のファイル選択は先行ロードの非同期完了を無効化し、
  // 遅れて着いた応答が新しい選択の状態を上書きしないようにする。
  const requestTokenRef = useRef(0);
  const sessionGenerationRef = useRef(0);
  const snapshotRequestTokenRef = useRef(0);

  const decisionIndex = useMemo(() => buildDecisionIndex(decisions), [decisions]);
  const tree = useMemo(() => {
    const counts = new Map<string, number>();
    for (const [path, list] of decisionIndex) counts.set(path, list.length);
    const known = new Set<string>(filePaths);
    for (const path of decisionIndex.keys()) known.add(path);
    return buildFileTree([...known].sort((a, b) => a.localeCompare(b)), counts);
  }, [filePaths, decisionIndex]);

  // JudgmentPanelのブロック絞り込みはside/linesのみでパスを見ない(M19)。ほかのファイルの
  // 意思決定が現在ファイルのブロック選択で消えないよう、ここで必ず選択ファイル分だけに限定する。
  const judgments: JudgmentEntry[] = useMemo(() => {
    if (selectedPath === null) return [];
    return (decisionIndex.get(selectedPath) ?? []).flatMap((summary) => {
      const entry = recordStates[summary.record_id];
      return entry ? [entry] : [];
    });
  }, [selectedPath, decisionIndex, recordStates]);

  const evidence = useMemo(
    () => currentPathEvidence(Object.values(recordStates), selectedPath),
    [recordStates, selectedPath],
  );

  const selectedTransitionAnchors = selectedRecordId !== null && selectedPath !== null
    ? (() => {
        const entry = recordStates[selectedRecordId];
        return entry?.status === "ready" && entry.detail !== undefined
          ? transitionAnchors(entry.detail, selectedPath)
          : [];
      })()
    : [];

  async function handleSubmit() {
    setError(null);
    const token = tokenInput.trim();
    if (token.length === 0) {
      setError("Owner bearer token is required.");
      return;
    }

    const sessionGeneration = ++sessionGenerationRef.current;
    setIsLoading(true);
    try {
      if (repositories === null) {
        const client = apiFactory(token);
        const found = await client.listRepositories();
        if (sessionGenerationRef.current !== sessionGeneration) return;
        setApi(client);
        setRepositories(found);
        if (found.length === 1) setSelectedRepositoryId(found[0].repository_id);
        return;
      }

      const repository = selectedRepositoryId.trim();
      if (repository.length === 0 || !repositories.some((candidate) => candidate.repository_id === repository)) {
        setError("Select a registered repository.");
        return;
      }

      const client = api ?? apiFactory(tokenInput.trim());
      const records = await client.listDecisions(repository);
      if (sessionGenerationRef.current !== sessionGeneration) return;
      setApi(client);
      setRepositoryId(repository);
      setDecisions(records);
      if (sessionGenerationRef.current !== sessionGeneration) return;
      await loadFiles(client, repository, sessionGeneration);
    } catch (requestError) {
      if (sessionGenerationRef.current !== sessionGeneration) return;
      if (repositories === null) {
        setApi(null);
        setRepositories(null);
      }
      setError(apiMessage(requestError));
    } finally {
      if (sessionGenerationRef.current === sessionGeneration) setIsLoading(false);
    }
  }

  async function loadFiles(client: ReviewApi, repository: string, sessionGeneration: number) {
    const fileToken = requestTokenRef.current;
    const isCurrent = () =>
      sessionGenerationRef.current === sessionGeneration && requestTokenRef.current === fileToken;
    if (!isCurrent()) return;
    setExplorerIsLoading(true);
    setExplorerError(null);
    try {
      const data = await client.listRepositoryFiles(repository);
      if (!isCurrent()) return;
      setFilePaths(data.paths);
    } catch (requestError) {
      if (!isCurrent()) return;
      setExplorerError(asError(requestError));
    } finally {
      if (isCurrent()) setExplorerIsLoading(false);
    }
  }

  async function openFile(path: string) {
    if (api === null || repositoryId === null) return;
    const token = ++requestTokenRef.current;
    resetSnapshotTransition();
    setSelectedPath(path);

    const related = decisionIndex.get(path) ?? [];
    const base = diffBaseFor(related);
    setFileIsLoading(true);
    setFileError(null);
    setFileBaseMissing(false);
    setDiff(null);
    setRecordStates(Object.fromEntries(
      related.map((summary) => [summary.record_id, { recordId: summary.record_id, status: "loading" as const }]),
    ));

    const diffAttempt = api.getFileDiff(repositoryId, path, base).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const detailAttempts = related.map((summary) =>
      api.getDecision(summary.record_id).then(
        (value) => ({ id: summary.record_id, ok: true as const, value }),
        (error: unknown) => ({ id: summary.record_id, ok: false as const, error }),
      ),
    );
    const [diffResult, details] = await Promise.all([diffAttempt, Promise.all(detailAttempts)]);

    // トークンが進んでいれば、この完了は後発のファイル選択に負けている。何も状態を触らず破棄する。
    if (requestTokenRef.current !== token) return;

    if (diffResult.ok) {
      setDiff(diffResult.value);
    } else if (
      base === "HEAD" &&
      diffResult.error instanceof ReviewApiError &&
      diffResult.error.code === "REVISION_NOT_FOUND"
    ) {
      // base=HEADのREVISION_NOT_FOUNDは未誕生HEADのみで起こる。記録済みSHAが消えた場合とは
      // 区別し、DiffViewには「比較対象なし」の空状態(または解決済み全文)を表示する(spec §4.3-3)。
      setFileBaseMissing(true);
    } else {
      setFileError(diffResult.error instanceof ReviewApiError || diffResult.error instanceof Error
        ? diffResult.error
        : asError(diffResult.error));
    }

    const nextStates: Record<string, JudgmentEntry> = {};
    for (const attempt of details) {
      if (attempt.ok) {
        nextStates[attempt.id] = { recordId: attempt.id, status: "ready", detail: attempt.value };
      } else {
        nextStates[attempt.id] = { recordId: attempt.id, status: "error", message: apiMessage(attempt.error) };
      }
    }
    setRecordStates(nextStates);

    setFileIsLoading(false);
  }

  async function selectJudgment(recordId: string, force = false) {
    if (api === null || selectedPath === null) return;
    const currentPathRecords = decisionIndex.get(selectedPath) ?? [];
    if (!currentPathRecords.some((summary) => summary.record_id === recordId)) return;
    if (!force && selectedRecordId === recordId) {
      resetSnapshotTransition();
      return;
    }

    const path = selectedPath;
    const token = ++snapshotRequestTokenRef.current;
    setSelectedRecordId(recordId);
    setSnapshotDiff(null);
    setSnapshotDiffError(null);
    setSnapshotDiffLoading(true);
    try {
      const result = assertSnapshotResponseMatchesSelection(await api.getSnapshotDiff(recordId, path), path);
      if (snapshotRequestTokenRef.current !== token) return;
      if (result.state === "snapshot-resolved") {
        setSnapshotDiff(assertSnapshotTransitionMatchesSelection(result, recordId, path));
      } else if (result.state === "legacy-fallback") {
        resetSnapshotTransition();
      } else {
        setSnapshotDiffError(new Error(result.message));
      }
    } catch (requestError) {
      if (snapshotRequestTokenRef.current !== token) return;
      setSnapshotDiffError(requestError instanceof ReviewApiError || requestError instanceof Error
        ? requestError
        : asError(requestError));
    } finally {
      if (snapshotRequestTokenRef.current === token) setSnapshotDiffLoading(false);
    }
  }

  function resetSnapshotTransition() {
    snapshotRequestTokenRef.current += 1;
    setSelectedRecordId(null);
    setSnapshotDiff(null);
    setSnapshotDiffLoading(false);
    setSnapshotDiffError(null);
  }

  async function handleDisposition(recordId: string, disposition: UserDisposition): Promise<DecisionRecordDetail> {
    if (api === null) throw new ReviewApiError("Not connected to Recorder", { code: "UNKNOWN" });
    const token = requestTokenRef.current;
    const updated = await api.setDisposition(recordId, disposition);
    if (requestTokenRef.current !== token) return updated;
    setDecisions((current) => current.map((decision) => (
      decision.record_id === updated.record.record_id ? updated.record : decision
    )));
    setRecordStates((current) => ({
      ...current,
      [recordId]: { recordId, status: "ready", detail: updated },
    }));
    return updated;
  }

  async function retryJudgment(recordId: string) {
    if (api === null) return;
    // 再試行はトークンを進めない(進めると実行中のファイルロードまで無効化する)。
    // 後発のopenFileがrecordStatesを丸ごと置き換えた後の遅着き完了は、ここで破棄する。
    const token = requestTokenRef.current;
    setRecordStates((current) => ({ ...current, [recordId]: { recordId, status: "loading" } }));
    try {
      const detail = await api.getDecision(recordId);
      if (requestTokenRef.current !== token) return;
      setRecordStates((current) => ({ ...current, [recordId]: { recordId, status: "ready", detail } }));
    } catch (requestError) {
      if (requestTokenRef.current !== token) return;
      setRecordStates((current) => ({
        ...current,
        [recordId]: { recordId, status: "error", message: apiMessage(requestError) },
      }));
    }
  }

  function resetSession() {
    requestTokenRef.current += 1;
    sessionGenerationRef.current += 1;
    resetSnapshotTransition();
    setApi(null);
    setRepositoryId(null);
    setRepositories(null);
    setSelectedRepositoryId("");
    setDecisions([]);
    setFilePaths([]);
    setIsLoading(false);
    setExplorerIsLoading(false);
    setExplorerError(null);
    setSelectedPath(null);
    setFileIsLoading(false);
    setFileError(null);
    setFileBaseMissing(false);
    setDiff(null);
    setRecordStates({});
    setTokenInput("");
    setError(null);
  }

  if (api === null || repositoryId === null) {
    return (
      <BootstrapScreen
        tokenInput={tokenInput}
        onTokenChange={setTokenInput}
        repositories={repositories}
        selectedRepositoryId={selectedRepositoryId}
        onRepositoryChange={setSelectedRepositoryId}
        isLoading={isLoading}
        error={error}
        onSubmit={() => void handleSubmit()}
        onResetSession={resetSession}
      />
    );
  }

  const activeRepository = repositories?.find((candidate) => candidate.repository_id === repositoryId);
  const unreviewedCount = decisions.filter((decision) => decision.user_disposition === "unreviewed").length;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#review-workspace">Skip to workspace</a>
      <header className="app-header">
        <div className="app-header__identity">
          <h1>Decision review</h1>
          <p className="app-header__repo"><code>{activeRepository?.root ?? repositoryId}</code></p>
        </div>
        <p className="app-header__progress" aria-live="polite">
          {unreviewedCount} unreviewed
          <span className="app-header__progress-total"> of {decisions.length}</span>
        </p>
        <div className="app-header__actions">
          <ThemeToggle />
          <button type="button" className="button-secondary" onClick={resetSession}>Clear session</button>
        </div>
      </header>
      {error !== null && <p className="inline-error" role="alert">{error}</p>}
      <Workspace
        tree={tree}
        selectedPath={selectedPath}
        explorerIsLoading={explorerIsLoading}
        explorerError={explorerError}
        onExplorerRetry={() => api !== null && repositoryId !== null
          ? void loadFiles(api, repositoryId, sessionGenerationRef.current)
          : undefined}
        onOpenFile={(path) => void openFile(path)}
        fileIsLoading={fileIsLoading}
        fileError={fileError}
        fileBaseMissing={fileBaseMissing}
        diff={diff}
        fullText={evidence.fullText}
        onFileRetry={() => {
          if (selectedRecordId !== null && snapshotDiffError !== null) {
            void selectJudgment(selectedRecordId, true);
          } else if (selectedPath !== null) {
            void openFile(selectedPath);
          }
        }}
        judgments={judgments}
        anchors={evidence.anchors}
        transitionAnchors={selectedTransitionAnchors}
        selectedRecordId={selectedRecordId}
        onSelectJudgment={(recordId) => void selectJudgment(recordId)}
        snapshotDiff={snapshotDiff}
        snapshotDiffLoading={snapshotDiffLoading}
        snapshotDiffError={snapshotDiffError}
        onDispositionChange={(recordId, disposition) => handleDisposition(recordId, disposition)}
        onJudgmentRetry={(recordId) => void retryJudgment(recordId)}
      />
    </div>
  );
}
