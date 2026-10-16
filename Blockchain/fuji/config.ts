import "./server-only.js";
import { getAddress, isAddress, maxUint256, zeroAddress, type Address, type Hex } from "viem";
import { avalancheFuji } from "viem/chains";
import { FujiError } from "./errors.js";

export const FUJI_CHAIN = avalancheFuji;
export const FUJI_CHAIN_ID = 43113;
export const FUJI_USDC_DECIMALS = 6;
const CIRCLE_FUJI_USDC = getAddress("0x5425890298aed601595a70AB815c96711a31Bc65");

export function validateFujiAddress(value: string, label = "Wallet address"): Address {
  if (!isAddress(value, { strict: true }) || value.toLowerCase() === zeroAddress) {
    throw new FujiError("INVALID_ADDRESS", `${label} must be a valid nonzero Ethereum address (check its checksum).`);
  }
  return getAddress(value);
}

function getRpcUrl(): string {
  const value = process.env.AVALANCHE_FUJI_RPC_URL ?? "https://api.avax-test.network/ext/bc/C/rpc";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    return value;
  } catch {
    throw new FujiError("CONFIG", "AVALANCHE_FUJI_RPC_URL must be a valid HTTP(S) Fuji RPC endpoint.");
  }
}

function getTokenAddress(): Address {
  const address = validateFujiAddress(process.env.FUJI_USDC_ADDRESS ?? CIRCLE_FUJI_USDC, "FUJI_USDC_ADDRESS");
  if (address !== CIRCLE_FUJI_USDC) {
    throw new FujiError("CONFIG", "FUJI_USDC_ADDRESS must be the official Circle Test USDC contract on Fuji.");
  }
  return address;
}

export const FUJI_RPC_URL = getRpcUrl();
export const FUJI_USDC_ADDRESS = getTokenAddress();

export function getFujiSignerPrivateKey(): Hex {
  const value = process.env.FUJI_SIGNER_PRIVATE_KEY;
  if (!value) {
    throw new FujiError("CONFIG", "FUJI_SIGNER_PRIVATE_KEY is missing. Set a dedicated test-only Wallet A key in server-side .env.local.");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new FujiError("CONFIG", "FUJI_SIGNER_PRIVATE_KEY must be a 32-byte hex private key beginning with 0x.");
  }
  return value as Hex;
}

export function getFujiDestinationAddress(): Address {
  const value = process.env.FUJI_DESTINATION_ADDRESS;
  if (!value) {
    throw new FujiError("CONFIG", "FUJI_DESTINATION_ADDRESS is missing. Set test-only Wallet B in .env.local.");
  }
  return validateFujiAddress(value, "FUJI_DESTINATION_ADDRESS");
}

export function assertUsdcAmount(amountUnits: bigint): void {
  if (typeof amountUnits !== "bigint" || amountUnits <= 0n || amountUnits > maxUint256) {
    throw new FujiError("INVALID_AMOUNT", "USDC amount must be a positive bigint in base units within uint256 (6 decimals).");
  }
}

export function getFujiSmokeAmount(): bigint {
  const value = process.env.FUJI_SMOKE_TEST_USDC_UNITS ?? "1000";
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new FujiError("INVALID_AMOUNT", "FUJI_SMOKE_TEST_USDC_UNITS must be a positive integer in base units.");
  }
  const amount = BigInt(value);
  assertUsdcAmount(amount);
  return amount;
}
