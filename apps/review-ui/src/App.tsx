import { useMemo, useRef, useState } from "react";
import {
  ReviewApi,
  ReviewApiError,
  type DecisionRecordDetail,
  type DecisionRecordSummary,
  type FileDiff,
  type RegisteredRepositorySummary,
  type UserDisposition,
} from "./api";
import { BootstrapScreen } from "./components/BootstrapScreen";
import { Workspace } from "./components/Workspace";
import type { JudgmentEntry } from "./components/JudgmentPanel";
import type { DecisionAnchor } from "./lib/decision-index";
import { buildDecisionIndex, decisionAnchors, diffBaseFor } from "./lib/decision-index";
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
  const [fullText, setFullText] = useState<{ content: string; anchors: DecisionAnchor[] } | null>(null);
  const [recordStates, setRecordStates] = useState<Record<string, JudgmentEntry>>({});
  const [anchors, setAnchors] = useState<DecisionAnchor[]>([]);
  const [workspaceKey, setWorkspaceKey] = useState(0);
  // M31: openFileが進める単調トークン。後発のファイル選択は先行ロードの非同期完了を無効化し、
  // 遅れて着いた応答が新しい選択の状態を上書きしないようにする。
  const requestTokenRef = useRef(0);

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

  async function handleSubmit() {
    setError(null);
    const token = tokenInput.trim();
    if (token.length === 0) {
      setError("Owner bearer token is required.");
      return;
    }

    setIsLoading(true);
    try {
      if (repositories === null) {
        const client = apiFactory(token);
        const found = await client.listRepositories();
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
      setApi(client);
      setRepositoryId(repository);
      setDecisions(records);
      await loadFiles(client, repository);
    } catch (requestError) {
      if (repositories === null) {
        setApi(null);
        setRepositories(null);
      }
      setError(apiMessage(requestError));
    } finally {
      setIsLoading(false);
    }
  }

  async function loadFiles(client: ReviewApi, repository: string) {
    setExplorerIsLoading(true);
    setExplorerError(null);
    try {
      const data = await client.listRepositoryFiles(repository);
      setFilePaths(data.paths);
    } catch (requestError) {
      setExplorerError(asError(requestError));
    } finally {
      setExplorerIsLoading(false);
    }
  }

  async function openFile(path: string) {
    if (api === null || repositoryId === null) return;
    const token = ++requestTokenRef.current;
    setSelectedPath(path);
    setSelectedBlockReset();

    const related = decisionIndex.get(path) ?? [];
    const base = diffBaseFor(related);
    setFileIsLoading(true);
    setFileError(null);
    setFileBaseMissing(false);
    setDiff(null);
    setFullText(null);
    setAnchors([]);
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
    const nextAnchors: DecisionAnchor[] = [];
    for (const attempt of details) {
      if (attempt.ok) {
        nextStates[attempt.id] = { recordId: attempt.id, status: "ready", detail: attempt.value };
        nextAnchors.push(...decisionAnchors(attempt.value));
      } else {
        nextStates[attempt.id] = { recordId: attempt.id, status: "error", message: apiMessage(attempt.error) };
      }
    }
    setRecordStates(nextStates);
    setAnchors(nextAnchors);

    for (const attempt of details) {
      if (!attempt.ok) continue;
      const source = attempt.value.sources.find((candidate) => candidate.state === "resolved" || candidate.state === "snapshot-resolved");
      if (source !== undefined && "content" in source) {
        setFullText({ content: source.content, anchors: decisionAnchors(attempt.value) });
        break;
      }
    }

    setFileIsLoading(false);
  }

  function setSelectedBlockReset() {
    // ブロック選択はWorkspace内部state。ファイル切替時に解除してもらうためkeyでリセットする。
    setWorkspaceKey((current) => current + 1);
  }

  async function handleDisposition(recordId: string, disposition: UserDisposition): Promise<DecisionRecordDetail> {
    if (api === null) throw new ReviewApiError("Not connected to Recorder", { code: "UNKNOWN" });
    const updated = await api.setDisposition(recordId, disposition);
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
    setApi(null);
    setRepositoryId(null);
    setRepositories(null);
    setSelectedRepositoryId("");
    setDecisions([]);
    setFilePaths([]);
    setExplorerError(null);
    setSelectedPath(null);
    setFileError(null);
    setFileBaseMissing(false);
    setDiff(null);
    setFullText(null);
    setRecordStates({});
    setAnchors([]);
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
      />
    );
  }

  const activeRepository = repositories?.find((candidate) => candidate.repository_id === repositoryId);

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Local review evidence</p>
          <h1>Decision review</h1>
          <p className="app-header__repo">Repository <code>{activeRepository?.root ?? repositoryId}</code></p>
        </div>
        <button type="button" className="button-secondary" onClick={resetSession}>Clear session</button>
      </header>
      {error !== null && <p className="inline-error" role="alert">{error}</p>}
      <Workspace key={workspaceKey} tree={tree} selectedPath={selectedPath} explorerIsLoading={explorerIsLoading} explorerError={explorerError} onExplorerRetry={() => api !== null && repositoryId !== null ? void loadFiles(api, repositoryId) : undefined} onOpenFile={(path) => void openFile(path)} fileIsLoading={fileIsLoading} fileError={fileError} fileBaseMissing={fileBaseMissing} diff={diff} fullText={fullText} onFileRetry={() => selectedPath !== null && void openFile(selectedPath)} judgments={judgments} anchors={anchors} onDispositionChange={(recordId, disposition) => handleDisposition(recordId, disposition)} onJudgmentRetry={(recordId) => void retryJudgment(recordId)} />
    </main>
  );
}
