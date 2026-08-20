import { FormEvent, useState } from "react";
import { ReviewApi, ReviewApiError, type DecisionRecordDetail, type DecisionRecordSummary, type UserDisposition } from "./api";
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
  const [repositoryInput, setRepositoryInput] = useState("");
  const [api, setApi] = useState<ReviewApi | null>(null);
  const [repositoryId, setRepositoryId] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<DecisionRecordSummary[]>([]);
  const [selectedRecordId, setSelectedRecordId] = useState<string | undefined>();
  const [detail, setDetail] = useState<DecisionRecordDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function bootstrap(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = tokenInput.trim();
    const repository = repositoryInput.trim();
    if (token.length === 0 || repository.length === 0) {
      setError("Owner token and repository ID are required.");
      return;
    }

    const client = apiFactory(token);
    setIsLoading(true);
    setError(null);
    setDetail(null);
    setSelectedRecordId(undefined);
    try {
      const records = await client.listDecisions(repository);
      setApi(client);
      setRepositoryId(repository);
      setDecisions(records);
      const first = records[0];
      if (first !== undefined) await selectDecision(client, first.record_id);
    } catch (requestError) {
      setApi(null);
      setRepositoryId(null);
      setDecisions([]);
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
    setDecisions([]);
    setSelectedRecordId(undefined);
    setDetail(null);
    setTokenInput("");
    setError(null);
  }

  if (api === null || repositoryId === null) {
    return (
      <main className="app-shell app-shell--bootstrap">
        <section className="bootstrap-card" aria-labelledby="bootstrap-heading">
          <p className="eyebrow">Local review evidence</p>
          <h1 id="bootstrap-heading">Review decisions with their source</h1>
          <p>Enter the owner token from Recorder and a repository ID. The token stays in this browser tab's memory and is never written to storage or included in a URL.</p>
          <form onSubmit={bootstrap}>
            <fieldset>
              <legend>Recorder connection</legend>
              <label htmlFor="owner-token">Owner bearer token</label>
              <input
                id="owner-token"
                name="owner-token"
                type="password"
                autoComplete="off"
                value={tokenInput}
                onChange={(event) => setTokenInput(event.target.value)}
                required
              />
              <label htmlFor="repository-id">Repository ID</label>
              <input
                id="repository-id"
                name="repository-id"
                type="text"
                value={repositoryInput}
                onChange={(event) => setRepositoryInput(event.target.value)}
                required
              />
            </fieldset>
            {error !== null && <p className="inline-error" role="alert">{error}</p>}
            <button type="submit" disabled={isLoading}>{isLoading ? "Connecting…" : "Open review timeline"}</button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Local review evidence</p>
          <h1>Decision review</h1>
          <p className="app-header__repo">Repository <code>{repositoryId}</code></p>
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
