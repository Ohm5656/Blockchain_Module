import {
  decodeFunctionData, encodeFunctionData, keccak256, parseTransaction,
  recoverTransactionAddress, type Address, type Hash, type Hex, type TransactionSerialized,
} from "viem";
import { assertFujiNetwork, fujiPublicClient, getFujiSignerAccount, getFujiWalletClient } from "./clients.js";
import { assertUsdcAmount, FUJI_CHAIN_ID, FUJI_USDC_ADDRESS, validateFujiAddress } from "./config.js";
import { getFujiAvaxBalance, getFujiUsdcBalance, getFujiUsdcMetadata } from "./balances.js";
import { ERC20_ABI } from "./erc20.js";
import { FujiError, fujiOperation } from "./errors.js";

export type SignedUsdcTransfer = Readonly<{
  chainId: typeof FUJI_CHAIN_ID;
  signer: Address;
  destination: Address;
  tokenAddress: Address;
  amountUnits: bigint;
  nonce: number;
  serializedTransaction: Hex;
  localHash: Hash;
}>;

export async function prepareAndSignUsdcTransfer(
  destinationInput: Address,
  amountUnits: bigint,
  options: { nonce?: number } = {},
): Promise<SignedUsdcTransfer> {
  assertUsdcAmount(amountUnits);
  if (options.nonce !== undefined && (!Number.isSafeInteger(options.nonce) || options.nonce < 0)) {
    throw new FujiError("PREPARATION_FAILED", "Reserved nonce must be a nonnegative safe integer.");
  }
  const destination = validateFujiAddress(destinationInput, "Destination");
  const account = getFujiSignerAccount();
  if (destination === account.address) {
    throw new FujiError("INVALID_ADDRESS", "Wallet B must differ from signer Wallet A.");
  }
  await assertFujiNetwork();
  const [avax, usdc] = await Promise.all([
    getFujiAvaxBalance(account.address),
    getFujiUsdcBalance(account.address),
    getFujiUsdcMetadata(),
  ]);
  if (avax.units === 0n) throw new FujiError("NO_GAS", "Wallet A has no Test AVAX for gas. Fund it on Fuji.");
  if (usdc.units < amountUnits) {
    throw new FujiError("INSUFFICIENT_USDC", `Insufficient Test USDC: have ${usdc.units} base units, need ${amountUnits}.`);
  }

  const simulation = await fujiOperation("SIMULATION_FAILED",
    "Test USDC transfer simulation failed. Check balances, destination and contract restrictions.",
    () => fujiPublicClient.simulateContract({
      address: FUJI_USDC_ADDRESS, abi: ERC20_ABI, functionName: "transfer",
      args: [destination, amountUnits], account: account.address,
    }));
  if (simulation.result !== true) {
    throw new FujiError("SIMULATION_FAILED", "Test USDC transfer simulation returned false.");
  }

  const walletClient = getFujiWalletClient(account);
  const request = await fujiOperation("PREPARATION_FAILED",
    "Could not prepare the Fuji transaction (pending nonce, gas or fee estimation).",
    async () => {
      // Task 2 supplies a durably reserved nonce; standalone Task 1 callers
      // retain the original pending-nonce behavior.
      const nonce = options.nonce ?? await fujiPublicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
      return walletClient.prepareTransactionRequest({
        account, chainId: FUJI_CHAIN_ID, type: "eip1559", nonce,
        to: FUJI_USDC_ADDRESS, value: 0n,
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [destination, amountUnits] }),
      });
    });
  if (!Number.isSafeInteger(request.nonce) || request.nonce < 0 || request.chainId !== FUJI_CHAIN_ID) {
    throw new FujiError("PREPARATION_FAILED", "Prepared transaction has an invalid nonce or chain ID.");
  }
  if (request.gas * request.maxFeePerGas > avax.units) {
    throw new FujiError("NO_GAS", "Wallet A has insufficient Test AVAX for the estimated maximum gas fee.");
  }

  // Check again before signing; use the local account with a fixed Fuji chain ID.
  await assertFujiNetwork();
  const serializedTransaction = await fujiOperation("SIGNING_FAILED",
    "Local signing of the Fuji transaction failed.",
    () => account.signTransaction(request));
  return Object.freeze({
    chainId: FUJI_CHAIN_ID, signer: account.address, destination,
    tokenAddress: FUJI_USDC_ADDRESS, amountUnits, nonce: request.nonce,
    serializedTransaction, localHash: keccak256(serializedTransaction),
  });
}

// Validate the signed bytes themselves, not only caller-provided metadata.
// This is pre-broadcast envelope validation, NOT receipt/event verification.
export async function validateSignedTransfer(signed: SignedUsdcTransfer): Promise<void> {
  await fujiOperation("INVALID_SIGNED_TRANSACTION", "Signed transaction bytes do not match the Fuji Test USDC transfer metadata.", async () => {
    const tx = parseTransaction(signed.serializedTransaction);
    if (tx.type !== "eip1559") throw new Error();
    const decoded = decodeFunctionData({ abi: ERC20_ABI, data: tx.data ?? "0x" });
    // Parsed above; narrow viem's generic Hex account output to the validated type.
    const signer = await recoverTransactionAddress({
      serializedTransaction: signed.serializedTransaction as TransactionSerialized<"eip1559">,
    });
    if (
      tx.chainId !== FUJI_CHAIN_ID || signed.chainId !== FUJI_CHAIN_ID ||
      tx.to?.toLowerCase() !== FUJI_USDC_ADDRESS.toLowerCase() ||
      signed.tokenAddress.toLowerCase() !== FUJI_USDC_ADDRESS.toLowerCase() ||
      (tx.value ?? 0n) !== 0n || tx.nonce !== signed.nonce ||
      signer.toLowerCase() !== signed.signer.toLowerCase() ||
      decoded.functionName !== "transfer" ||
      decoded.args[0].toLowerCase() !== signed.destination.toLowerCase() ||
      decoded.args[1] !== signed.amountUnits ||
      keccak256(signed.serializedTransaction).toLowerCase() !== signed.localHash.toLowerCase()
    ) throw new Error();
    assertUsdcAmount(signed.amountUnits);
    validateFujiAddress(signed.destination, "Destination");
    if (signer.toLowerCase() === signed.destination.toLowerCase()) throw new Error();
  });
}

// Task 2 can persist the complete SignedUsdcTransfer BEFORE calling this.
// No signer key is required to broadcast an already-signed transaction.
export async function broadcastSignedTransaction(signed: SignedUsdcTransfer): Promise<Hash> {
  await validateSignedTransfer(signed);
  await assertFujiNetwork();
  const networkHash = await fujiOperation("BROADCAST_FAILED",
    `Fuji broadcast failed or its result is uncertain. Local hash: ${signed.localHash}. Do not create another transfer automatically.`,
    () => fujiPublicClient.sendRawTransaction({ serializedTransaction: signed.serializedTransaction }));
  if (networkHash.toLowerCase() !== signed.localHash.toLowerCase()) {
    throw new FujiError("HASH_MISMATCH", `Fuji RPC hash differs from local hash ${signed.localHash}. Broadcast outcome is uncertain; do not resend automatically.`);
  }
  return networkHash;
}
