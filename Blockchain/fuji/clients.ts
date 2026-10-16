import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FUJI_CHAIN, FUJI_CHAIN_ID, FUJI_RPC_URL, getFujiSignerPrivateKey } from "./config.js";
import { FujiError, fujiOperation } from "./errors.js";

const transport = () => http(FUJI_RPC_URL, { retryCount: 0, timeout: 15_000 });

export const fujiPublicClient = createPublicClient({
  chain: FUJI_CHAIN,
  transport: transport(),
  cacheTime: 0,
});

export function getFujiSignerAccount() {
  const key = getFujiSignerPrivateKey();
  try {
    return privateKeyToAccount(key);
  } catch {
    throw new FujiError("CONFIG", "FUJI_SIGNER_PRIVATE_KEY is not a valid secp256k1 private key.");
  }
}

export function getFujiWalletClient(account = getFujiSignerAccount()) {
  return createWalletClient({ account, chain: FUJI_CHAIN, transport: transport(), cacheTime: 0 });
}

export async function assertFujiNetwork(): Promise<number> {
  const chainId = await fujiOperation(
    "RPC_UNAVAILABLE",
    "Fuji RPC unavailable. Check AVALANCHE_FUJI_RPC_URL and network connectivity.",
    () => fujiPublicClient.getChainId(),
  );
  if (chainId !== FUJI_CHAIN_ID) {
    throw new FujiError("WRONG_CHAIN", `Expected Avalanche Fuji chain ID ${FUJI_CHAIN_ID}, received ${chainId}.`);
  }
  return chainId;
}
