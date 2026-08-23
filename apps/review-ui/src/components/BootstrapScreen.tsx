import { FormEvent } from "react";
import type { RegisteredRepositorySummary } from "../api";

export interface BootstrapScreenProps {
  tokenInput: string;
  onTokenChange: (value: string) => void;
  repositories: RegisteredRepositorySummary[] | null;
  selectedRepositoryId: string;
  onRepositoryChange: (id: string) => void;
  isLoading: boolean;
  error: string | null;
  onSubmit: () => void;
}

export function BootstrapScreen({
  tokenInput,
  onTokenChange,
  repositories,
  selectedRepositoryId,
  onRepositoryChange,
  isLoading,
  error,
  onSubmit,
}: BootstrapScreenProps) {
  const pickingRepository = repositories !== null;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }

  return (
    <main className="app-shell app-shell--bootstrap">
      <section className="bootstrap-card" aria-labelledby="bootstrap-heading">
        <p className="eyebrow">Local review evidence</p>
        <h1 id="bootstrap-heading">Review decisions with their source</h1>
        <p>Enter the owner token from Recorder and pick one of its registered repositories. The token stays in this browser tab's memory and is never written to storage or included in a URL.</p>
        <form onSubmit={handleSubmit}>
          <fieldset>
            <legend>Recorder connection</legend>
            <label htmlFor="owner-token">Owner bearer token</label>
            <input
              id="owner-token"
              name="owner-token"
              type="password"
              autoComplete="off"
              value={tokenInput}
              onChange={(event) => onTokenChange(event.target.value)}
              required
            />
            {pickingRepository && (
              <>
                <label htmlFor="repository">Repository</label>
                <select
                  id="repository"
                  name="repository"
                  value={selectedRepositoryId}
                  onChange={(event) => onRepositoryChange(event.target.value)}
                  required
                >
                  <option value="" disabled>Select a repository…</option>
                  {repositories.map((candidate) => (
                    <option key={candidate.repository_id} value={candidate.repository_id}>
                      {candidate.root}
                    </option>
                  ))}
                </select>
              </>
            )}
          </fieldset>
          {error !== null && <p className="inline-error" role="alert">{error}</p>}
          <button type="submit" disabled={isLoading}>
            {isLoading
              ? pickingRepository
                ? "Opening…"
                : "Connecting…"
              : pickingRepository
                ? "Open review timeline"
                : "Load repositories"}
          </button>
        </form>
      </section>
    </main>
  );
}
