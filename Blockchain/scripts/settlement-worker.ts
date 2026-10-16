import { FujiError } from "../fuji/errors.js";
import { createSettlementPool } from "../persistence/database.js";
import { createDurableReconciliationRunner } from "../runner/index.js";
import { reportFailure } from "./cli.js";

function envInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new FujiError("CONFIG", `${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new FujiError("CONFIG", `${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

async function main() {
  const pool = createSettlementPool();
  try {
    const result = await createDurableReconciliationRunner(pool).runOnce({
      batchSize: envInteger("FUJI_RUNNER_BATCH_SIZE", 10, 1, 50),
      cooldownMs: envInteger("FUJI_RUNNER_COOLDOWN_MS", 60_000, 0, 86_400_000),
    });
    console.log(JSON.stringify(result));
  } finally {
    await pool.end();
  }
}

main().catch(reportFailure);
