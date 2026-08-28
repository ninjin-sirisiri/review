import { FormEvent } from "react";
import type { RegisteredRepositorySummary } from "../api";
import { ThemeToggle } from "./ThemeToggle";

export interface BootstrapScreenProps {
  tokenInput: string;
  onTokenChange: (value: string) => void;
  repositories: RegisteredRepositorySummary[] | null;
  selectedRepositoryId: string;
  onRepositoryChange: (id: string) => void;
  isLoading: boolean;
  error: string | null;
  onSubmit: () => void;
  onResetSession: () => void;
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
  onResetSession,
}: BootstrapScreenProps) {
  const pickingRepository = repositories !== null;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }

  return (
    <main className="app-shell app-shell--bootstrap">
      <div className="bootstrap-theme">
        <ThemeToggle />
      </div>
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
              disabled={pickingRepository || isLoading}
              required
            />
            {pickingRepository && repositories.length > 0 && (
              <>
                <label htmlFor="repository">Repository</label>
                <select
                  id="repository"
                  name="repository"
                  value={selectedRepositoryId}
                  onChange={(event) => onRepositoryChange(event.target.value)}
                  disabled={isLoading}
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
            {pickingRepository && repositories.length === 0 && (
              <p role="status" className="empty-state">No registered repositories were found for this owner token.</p>
            )}
          </fieldset>
          {error !== null && <p className="inline-error" role="alert">{error}</p>}
          {pickingRepository && repositories.length === 0 ? (
            <button type="button" className="button-secondary" onClick={onResetSession}>
              Use another token
            </button>
          ) : (
            <button type="submit" disabled={isLoading}>
              {isLoading
                ? pickingRepository
                  ? "Opening…"
                  : "Connecting…"
                : pickingRepository
                  ? "Open review timeline"
                  : "Load repositories"}
            </button>
          )}
        </form>
      </section>
    </main>
  );
}
