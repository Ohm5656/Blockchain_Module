import "../fuji/server-only.js";
import type { Pool, PoolClient } from "pg";
import type { Address, Hash, Hex } from "viem";
import { FUJI_CHAIN_ID } from "../fuji/config.js";
import { FujiError } from "../fuji/errors.js";
import type { SignedUsdcTransfer } from "../fuji/settlement.js";
import { inTransaction } from "./database.js";
import type { AttemptState, SettlementDto, SettlementIntent } from "./types.js";

// Internal DB row; deliberately NOT exported from the public module barrel.
type AttemptRow = {
  id: string; settlement_id: string; transfer_id: string;
  chain_id: number; signer_address: Address; destination_address: Address; token_address: Address;
  amount_units: string; nonce: string; attempt_state: AttemptState;
  signed_transaction: Hex | null; local_tx_hash: Hash | null; network_tx_hash: Hash | null;
};
type IntentRow = {
  id: string; transfer_id: string; chain_id: number; signer_address: string;
  destination_address: string; token_address: string; amount_units: string;
};

const readAttemptSql = `
  SELECT a.*, s.transfer_id
  FROM blockchain_private.settlement_attempts a
  JOIN blockchain_private.settlements s ON s.id = a.settlement_id
  WHERE a.id = $1`;

function requireRow<T>(rows: T[]): T {
  if (rows.length !== 1) throw new FujiError("INVALID_SETTLEMENT_STATE", "Expected exactly one persisted settlement attempt.");
  return rows[0];
}

function toDto(row: AttemptRow): SettlementDto {
  return Object.freeze({
    settlementId: row.settlement_id, attemptId: row.id, transferId: row.transfer_id,
    status: row.attempt_state, chainId: row.chain_id, signer: row.signer_address,
    destination: row.destination_address, tokenAddress: row.token_address,
    amountUnits: row.amount_units, nonce: Number(row.nonce),
    localHash: row.local_tx_hash, networkHash: row.network_tx_hash,
  });
}

async function readAttempt(client: PoolClient, id: string): Promise<AttemptRow> {
  return requireRow((await client.query<AttemptRow>(readAttemptSql, [id])).rows);
}

function sameIntent(row: IntentRow, intent: SettlementIntent): boolean {
  return row.chain_id === intent.chainId &&
    row.signer_address === intent.signer &&
    row.destination_address === intent.destination &&
    row.token_address === intent.tokenAddress &&
    row.amount_units === intent.amountUnits.toString();
}

export class SettlementRepository {
  constructor(private readonly pool: Pool) {}

  async claim(intent: SettlementIntent, getPendingNonce: () => Promise<number>): Promise<{ created: boolean; attempt: SettlementDto }> {
    return inTransaction(this.pool, async (client) => {
      // UNIQUE transfer_id arbitrates concurrent first requests. A loser waits for
      // the winner's commit, then reads its durable PREPARING or later attempt.
      const inserted = await client.query<IntentRow>(`
        INSERT INTO blockchain_private.settlements
          (transfer_id, chain_id, signer_address, destination_address, token_address, amount_units)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (transfer_id) DO NOTHING RETURNING *`,
        [intent.transferId, intent.chainId, intent.signer, intent.destination, intent.tokenAddress, intent.amountUnits.toString()]);
      if (inserted.rows.length === 0) {
        const existing = requireRow((await client.query<IntentRow>(
          "SELECT * FROM blockchain_private.settlements WHERE transfer_id = $1", [intent.transferId])).rows);
        if (!sameIntent(existing, intent)) {
          throw new FujiError("IDEMPOTENCY_CONFLICT", "Transfer ID is already claimed with different immutable settlement parameters.");
        }
        const row = requireRow((await client.query<AttemptRow>(`
          SELECT a.*, s.transfer_id FROM blockchain_private.settlement_attempts a
          JOIN blockchain_private.settlements s ON s.id = a.settlement_id WHERE a.settlement_id = $1`, [existing.id])).rows);
        return { created: false, attempt: toDto(row) };
      }

      await client.query(`
        INSERT INTO blockchain_private.signer_nonces (chain_id, signer_address, next_nonce)
        VALUES ($1, $2, 0) ON CONFLICT (chain_id, signer_address) DO NOTHING`, [intent.chainId, intent.signer]);
      const cursor = requireRow((await client.query<{ next_nonce: string }>(`
        SELECT next_nonce FROM blockchain_private.signer_nonces
        WHERE chain_id = $1 AND signer_address = $2 FOR UPDATE`, [intent.chainId, intent.signer])).rows);

      // Read pending AFTER acquiring the DB lock. The cursor never moves back,
      // even when a reservation is left PREPARING by a crashed process.
      const pending = await getPendingNonce();
      if (!Number.isSafeInteger(pending) || pending < 0) {
        throw new FujiError("NONCE_ALLOCATION_FAILED", "Fuji returned an invalid pending nonce.");
      }
      const nonce = BigInt(cursor.next_nonce) > BigInt(pending) ? BigInt(cursor.next_nonce) : BigInt(pending);
      if (nonce >= BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new FujiError("NONCE_ALLOCATION_FAILED", "Signer nonce exceeds the supported safe integer range.");
      }
      await client.query(`
        UPDATE blockchain_private.signer_nonces SET next_nonce = $3
        WHERE chain_id = $1 AND signer_address = $2`, [intent.chainId, intent.signer, (nonce + 1n).toString()]);
      const attempt = requireRow((await client.query<{ id: string }>(`
        INSERT INTO blockchain_private.settlement_attempts
          (settlement_id, chain_id, signer_address, destination_address, token_address, amount_units, nonce, attempt_state)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'PREPARING') RETURNING id`,
        [inserted.rows[0].id, intent.chainId, intent.signer, intent.destination, intent.tokenAddress, intent.amountUnits.toString(), nonce.toString()])).rows);
      return { created: true, attempt: toDto(await readAttempt(client, attempt.id)) };
    });
  }

  async persistSigned(attemptId: string, signed: SignedUsdcTransfer): Promise<SettlementDto> {
    return inTransaction(this.pool, async (client) => {
      const result = await client.query(`
        UPDATE blockchain_private.settlement_attempts
        SET signed_transaction = $2, local_tx_hash = $3, signed_at = clock_timestamp(), attempt_state = 'SIGNED'
        WHERE id = $1 AND attempt_state = 'PREPARING'
          AND chain_id = $4 AND signer_address = $5 AND destination_address = $6
          AND token_address = $7 AND amount_units = $8 AND nonce = $9
        RETURNING id`,
        [attemptId, signed.serializedTransaction, signed.localHash.toLowerCase(), signed.chainId,
          signed.signer.toLowerCase(), signed.destination.toLowerCase(), signed.tokenAddress.toLowerCase(),
          signed.amountUnits.toString(), signed.nonce]);
      requireRow(result.rows);
      return toDto(await readAttempt(client, attemptId));
    });
  }

  async claimBroadcast(
    attemptId: string,
    options: { recovery?: boolean } = {},
  ): Promise<{ attempt: SettlementDto; signed: SignedUsdcTransfer | null }> {
    return inTransaction(this.pool, async (client) => {
      const result = await client.query(`
        UPDATE blockchain_private.settlement_attempts
        SET attempt_state = 'BROADCAST_REQUESTED',
            broadcast_requested_at = clock_timestamp(),
            recovery_rebroadcast_claimed_at = CASE WHEN $2 THEN clock_timestamp() ELSE recovery_rebroadcast_claimed_at END
        WHERE id = $1 AND attempt_state = 'SIGNED'
          AND (NOT $2 OR recovery_rebroadcast_claimed_at IS NULL)
        RETURNING id`, [attemptId, options.recovery === true]);
      const row = await readAttempt(client, attemptId);
      if (result.rows.length === 0) return { attempt: toDto(row), signed: null };
      if (!row.signed_transaction || !row.local_tx_hash || row.chain_id !== FUJI_CHAIN_ID) {
        throw new FujiError("INVALID_SETTLEMENT_STATE", "Broadcast requires a persisted signed Fuji attempt.");
      }
      // Load bytes FROM the DB, not from the previous in-memory signing result.
      // inTransaction does not return this object until COMMIT succeeds.
      return {
        attempt: toDto(row),
        signed: {
          chainId: FUJI_CHAIN_ID, signer: row.signer_address, destination: row.destination_address,
          tokenAddress: row.token_address, amountUnits: BigInt(row.amount_units), nonce: Number(row.nonce),
          serializedTransaction: row.signed_transaction, localHash: row.local_tx_hash,
        },
      };
    });
  }

  async markSubmitted(attemptId: string, networkHash: Hash): Promise<SettlementDto> {
    return inTransaction(this.pool, async (client) => {
      const result = await client.query(`
        UPDATE blockchain_private.settlement_attempts
        SET attempt_state = 'BROADCAST_SUBMITTED', network_tx_hash = $2, broadcast_submitted_at = clock_timestamp()
        WHERE id = $1 AND attempt_state = 'BROADCAST_REQUESTED' AND local_tx_hash = $2 RETURNING id`,
        [attemptId, networkHash.toLowerCase()]);
      requireRow(result.rows);
      return toDto(await readAttempt(client, attemptId));
    });
  }
}
