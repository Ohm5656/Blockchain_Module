import "../fuji/server-only.js";
import type { Pool, PoolClient } from "pg";
import type { Address, Hash } from "viem";
import { FujiError } from "../fuji/errors.js";
import type { AttemptState } from "../persistence/types.js";
import { inTransaction } from "../persistence/database.js";
import type {
  ExpectedSettlement,
  VerificationFailureCode,
  VerificationOutcome,
} from "./types.js";

type VerificationRow = {
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
};

const selectExpected = `
  SELECT
    s.id AS settlement_id, a.id AS attempt_id, s.transfer_id, a.attempt_state,
    a.chain_id, a.signer_address, a.destination_address, a.token_address,
    a.amount_units, a.nonce, a.local_tx_hash, a.network_tx_hash,
    a.verified_at, a.receipt_block_number, a.receipt_block_hash,
    a.receipt_status, a.verified_transfer_log_index, a.confirmed_at,
    a.verification_failure_code, a.verification_failure_reason
  FROM blockchain_private.settlements s
  JOIN blockchain_private.settlement_attempts a ON a.settlement_id = s.id`;

function requireRow<T>(rows: T[]): T {
  if (rows.length !== 1) {
    throw new FujiError("INVALID_SETTLEMENT_STATE", "Expected exactly one persisted settlement attempt for the transfer ID.");
  }
  return rows[0];
}

function toExpected(row: VerificationRow): ExpectedSettlement {
  const nonce = Number(row.nonce);
  if (!Number.isSafeInteger(nonce) || nonce < 0) {
    throw new FujiError("INVALID_SETTLEMENT_STATE", "Persisted settlement nonce is invalid.");
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
  });
}

async function readById(client: PoolClient, attemptId: string): Promise<ExpectedSettlement> {
  const result = await client.query<VerificationRow>(`${selectExpected} WHERE a.id = $1`, [attemptId]);
  return toExpected(requireRow(result.rows));
}

export class VerificationRepository {
  constructor(private readonly pool: Pool) {}

  async loadByTransferId(transferId: string): Promise<ExpectedSettlement> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(transferId)) {
      throw new FujiError("INVALID_SETTLEMENT_STATE", "A valid persisted transfer ID is required for verification.");
    }
    return inTransaction(this.pool, async (client) => {
      const result = await client.query<VerificationRow>(`${selectExpected} WHERE s.transfer_id = $1`, [transferId]);
      return toExpected(requireRow(result.rows));
    });
  }

  async persistOutcome(expected: ExpectedSettlement, outcome: VerificationOutcome): Promise<ExpectedSettlement> {
    return inTransaction(this.pool, async (client) => {
      const updated = await client.query<{ id: string }>(`
        UPDATE blockchain_private.settlement_attempts
        SET
          attempt_state = $2,
          verified_at = clock_timestamp(),
          receipt_block_number = $3,
          receipt_block_hash = $4,
          receipt_status = $5,
          verified_transfer_log_index = $6,
          confirmed_at = CASE WHEN $2 = 'CONFIRMED' THEN clock_timestamp() ELSE NULL END,
          verification_failure_code = $7,
          verification_failure_reason = $8
        WHERE id = $1
          AND attempt_state = 'BROADCAST_SUBMITTED'
          AND chain_id = $9
          AND signer_address = $10
          AND destination_address = $11
          AND token_address = $12
          AND amount_units = $13
          AND nonce = $14
          AND local_tx_hash = $15
          AND network_tx_hash = $15
        RETURNING id`, [
        expected.attemptId,
        outcome.state,
        outcome.receiptBlockNumber?.toString() ?? null,
        outcome.receiptBlockHash?.toLowerCase() ?? null,
        outcome.receiptStatus,
        outcome.transferLogIndex,
        outcome.failureCode,
        outcome.failureReason,
        expected.chainId,
        expected.signer,
        expected.destination,
        expected.tokenAddress,
        expected.amountUnits,
        expected.nonce,
        expected.networkHash,
      ]);

      const canonical = await readById(client, expected.attemptId);
      if (updated.rows.length === 1) return canonical;
      if (["CONFIRMED", "REVERTED", "VERIFICATION_FAILED"].includes(canonical.attemptState)) {
        return canonical;
      }
      throw new FujiError("INVALID_SETTLEMENT_STATE", "Settlement changed while verification evidence was being persisted.");
    });
  }
}
