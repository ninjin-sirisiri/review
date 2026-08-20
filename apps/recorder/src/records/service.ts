import {
  ContractValidationError,
  ERROR_CODES,
  validateDecisionRecordInput,
  type DecisionRecord,
  type DecisionRecordInput,
  type SnapshotMode,
  type SnapshotReference,
  type UserDisposition,
} from "../../../../packages/contracts/src/index";
import { PersistenceError, RecordStore } from "../store/records";
import { SnapshotStore } from "../store/snapshots";

export class RecordService {
  readonly store: RecordStore;
  readonly snapshots: SnapshotStore;

  constructor(store: RecordStore, snapshots?: SnapshotStore) {
    this.store = store;
    this.snapshots = snapshots ?? new SnapshotStore(store);
  }
  async preflight(input: unknown): Promise<DecisionRecordInput> {
    const result = validateDecisionRecordInput(input);
    if (!result.success) throw new ContractValidationError(result);
    for (const target of result.data.targets) {
      if (target.repository_id !== result.data.repository_id) {
        throw new PersistenceError(ERROR_CODES.INVALID_RECORD, "target.repository_id must match repository_id");
      }
    }
    const session = await this.store.getSession(result.data.session_id);
    if (session === null) throw new PersistenceError(ERROR_CODES.INVALID_RECORD, `session ${result.data.session_id} does not exist`);
    if (session.repository_id !== result.data.repository_id || session.agent_type !== result.data.agent_type) {
      throw new PersistenceError(ERROR_CODES.INVALID_RECORD, "decision does not match its session");
    }
    return result.data;
  }


  async record(input: DecisionRecordInput): Promise<DecisionRecord> {
    const result = validateDecisionRecordInput(input);
    if (!result.success) throw new ContractValidationError(result);
    return this.store.insertDecision(result.data);
  }

  async setDisposition(recordId: string, disposition: UserDisposition): Promise<DecisionRecord> {
    if (typeof recordId !== "string" || recordId.trim().length === 0) {
      throw new PersistenceError(ERROR_CODES.INVALID_RECORD, "recordId must be a non-empty string");
    }
    return this.store.setDisposition(recordId, disposition);
  }

  getDecision(recordId: string): Promise<DecisionRecord | null> {
    return this.store.getDecision(recordId);
  }

  listDecisions(repositoryId: string): Promise<DecisionRecord[]> {
    return this.store.listDecisions(repositoryId);
  }

  createSnapshot(recordId: string, mode: SnapshotMode, content: string): Promise<SnapshotReference> {
    return this.snapshots.create(recordId, mode, content);
  }
}
