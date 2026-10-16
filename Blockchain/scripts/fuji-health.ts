import { reportFailure } from "./cli.js";

async function main() {
  const { getFujiModuleHealth, getFujiNetworkHealth } = await import("../fuji/index.js");
  const networkOnly = process.argv.includes("--network-only");
  const health = await (networkOnly ? getFujiNetworkHealth() : getFujiModuleHealth());
  console.log(JSON.stringify(health, null, 2));
}
main().catch(reportFailure);
