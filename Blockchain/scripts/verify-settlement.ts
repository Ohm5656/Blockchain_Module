import { reportFailure } from "./cli.js";

async function main() {
  const { createSettlementPool } = await import("../persistence/index.js");
  const { createVerificationService } = await import("../verification/index.js");
  const { FujiError } = await import("../fuji/errors.js");
  const transferId = process.env.FUJI_SETTLEMENT_TRANSFER_ID;
  if (!transferId) {
    throw new FujiError("CONFIG", "FUJI_SETTLEMENT_TRANSFER_ID is required to verify an existing persisted settlement.");
  }
  const pool = createSettlementPool();
  try {
    const result = await createVerificationService(pool).verifyPersistedSettlement(transferId);
    console.log(JSON.stringify(result, null, 2));
    console.log("Task 3 is read-only toward Fuji. CONFIRMED covers only the blockchain USDC movement, not fiat/payment completion.");
  } finally {
    await pool.end();
  }
}

main().catch(reportFailure);
