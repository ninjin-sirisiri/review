import type { SourceReferenceData } from "../api";

interface SourceReferenceProps {
  source: SourceReferenceData;
}

function revisionLabel(source: SourceReferenceData): string {
  return source.revision.kind === "commit" ? `commit ${source.revision.sha}` : `working tree ${source.revision.contentHash}`;
}

const unresolvedStateCopy = {
  "hash-mismatch": {
    title: "Source changed since the decision",
    description: "The current source hash does not match the source that was reviewed.",
  },
  "revision-not-found": {
    title: "The recorded revision is no longer available",
    description: "The decision points to a revision that Recorder cannot find.",
  },
  "source-unavailable": {
    title: "Source is unavailable",
    description: "Recorder could not read the recorded source.",
  },
} as const;

export function SourceReference({ source }: SourceReferenceProps) {
  if (source.state !== "resolved" && source.state !== "snapshot-resolved") {
    const copy = unresolvedStateCopy[source.state];
    return (
      <section className="source-reference source-reference--unresolved" aria-labelledby={`source-${source.path}`}>
        <div className="source-warning" role="alert">
          <h3 id={`source-${source.path}`}>{copy.title}</h3>
          <p>{copy.description}</p>
          {source.message !== undefined && <p>{source.message}</p>}
          <dl className="source-metadata">
            <div>
              <dt>Expected hash</dt>
              <dd><code>{source.expected_hash}</code></dd>
            </div>
            {source.actual_hash !== undefined && (
              <div>
                <dt>Actual hash</dt>
                <dd><code>{source.actual_hash}</code></dd>
              </div>
            )}
          </dl>
        </div>
        <p className="source-safety-note">Current code is intentionally not shown until this reference is resolved.</p>
      </section>
    );
  }

  const lines = source.content.split("\n");
  return (
    <section className="source-reference" aria-labelledby={`source-${source.path}`}>
      <header className="source-header">
        <div>
          <h3 id={`source-${source.path}`}>{source.path}</h3>
          <p>{source.target.line_start}–{source.target.line_end} · {revisionLabel(source)}</p>
        </div>
        <span className="source-state">{source.state === "snapshot-resolved" ? "Snapshot" : "Resolved"}</span>
      </header>
      <dl className="source-metadata">
        <div>
          <dt>Content hash</dt>
          <dd><code>{source.content_hash}</code></dd>
        </div>
        {source.snapshot !== undefined && (
          <div>
            <dt>Snapshot</dt>
            <dd><code>{source.snapshot.snapshot_id}</code> · {source.snapshot.mode}</dd>
          </div>
        )}
      </dl>
      <ol className="source-lines" aria-label={`Source from ${source.path}`}>
        {lines.map((line, index) => (
          <li key={`${source.path}-${index + 1}`}>
            <span className="line-number" aria-hidden="true">{source.target.line_start + index}</span>
            <code>{line || " "}</code>
          </li>
        ))}
      </ol>
    </section>
  );
}
