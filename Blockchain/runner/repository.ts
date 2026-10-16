import "../fuji/server-only.js";
import type { Pool } from "pg";
import { FujiError } from "../fuji/errors.js";
import { inTransaction } from "../persistence/database.js";
import type { EligibleSettlement } from "./types.js";

type EligibleRow = {
  transfer_id: string;
  attempt_id: string;
  attempt_state: EligibleSettlement["attemptState"];
};

export class RunnerRepository {
  constructor(private readonly pool: Pool) {}

  async listEligible(options: Readonly<{ limit: number; cooldownMs: number }>): Promise<readonly EligibleSettlement[]> {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 50) {
      throw new FujiError("CONFIG", "Runner batch size must be a safe integer between 1 and 50.");
    }
    if (!Number.isSafeInteger(options.cooldownMs) || options.cooldownMs < 0 || options.cooldownMs > 86_400_000) {
      throw new FujiError("CONFIG", "Runner cooldown must be a safe integer between 0 and 86400000 milliseconds.");
    }
    return inTransaction(this.pool, async (client) => {
      const result = await client.query<EligibleRow>(`
        SELECT s.transfer_id, a.id AS attempt_id, a.attempt_state
        FROM blockchain_private.settlements s
        JOIN blockchain_private.settlement_attempts a ON a.settlement_id = s.id
        WHERE a.attempt_state IN ('PREPARING', 'SIGNED', 'BROADCAST_REQUESTED', 'BROADCAST_SUBMITTED')
          AND (
            a.last_recovery_at IS NULL
            OR a.last_recovery_at <= clock_timestamp() - ($2::bigint * interval '1 millisecond')
          )
        ORDER BY a.last_recovery_at NULLS FIRST, a.created_at ASC, a.id ASC
        LIMIT $1`, [options.limit, options.cooldownMs]);
      return Object.freeze(result.rows.map((row) => Object.freeze({
        transferId: row.transfer_id,
        attemptId: row.attempt_id,
        attemptState: row.attempt_state,
      })));
    });
  }
}
