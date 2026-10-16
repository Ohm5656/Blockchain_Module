import { reportFailure } from "./cli.js";

async function main() {
  const { createSettlementPool, createPersistedSettlementService } = await import("../persistence/index.js");
  const { getFujiDestinationAddress, getFujiSmokeAmount } = await import("../fuji/config.js");
  const { FujiError } = await import("../fuji/errors.js");
  const transferId = process.env.FUJI_SETTLEMENT_TRANSFER_ID;
  if (!transferId) throw new FujiError("CONFIG", "FUJI_SETTLEMENT_TRANSFER_ID is required. Use the same stable ID when repeating a logical test request.");
  const request = { transferId, destination: getFujiDestinationAddress(), amountUnits: getFujiSmokeAmount() };
  const pool = createSettlementPool();
  try {
    const service = createPersistedSettlementService(pool);
    const result = await service.executePersistedSettlement(request);
    console.log(JSON.stringify(result, null, 2)); // Safe DTO only; never signed bytes.
    console.log("Task 2 only: submission is not receipt confirmation. PREPARING/BROADCAST_REQUESTED require later manual investigation.");
  } finally {
    await pool.end();
  }
}
main().catch(reportFailure);
