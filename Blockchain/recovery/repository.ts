import "../fuji/server-only.js";
import type { Pool, PoolClient } from "pg";
import type { Address, Hash, Hex } from "viem";
import { FujiError } from "../fuji/errors.js";
import { inTransaction } from "../persistence/database.js";
import type { AttemptState } from "../persistence/types.js";
import type { VerificationFailureCode } from "../verification/types.js";
import type { RecoveryAttempt, RecoveryCode } from "./types.js";

type RecoveryRow = {
  settlement_id: string;
  attempt_id: string;
  transfer_id: string;
  attempt_state: AttemptState;
  chain_id: number;
  signer_address: Address;
  destination_address: Address;
  token_address: Address;
  amount_units: string;
  nonce: string;
  signed_transaction: Hex | null;
  local_tx_hash: Hash | null;
  network_tx_hash: Hash | null;
  verified_at: Date | null;
  receipt_block_number: string | null;
  receipt_block_hash: Hash | null;
  receipt_status: "success" | "reverted" | null;
  verified_transfer_log_index: number | null;
  confirmed_at: Date | null;
  verification_failure_code: VerificationFailureCode | null;
  verification_failure_reason: string | null;
  recovery_attempt_count: number;
  last_recovery_at: Date | null;
  last_recovery_code: RecoveryCode | null;
  last_recovery_reason: string | null;
  recovery_sign_claimed_at: Date | null;
  recovery_rebroadcast_claimed_at: Date | null;
};

const selectRecovery = `
  SELECT
    s.id AS settlement_id, a.id AS attempt_id, s.transfer_id, a.attempt_state,
    a.chain_id, a.signer_address, a.destination_address, a.token_address,
    a.amount_units, a.nonce, a.signed_transaction, a.local_tx_hash, a.network_tx_hash,
    a.verified_at, a.receipt_block_number, a.receipt_block_hash, a.receipt_status,
    a.verified_transfer_log_index, a.confirmed_at,
    a.verification_failure_code, a.verification_failure_reason,
    a.recovery_attempt_count, a.last_recovery_at, a.last_recovery_code,
    a.last_recovery_reason, a.recovery_sign_claimed_at, a.recovery_rebroadcast_claimed_at
  FROM blockchain_private.settlements s
  JOIN blockchain_private.settlement_attempts a ON a.settlement_id = s.id`;

function requireRow<T>(rows: T[]): T {
  if (rows.length !== 1) {
    throw new FujiError("INVALID_SETTLEMENT_STATE", "Expected exactly one persisted settlement attempt for recovery.");
  }
  return rows[0];
}

function toAttempt(row: RecoveryRow): RecoveryAttempt {
  const nonce = Number(row.nonce);
  if (!Number.isSafeInteger(nonce) || nonce < 0 || !Number.isSafeInteger(row.recovery_attempt_count)) {
    throw new FujiError("INVALID_SETTLEMENT_STATE", "Persisted recovery metadata is invalid.");
  }
  return Object.freeze({
    settlementId: row.settlement_id,
    attemptId: row.attempt_id,
    transferId: row.transfer_id,
    attemptState: row.attempt_state,
    chainId: row.chain_id,
    signer: row.signer_address,
    destination: row.destination_address,
    tokenAddress: row.token_address,
    amountUnits: row.amount_units,
    nonce,
    signedTransaction: row.signed_transaction,
    localHash: row.local_tx_hash,
    networkHash: row.network_tx_hash,
    verifiedAt: row.verified_at,
    receiptBlockNumber: row.receipt_block_number,
    receiptBlockHash: row.receipt_block_hash,
    receiptStatus: row.receipt_status,
    transferLogIndex: row.verified_transfer_log_index,
    confirmedAt: row.confirmed_at,
    failureCode: row.verification_failure_code,
    failureReason: row.verification_failure_reason,
    recoveryAttemptCount: row.recovery_attempt_count,
    lastRecoveryAt: row.last_recovery_at,
    lastRecoveryCode: row.last_recovery_code,
    lastRecoveryReason: row.last_recovery_reason,
    recoverySignClaimedAt: row.recovery_sign_claimed_at,
    recoveryRebroadcastClaimedAt: row.recovery_rebroadcast_claimed_at,
  });
}

async function readById(client: PoolClient, attemptId: string): Promise<RecoveryAttempt> {
  const result = await client.query<RecoveryRow>(`${selectRecovery} WHERE a.id = $1`, [attemptId]);
  return toAttempt(requireRow(result.rows));
}

export class RecoveryRepository {
  constructor(private readonly pool: Pool) {}

  async beginByTransferId(transferId: string): Promise<RecoveryAttempt> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(transferId)) {
      throw new FujiError("INVALID_SETTLEMENT_STATE", "A valid persisted transfer ID is required for recovery.");
    }
    return inTransaction(this.pool, async (client) => {
      const target = requireRow((await client.query<{ attempt_id: string }>(`
        SELECT a.id AS attempt_id
        FROM blockchain_private.settlements s
        JOIN blockchain_private.settlement_attempts a ON a.settlement_id = s.id
        WHERE s.transfer_id = $1`, [transferId])).rows);
      await client.query(`
        UPDATE blockchain_private.settlement_attempts
        SET recovery_attempt_count = recovery_attempt_count + 1,
            last_recovery_at = clock_timestamp(),
            last_recovery_code = 'INSPECTING',
            last_recovery_reason = 'On-demand reconciliation inspected the durable attempt.'
        WHERE id = $1`, [target.attempt_id]);
      return readById(client, target.attempt_id);
    });
  }

  async loadById(attemptId: string): Promise<RecoveryAttempt> {
    return inTransaction(this.pool, (client) => readById(client, attemptId));
  }

  async record(attemptId: string, code: RecoveryCode, reason: string): Promise<RecoveryAttempt> {
    return inTransaction(this.pool, async (client) => {
      const result = await client.query(`
        UPDATE blockchain_private.settlement_attempts
        SET last_recovery_at = clock_timestamp(), last_recovery_code = $2, last_recovery_reason = $3
        WHERE id = $1 RETURNING id`, [attemptId, code, reason]);
      requireRow(result.rows);
      return readById(client, attemptId);
    });
  }

  async claimPreparingSign(expected: RecoveryAttempt): Promise<{ claimed: boolean; attempt: RecoveryAttempt }> {
    return inTransaction(this.pool, async (client) => {
      const result = await client.query(`
        UPDATE blockchain_private.settlement_attempts
        SET recovery_sign_claimed_at = clock_timestamp(),
            last_recovery_at = clock_timestamp(),
            last_recovery_code = 'PREPARING_SIGN_CLAIMED',
            last_recovery_reason = 'Recovery claimed one signing action using the reserved nonce.'
        WHERE id = $1 AND attempt_state = 'PREPARING' AND recovery_sign_claimed_at IS NULL
          AND signed_transaction IS NULL AND local_tx_hash IS NULL
          AND chain_id = $2 AND signer_address = $3 AND destination_address = $4
          AND token_address = $5 AND amount_units = $6 AND nonce = $7
        RETURNING id`, [
        expected.attemptId,
        expected.chainId,
        expected.signer,
        expected.destination,
        expected.tokenAddress,
        expected.amountUnits,
        expected.nonce,
      ]);
      return { claimed: result.rows.length === 1, attempt: await readById(client, expected.attemptId) };
    });
  }

  async claimExactRebroadcast(expected: RecoveryAttempt): Promise<{ claimed: boolean; attempt: RecoveryAttempt }> {
    return inTransaction(this.pool, async (client) => {
      const result = await client.query(`
        UPDATE blockchain_private.settlement_attempts
        SET recovery_rebroadcast_claimed_at = clock_timestamp(),
            last_recovery_at = clock_timestamp(),
            last_recovery_code = 'EXACT_REBROADCAST_CLAIMED',
            last_recovery_reason = 'Recovery claimed one exact-byte rebroadcast after hash and nonce reconciliation.'
        WHERE id = $1 AND attempt_state = 'BROADCAST_REQUESTED'
          AND recovery_rebroadcast_claimed_at IS NULL
          AND signed_transaction IS NOT NULL AND local_tx_hash IS NOT NULL AND network_tx_hash IS NULL
          AND chain_id = $2 AND signer_address = $3 AND destination_address = $4
          AND token_address = $5 AND amount_units = $6 AND nonce = $7
        RETURNING id`, [
        expected.attemptId,
        expected.chainId,
        expected.signer,
        expected.destination,
        expected.tokenAddress,
        expected.amountUnits,
        expected.nonce,
      ]);
      return { claimed: result.rows.length === 1, attempt: await readById(client, expected.attemptId) };
    });
  }
}
