import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { MAX_TEXT_FIELD_LENGTH } from "../../../packages/contracts/src/index";

export const DEFAULT_DATA_DIR = resolve(homedir(), ".ai-code-review-evidence");
export const DEFAULT_MAX_SNAPSHOT_CONTENT_LENGTH = 1_000_000;

export interface RecorderConfig {
  dataDir: string;
  databasePath: string;
  snapshotDir: string;
  tokenPath: string;
  bindAddress: string;
  port: number;
  maxTextFieldLength: typeof MAX_TEXT_FIELD_LENGTH;
  maxSnapshotContentLength: number;
}

export interface RecorderConfigOverrides {
  dataDir?: string;
  databasePath?: string;
  /** Alias accepted for callers that name the SQLite file path `dbPath`. */
  dbPath?: string;
  snapshotDir?: string;
  tokenPath?: string;
  bindAddress?: string;
  port?: number;
  maxSnapshotContentLength?: number;
  /** Alias accepted for callers that express content limits as bytes. */
  maxSnapshotBytes?: number;
}

function childPath(base: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(base, value);
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive integer`);
  }
  return value;
}

export function createRecorderConfig(overrides: RecorderConfigOverrides = {}): RecorderConfig {
  const dataDir = resolve(overrides.dataDir ?? DEFAULT_DATA_DIR);
  const maxSnapshotContentLength = positiveInteger(
    overrides.maxSnapshotContentLength ?? overrides.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_CONTENT_LENGTH,
    "maxSnapshotContentLength",
  );
  const port = overrides.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError("port must be an integer between 0 and 65535");
  }

  return {
    dataDir,
    databasePath: childPath(dataDir, overrides.databasePath ?? overrides.dbPath ?? "records.sqlite"),
    snapshotDir: childPath(dataDir, overrides.snapshotDir ?? "snapshots"),
    tokenPath: childPath(dataDir, overrides.tokenPath ?? "token"),
    bindAddress: overrides.bindAddress ?? "127.0.0.1",
    port,
    maxTextFieldLength: MAX_TEXT_FIELD_LENGTH,
    maxSnapshotContentLength,
  };
}

export const DEFAULT_RECORDER_CONFIG = createRecorderConfig();
export const loadRecorderConfig = createRecorderConfig;
