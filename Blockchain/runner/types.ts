import type { AttemptState } from "../persistence/types.js";
import type { RecoveryResultDto } from "../recovery/types.js";

export type RunnerOptions = Readonly<{
  batchSize?: number;
  cooldownMs?: number;
}>;

export type EligibleSettlement = Readonly<{
  transferId: string;
  attemptId: string;
  attemptState: Extract<AttemptState, "PREPARING" | "SIGNED" | "BROADCAST_REQUESTED" | "BROADCAST_SUBMITTED">;
}>;

export type ReconciliationOperation = Readonly<{
  reconcilePersistedSettlement(transferId: string): Promise<RecoveryResultDto>;
}>;

// Explicit operational allowlist: no signed bytes, private keys, credentials, or raw errors.
export type RunnerResultDto = Readonly<{
  scanned: number;
  processed: number;
  recovered: number;
  pending: number;
  terminal: number;
  rpcUncertain: number;
  noAction: number;
  conflicts: number;
  failed: number;
}>;

export const DEFAULT_RUNNER_BATCH_SIZE = 10;
export const MAX_RUNNER_BATCH_SIZE = 50;
export const DEFAULT_RUNNER_COOLDOWN_MS = 60_000;
