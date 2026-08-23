import type { DecisionRecordDetail, DecisionRecordSummary, SourceReferenceData } from "../api";

export interface DecisionAnchor {
  side: "old" | "new";
  start: number;
  end: number;
}

export interface BlockSelection {
  oldStart: number | null;
  oldEnd: number | null;
  newStart: number | null;
  newEnd: number | null;
}

export function buildDecisionIndex(decisions: DecisionRecordSummary[]): Map<string, DecisionRecordSummary[]> {
  const byPath = new Map<string, DecisionRecordSummary[]>();
  for (const decision of decisions) {
    for (const target of decision.targets) {
      const existing = byPath.get(target.path) ?? [];
      if (!existing.some((candidate) => candidate.record_id === decision.record_id)) existing.push(decision);
      byPath.set(target.path, existing);
    }
  }
  for (const records of byPath.values()) {
    records.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  return byPath;
}

/** Spec §5: commit revisions anchor unconditionally on the old side; verified
 * working-tree revisions anchor on the new side; everything else never anchors. */
export function targetAnchor(source: SourceReferenceData): DecisionAnchor | null {
  if (source.revision.kind === "commit") {
    return { side: "old", start: source.target.line_start, end: source.target.line_end };
  }
  if (source.state === "resolved" || source.state === "snapshot-resolved") {
    return { side: "new", start: source.target.line_start, end: source.target.line_end };
  }
  return null;
}

export function decisionAnchors(detail: DecisionRecordDetail): DecisionAnchor[] {
  return detail.sources
    .map((source) => targetAnchor(source))
    .filter((anchor): anchor is DecisionAnchor => anchor !== null);
}

export function overlapsBlock(anchor: DecisionAnchor, block: BlockSelection): boolean {
  if (anchor.side === "old") {
    return block.oldStart !== null && block.oldEnd !== null && block.oldStart <= anchor.end && anchor.start <= block.oldEnd;
  }
  return block.newStart !== null && block.newEnd !== null && block.newStart <= anchor.end && anchor.start <= block.newEnd;
}

/** Spec §4.3: base the diff on the newest commit-revision decision for the file, else HEAD. */
export function diffBaseFor(decisions: DecisionRecordSummary[]): string {
  const commits = decisions
    .filter((decision) => decision.revision.kind === "commit")
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const first = commits[0];
  return first !== undefined && first.revision.kind === "commit" ? first.revision.sha : "HEAD";
}
