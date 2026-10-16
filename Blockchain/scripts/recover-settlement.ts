import { reportFailure } from "./cli.js";

async function main() {
  const { createSettlementPool } = await import("../persistence/index.js");
  const { createRecoveryService } = await import("../recovery/index.js");
  const { FujiError } = await import("../fuji/errors.js");
  const transferId = process.argv[2] ?? process.env.FUJI_SETTLEMENT_TRANSFER_ID;
  if (!transferId) {
    throw new FujiError(
      "CONFIG",
      "Provide an existing transfer ID as the first argument or FUJI_SETTLEMENT_TRANSFER_ID.",
    );
  }
  const pool = createSettlementPool();
  try {
    const result = await createRecoveryService(pool).reconcilePersistedSettlement(transferId);
    console.log(JSON.stringify(result, null, 2));
    console.log("One bounded Task 4 reconciliation completed. No loop, replacement, gas bump, or unrelated payment was created.");
  } finally {
    await pool.end();
  }
}

main().catch(reportFailure);
