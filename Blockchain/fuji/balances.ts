import { formatEther, formatUnits, type Address } from "viem";
import { assertFujiNetwork, fujiPublicClient } from "./clients.js";
import { FUJI_USDC_ADDRESS, FUJI_USDC_DECIMALS, validateFujiAddress } from "./config.js";
import { ERC20_ABI } from "./erc20.js";
import { FujiError, fujiOperation } from "./errors.js";

export async function getFujiAvaxBalance(address: Address) {
  const wallet = validateFujiAddress(address);
  await assertFujiNetwork();
  const units = await fujiOperation("RPC_UNAVAILABLE", "Could not read Test AVAX balance from Fuji RPC.",
    () => fujiPublicClient.getBalance({ address: wallet }));
  return { units, formatted: formatEther(units) };
}

export async function getFujiUsdcBalance(address: Address) {
  const wallet = validateFujiAddress(address);
  await assertFujiNetwork();
  const units = await fujiOperation("RPC_UNAVAILABLE", "Could not read Circle Test USDC balance from Fuji RPC.",
    () => fujiPublicClient.readContract({
      address: FUJI_USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet],
    }));
  return { units, formatted: formatUnits(units, FUJI_USDC_DECIMALS) };
}

export async function getFujiUsdcMetadata() {
  await assertFujiNetwork();
  const [symbol, decimals] = await fujiOperation("RPC_UNAVAILABLE", "Could not read Circle Test USDC metadata from Fuji RPC.",
    () => Promise.all([
      fujiPublicClient.readContract({ address: FUJI_USDC_ADDRESS, abi: ERC20_ABI, functionName: "symbol" }),
      fujiPublicClient.readContract({ address: FUJI_USDC_ADDRESS, abi: ERC20_ABI, functionName: "decimals" }),
    ]));
  if (decimals !== FUJI_USDC_DECIMALS || symbol !== "USDC") {
    throw new FujiError("TOKEN_METADATA", "Expected Circle Test USDC metadata: symbol USDC and 6 decimals.");
  }
  return { symbol, decimals };
}
