import {
  ERROR_CODES,
  type DiffHunk,
  type DiffLine,
} from "../../../../packages/contracts/src/index";
import { SourceResolutionError } from "../repositories/registry";

type DiffOperation =
  | { kind: "equal"; line: string }
  | { kind: "delete"; line: string }
  | { kind: "insert"; line: string };

interface DiffEntry {
  operation: DiffOperation;
  oldLine: number | null;
  newLine: number | null;
  oldBefore: number;
  newBefore: number;
}

interface GroupedHunk {
  oldStart: number;
  newStart: number;
  entries: DiffEntry[];
}

export class TextDiffError extends SourceResolutionError {
  constructor(message = "Git diff work exceeds the configured source limit") {
    super(ERROR_CODES.PAYLOAD_TOO_LARGE, message);
    this.name = "TextDiffError";
  }
}

export interface TextDiffResult {
  hunks: DiffHunk[];
  binary: boolean;
}

export interface TextDiffOptions {
  maxWork: number;
  emptySide?: "zero-lines" | "split";
  binary?: "empty" | "diff";
  maxOutputBytes?: number;
}

function formatHunk(hunk: DiffHunk): string {
  const oldCount = hunk.lines.filter((line) => line.oldLine !== null).length;
  const newCount = hunk.lines.filter((line) => line.newLine !== null).length;
  const body = hunk.lines
    .map((line) => `${line.type === "context" ? " " : line.type === "del" ? "-" : "+"}${line.content}`)
    .join("\n");
  return `@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@\n${body}\n`;
}

export function formatUnifiedDiff(path: string, hunks: DiffHunk[]): string {
  if (hunks.length === 0) return "";
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks.map((hunk) => formatHunk(hunk)).join("")}`;
}

function lineDiff(previous: string[], current: string[], maxWork: number): DiffOperation[] | null {
  const maxDistance = previous.length + current.length;
  let frontier = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  let work = 0;

  const spendWork = (): boolean => {
    if (work >= maxWork) return false;
    work += 1;
    return true;
  };

  for (let distance = 0; distance <= maxDistance; distance += 1) {
    if (!spendWork()) return null;
    const nextFrontier = new Map<number, number>();
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      if (!spendWork()) return null;
      const down = diagonal === -distance || (diagonal !== distance && (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1));
      let x = down ? (frontier.get(diagonal + 1) ?? 0) : (frontier.get(diagonal - 1) ?? 0) + 1;
      let y = x - diagonal;
      while (x < previous.length && y < current.length && previous[x] === current[y]) {
        if (!spendWork()) return null;
        x += 1;
        y += 1;
      }
      if (!spendWork()) return null;
      nextFrontier.set(diagonal, x);
      if (x >= previous.length && y >= current.length) {
        trace.push(nextFrontier);
        const operations: DiffOperation[] = [];
        let backtrackX = previous.length;
        let backtrackY = current.length;
        for (let step = trace.length - 1; step > 0; step -= 1) {
          const prior = trace[step - 1]!;
          const backtrackDiagonal = backtrackX - backtrackY;
          const backtrackDown =
            backtrackDiagonal === -step ||
            (backtrackDiagonal !== step && (prior.get(backtrackDiagonal - 1) ?? -1) < (prior.get(backtrackDiagonal + 1) ?? -1));
          const priorDiagonal = backtrackDown ? backtrackDiagonal + 1 : backtrackDiagonal - 1;
          const priorX = prior.get(priorDiagonal) ?? 0;
          const priorY = priorX - priorDiagonal;
          while (backtrackX > priorX && backtrackY > priorY) {
            operations.push({ kind: "equal", line: previous[backtrackX - 1]! });
            backtrackX -= 1;
            backtrackY -= 1;
          }
          if (backtrackX === priorX) {
            operations.push({ kind: "insert", line: current[backtrackY - 1]! });
            backtrackY -= 1;
          } else {
            operations.push({ kind: "delete", line: previous[backtrackX - 1]! });
            backtrackX -= 1;
          }
        }
        while (backtrackX > 0 && backtrackY > 0) {
          operations.push({ kind: "equal", line: previous[backtrackX - 1]! });
          backtrackX -= 1;
          backtrackY -= 1;
        }
        while (backtrackX > 0) {
          operations.push({ kind: "delete", line: previous[backtrackX - 1]! });
          backtrackX -= 1;
        }
        while (backtrackY > 0) {
          operations.push({ kind: "insert", line: current[backtrackY - 1]! });
          backtrackY -= 1;
        }
        return operations.reverse();
      }
    }
    trace.push(nextFrontier);
    frontier = nextFrontier;
  }
  return null;
}

function toEntries(operations: DiffOperation[]): DiffEntry[] {
  const entries: DiffEntry[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const operation of operations) {
    entries.push({
      operation,
      oldLine: operation.kind === "insert" ? null : oldLine + 1,
      newLine: operation.kind === "delete" ? null : newLine + 1,
      oldBefore: oldLine,
      newBefore: newLine,
    });
    if (operation.kind !== "insert") oldLine += 1;
    if (operation.kind !== "delete") newLine += 1;
  }
  return entries;
}

function groupHunks(entries: DiffEntry[]): GroupedHunk[] {
  const changes = entries.flatMap((entry, index) => (entry.operation.kind === "equal" ? [] : [index]));
  if (changes.length === 0) return [];
  const ranges: Array<{ start: number; end: number }> = [];
  let start = Math.max(0, changes[0]! - 3);
  let end = Math.min(entries.length - 1, changes[0]! + 3);
  for (let change = 1; change < changes.length; change += 1) {
    const nextStart = Math.max(0, changes[change]! - 3);
    const nextEnd = Math.min(entries.length - 1, changes[change]! + 3);
    if (nextStart <= end + 1) {
      end = Math.max(end, nextEnd);
      continue;
    }
    ranges.push({ start, end });
    start = nextStart;
    end = nextEnd;
  }
  ranges.push({ start, end });
  return ranges.map(({ start, end }) => {
    const hunkEntries = entries.slice(start, end + 1);
    const first = hunkEntries[0]!;
    return {
      oldStart: first.oldLine ?? first.oldBefore + 1,
      newStart: first.newLine ?? first.newBefore + 1,
      entries: hunkEntries,
    };
  });
}

export function diffText(path: string, previous: string, current: string, options: TextDiffOptions): TextDiffResult {
  const binary = previous.includes("\0") || current.includes("\0");
  if (binary && options.binary !== "diff") return { hunks: [], binary: true };

  const previousLines = previous === "" && options.emptySide !== "split" ? [] : previous.split("\n");
  const currentLines = current === "" && options.emptySide !== "split" ? [] : current.split("\n");
  const operations = lineDiff(previousLines, currentLines, options.maxWork);
  if (operations === null) throw new TextDiffError();

  const hunks: DiffHunk[] = groupHunks(toEntries(operations)).map((hunk) => ({
    oldStart: hunk.oldStart,
    newStart: hunk.newStart,
    lines: hunk.entries.map((entry): DiffLine => ({
      type: entry.operation.kind === "equal" ? "context" : entry.operation.kind === "delete" ? "del" : "add",
      oldLine: entry.oldLine,
      newLine: entry.newLine,
      content: entry.operation.line,
    })),
  }));
  if (options.maxOutputBytes !== undefined && new TextEncoder().encode(formatUnifiedDiff(path, hunks)).byteLength > options.maxOutputBytes) {
    throw new TextDiffError("Git diff exceeds the configured source limit");
  }
  return { hunks, binary };
}
