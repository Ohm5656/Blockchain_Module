import { getFujiAvaxBalance, getFujiUsdcBalance, getFujiUsdcMetadata } from "./balances.js";
import { assertFujiNetwork, fujiPublicClient, getFujiSignerAccount } from "./clients.js";
import { FUJI_USDC_ADDRESS, getFujiDestinationAddress } from "./config.js";
import { fujiOperation } from "./errors.js";

// Network/token readiness is read-only and does not need wallet credentials.
export async function getFujiNetworkHealth() {
  const chainId = await assertFujiNetwork();
  const [blockNumber, usdc] = await Promise.all([
    fujiOperation("RPC_UNAVAILABLE", "Could not read the latest Fuji block.",
      () => fujiPublicClient.getBlockNumber({ cacheTime: 0 })),
    getFujiUsdcMetadata(),
  ]);
  return { connected: true as const, chainId, blockNumber: blockNumber.toString(), usdcContract: FUJI_USDC_ADDRESS, usdc };
}

export async function getFujiModuleHealth() {
  const signer = getFujiSignerAccount();
  const destinationAddress = getFujiDestinationAddress();
  const network = await getFujiNetworkHealth();
  const [avax, usdc] = await Promise.all([
    getFujiAvaxBalance(signer.address),
    getFujiUsdcBalance(signer.address),
  ]);
  return {
    ...network,
    signerAddress: signer.address,
    destinationAddress,
    avax: { units: avax.units.toString(), formatted: avax.formatted },
    usdc: { ...network.usdc, units: usdc.units.toString(), formatted: usdc.formatted },
  };
}

export type FujiNetworkHealth = Awaited<ReturnType<typeof getFujiNetworkHealth>>;
export type FujiModuleHealth = Awaited<ReturnType<typeof getFujiModuleHealth>>;
