import "../fuji/server-only.js";
import type { Pool } from "pg";
import { FujiError } from "../fuji/errors.js";
import { createRecoveryService } from "../recovery/service.js";
import type { RecoveryResultDto } from "../recovery/types.js";
import { RunnerRepository } from "./repository.js";
import {
  DEFAULT_RUNNER_BATCH_SIZE,
  DEFAULT_RUNNER_COOLDOWN_MS,
  MAX_RUNNER_BATCH_SIZE,
  type ReconciliationOperation,
  type RunnerOptions,
  type RunnerResultDto,
} from "./types.js";

function normalizedOptions(options: RunnerOptions): Readonly<{ batchSize: number; cooldownMs: number }> {
  const batchSize = options.batchSize ?? DEFAULT_RUNNER_BATCH_SIZE;
  const cooldownMs = options.cooldownMs ?? DEFAULT_RUNNER_COOLDOWN_MS;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_RUNNER_BATCH_SIZE) {
    throw new FujiError("CONFIG", `Runner batch size must be an integer from 1 to ${MAX_RUNNER_BATCH_SIZE}.`);
  }
  if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 0 || cooldownMs > 86_400_000) {
    throw new FujiError("CONFIG", "Runner cooldown must be an integer from 0 to 86400000 milliseconds.");
  }
  return { batchSize, cooldownMs };
}

function emptyResult(scanned: number): RunnerResultDto {
  return {
    scanned,
    processed: 0,
    recovered: 0,
    pending: 0,
    terminal: 0,
    rpcUncertain: 0,
    noAction: 0,
    conflicts: 0,
    failed: 0,
  };
}

function count(result: RunnerResultDto, reconciliation: RecoveryResultDto): RunnerResultDto {
  const next = { ...result, processed: result.processed + 1 };
  switch (reconciliation.recoveryOutcome) {
    case "RECOVERED": return { ...next, recovered: next.recovered + 1 };
    case "PENDING": return { ...next, pending: next.pending + 1 };
    case "TERMINAL": return { ...next, terminal: next.terminal + 1 };
    case "RPC_UNCERTAIN": return { ...next, rpcUncertain: next.rpcUncertain + 1 };
    case "NO_ACTION": return { ...next, noAction: next.noAction + 1 };
    case "NONCE_CONFLICT":
    case "RECOVERY_CONFLICT": return { ...next, conflicts: next.conflicts + 1 };
  }
}

/**
 * Executes one finite batch. The only settlement action is Task 4's existing
 * reconcilePersistedSettlement; this module has no signer, nonce, transaction,
 * broadcast, receipt, or ERC-20 implementation.
 */
export function createDurableReconciliationRunner(
  pool: Pool,
  reconciliation: ReconciliationOperation = createRecoveryService(pool),
) {
  const repository = new RunnerRepository(pool);

  async function runOnce(options: RunnerOptions = {}): Promise<RunnerResultDto> {
    const normalized = normalizedOptions(options);
    const selected = await repository.listEligible({
      limit: normalized.batchSize,
      cooldownMs: normalized.cooldownMs,
    });
    let result = emptyResult(selected.length);

    // Deliberately finite and sequential: at most batchSize Task 4 calls per invocation.
    for (const settlement of selected) {
      try {
        result = count(result, await reconciliation.reconcilePersistedSettlement(settlement.transferId));
      } catch {
        // Task 4 already owns durable recovery evidence. Do not expose raw errors
        // or let one bad settlement prevent the rest of this bounded batch.
        result = { ...result, processed: result.processed + 1, failed: result.failed + 1 };
      }
    }
    return Object.freeze(result);
  }

  return { runOnce };
}
