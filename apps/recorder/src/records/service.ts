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
