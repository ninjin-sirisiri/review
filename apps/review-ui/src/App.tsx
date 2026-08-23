import { useState } from "react";
import {
  ReviewApi,
  ReviewApiError,
  type DecisionRecordDetail,
  type DecisionRecordSummary,
  type RegisteredRepositorySummary,
  type UserDisposition,
} from "./api";
import { BootstrapScreen } from "./components/BootstrapScreen";
import { DecisionDetail } from "./components/DecisionDetail";
import { DecisionList } from "./components/DecisionList";
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

export function App({ apiFactory = (token) => new ReviewApi(token) }: AppProps) {
  const [tokenInput, setTokenInput] = useState("");
  const [repositories, setRepositories] = useState<RegisteredRepositorySummary[] | null>(null);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState("");
  const [api, setApi] = useState<ReviewApi | null>(null);
  const [repositoryId, setRepositoryId] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<DecisionRecordSummary[]>([]);
  const [selectedRecordId, setSelectedRecordId] = useState<string | undefined>();
  const [detail, setDetail] = useState<DecisionRecordDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setError(null);
    const token = tokenInput.trim();
    if (token.length === 0) {
      setError("Owner bearer token is required.");
      return;
    }

    setIsLoading(true);
    setError(null);
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

      const client = api ?? apiFactory(token);
      const records = await client.listDecisions(repository);
      setRepositoryId(repository);
      setDecisions(records);
      const first = records[0];
      if (first !== undefined) await selectDecision(client, first.record_id);
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

  async function selectDecision(client: ReviewApi, recordId: string) {
    setSelectedRecordId(recordId);
    setDetail(null);
    setIsLoadingDetail(true);
    setError(null);
    try {
      setDetail(await client.getDecision(recordId));
    } catch (requestError) {
      setError(apiMessage(requestError));
    } finally {
      setIsLoadingDetail(false);
    }
  }

  async function handleSelect(recordId: string) {
    if (api === null) return;
    await selectDecision(api, recordId);
  }

  async function handleDisposition(disposition: UserDisposition): Promise<DecisionRecordDetail> {
    if (api === null || selectedRecordId === undefined) {
      throw new ReviewApiError("Select a decision before changing its disposition", { code: "INVALID_RECORD", status: 422 });
    }
    const updated = await api.setDisposition(selectedRecordId, disposition);
    setDetail(updated);
    setDecisions((current) => current.map((decision) => (
      decision.record_id === updated.record.record_id ? updated.record : decision
    )));
    return updated;
  }

  function resetSession() {
    setApi(null);
    setRepositoryId(null);
    setRepositories(null);
    setSelectedRepositoryId("");
    setDecisions([]);
    setSelectedRecordId(undefined);
    setDetail(null);
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
      <div className="app-layout">
        <DecisionList
          decisions={decisions}
          selectedRecordId={selectedRecordId}
          onSelect={(recordId) => void handleSelect(recordId)}
          isLoading={isLoading}
        />
        <section className="detail-pane" aria-live="polite">
          {isLoadingDetail && <p role="status">Loading decision and linked source…</p>}
          {!isLoadingDetail && detail === null && <p className="empty-state">Select a decision to inspect its evidence.</p>}
          {!isLoadingDetail && detail !== null && (
            <DecisionDetail detail={detail} onDispositionChange={handleDisposition} />
          )}
        </section>
      </div>
    </main>
  );
}
