import "../fuji/server-only.js";
import type { Pool } from "pg";
import {
  decodeEventLog,
  decodeFunctionData,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { FUJI_CHAIN_ID, FUJI_USDC_ADDRESS } from "../fuji/config.js";
import { ERC20_ABI } from "../fuji/erc20.js";
import { FujiError } from "../fuji/errors.js";
import { fujiVerificationGateway } from "./fuji-gateway.js";
import { VerificationRepository } from "./repository.js";
import type {
  ExpectedSettlement,
  FujiVerificationGateway,
  PendingReason,
  VerificationFailureCode,
  VerificationLog,
  VerificationOutcome,
  VerificationReceipt,
  VerificationResultDto,
  VerificationTransaction,
} from "./types.js";

const terminalStates = new Set(["CONFIRMED", "REVERTED", "VERIFICATION_FAILED"]);

function sameAddress(actual: Address | null, expected: Address): boolean {
  return actual?.toLowerCase() === expected.toLowerCase();
}

function validHash(value: unknown): value is Hash {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function receiptEvidence(receipt?: VerificationReceipt) {
  if (!receipt || receipt.blockNumber === null || !validHash(receipt.blockHash)) {
    return { receiptBlockNumber: null, receiptBlockHash: null, receiptStatus: null } as const;
  }
  return {
    receiptBlockNumber: receipt.blockNumber,
    receiptBlockHash: receipt.blockHash,
    receiptStatus: receipt.status,
  } as const;
}

function failed(
  code: VerificationFailureCode,
  reason: string,
  receipt?: VerificationReceipt,
): VerificationOutcome {
  return {
    state: "VERIFICATION_FAILED",
    ...receiptEvidence(receipt),
    transferLogIndex: null,
    failureCode: code,
    failureReason: reason,
  };
}

function toDto(expected: ExpectedSettlement, pendingReason: PendingReason | null = null): VerificationResultDto {
  if (!expected.networkHash) {
    throw new FujiError("INVALID_SETTLEMENT_STATE", "Verification requires a persisted network transaction hash.");
  }
  const status = pendingReason ? "PENDING" : expected.attemptState;
  if (!["PENDING", "CONFIRMED", "REVERTED", "VERIFICATION_FAILED"].includes(status)) {
    throw new FujiError("INVALID_SETTLEMENT_STATE", "Settlement is not in a verifiable or terminal verification state.");
  }
  return Object.freeze({
    settlementId: expected.settlementId,
    attemptId: expected.attemptId,
    transferId: expected.transferId,
    status: status as VerificationResultDto["status"],
    attemptState: expected.attemptState,
    pendingReason,
    transactionHash: expected.networkHash,
    chainId: expected.chainId,
    signer: expected.signer,
    destination: expected.destination,
    tokenAddress: expected.tokenAddress,
    amountUnits: expected.amountUnits,
    nonce: expected.nonce,
    blockNumber: expected.receiptBlockNumber,
    blockHash: expected.receiptBlockHash,
    transferLogIndex: expected.transferLogIndex,
    verifiedAt: expected.verifiedAt?.toISOString() ?? null,
    confirmedAt: expected.confirmedAt?.toISOString() ?? null,
    failureCode: expected.failureCode,
    failureReason: expected.failureReason,
  });
}

export function verifyExpectedTransaction(
  expected: ExpectedSettlement,
  transaction: VerificationTransaction,
  expectedHash: Hash | null = expected.networkHash,
): VerificationOutcome | null {
  if (!expectedHash || transaction.hash.toLowerCase() !== expectedHash.toLowerCase()) {
    return failed("TRANSACTION_HASH_MISMATCH", "Fuji transaction hash does not match the persisted transaction hash.");
  }
  if (transaction.chainId !== expected.chainId || transaction.chainId !== FUJI_CHAIN_ID) {
    return failed("TRANSACTION_CHAIN_MISMATCH", "Transaction chain ID does not match persisted Avalanche Fuji chain 43113.");
  }
  if (!sameAddress(transaction.from, expected.signer)) {
    return failed("SIGNER_MISMATCH", "Transaction sender does not match the persisted signer.");
  }
  if (transaction.nonce !== expected.nonce) {
    return failed("NONCE_MISMATCH", "Transaction nonce does not match the persisted nonce.");
  }
  if (!sameAddress(transaction.to, expected.tokenAddress) || !sameAddress(transaction.to, FUJI_USDC_ADDRESS)) {
    return failed("TOKEN_MISMATCH", "Transaction target is not the persisted Circle Test USDC contract.");
  }

  try {
    const decoded = decodeFunctionData({ abi: ERC20_ABI, data: transaction.input });
    if (decoded.functionName !== "transfer") {
      return failed("CALLDATA_MISMATCH", "Transaction calldata is not ERC-20 transfer(address,uint256).");
    }
    const [destination, amountUnits] = decoded.args;
    if (!sameAddress(destination, expected.destination)) {
      return failed("CALLDATA_DESTINATION_MISMATCH", "Decoded transfer destination does not match the persisted destination.");
    }
    if (amountUnits !== BigInt(expected.amountUnits)) {
      return failed("CALLDATA_AMOUNT_MISMATCH", "Decoded transfer amount does not match the persisted base-unit amount.");
    }
  } catch {
    return failed("CALLDATA_MISMATCH", "Transaction calldata cannot be decoded as the expected ERC-20 transfer.");
  }
  return null;
}

type DecodedTransfer = { log: VerificationLog; from: Address; to: Address; value: bigint };

function decodeTransfers(logs: readonly VerificationLog[]): DecodedTransfer[] {
  const decoded: DecodedTransfer[] = [];
  for (const log of logs) {
    try {
      if (log.topics.length === 0) continue;
      const event = decodeEventLog({
        abi: ERC20_ABI,
        eventName: "Transfer",
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        strict: true,
      });
      decoded.push({ log, from: event.args.from, to: event.args.to, value: event.args.value });
    } catch {
      // An unrelated or malformed log is not accepted as Transfer evidence.
    }
  }
  return decoded;
}

function verifyReceipt(expected: ExpectedSettlement, receipt: VerificationReceipt): VerificationOutcome {
  if (receipt.transactionHash.toLowerCase() !== expected.networkHash?.toLowerCase()) {
    return failed("RECEIPT_HASH_MISMATCH", "Receipt transaction hash does not match the persisted transaction hash.", receipt);
  }
  if (receipt.blockNumber === null || receipt.blockNumber < 0n || !validHash(receipt.blockHash)) {
    return failed("RECEIPT_BLOCK_MISSING", "Receipt is missing a valid block number or block hash.");
  }
  if (receipt.status === "reverted") {
    return {
      state: "REVERTED",
      ...receiptEvidence(receipt),
      transferLogIndex: null,
      failureCode: "TRANSACTION_REVERTED",
      failureReason: "Fuji receipt definitively reports reverted execution.",
    };
  }

  const transfers = decodeTransfers(receipt.logs);
  const tokenTransfers = transfers.filter(({ log }) => sameAddress(log.address, expected.tokenAddress));
  if (tokenTransfers.length === 0) {
    const exactFromWrongContract = transfers.some(({ from, to, value }) =>
      sameAddress(from, expected.signer) && sameAddress(to, expected.destination) && value === BigInt(expected.amountUnits));
    return failed(
      exactFromWrongContract ? "TRANSFER_EVENT_WRONG_CONTRACT" : "TRANSFER_EVENT_MISSING",
      exactFromWrongContract
        ? "Matching Transfer values were emitted by a different contract, not persisted Test USDC."
        : "Expected Circle Test USDC Transfer event is missing from the successful receipt.",
      receipt,
    );
  }
  if (tokenTransfers.length !== 1) {
    return failed("TRANSFER_EVENT_DUPLICATE", "Receipt contains more than one Test USDC Transfer event; exact movement is ambiguous.", receipt);
  }
  const transfer = tokenTransfers[0];
  if (!sameAddress(transfer.from, expected.signer)) {
    return failed("TRANSFER_EVENT_SENDER_MISMATCH", "Transfer event sender does not match the persisted signer.", receipt);
  }
  if (!sameAddress(transfer.to, expected.destination)) {
    return failed("TRANSFER_EVENT_DESTINATION_MISMATCH", "Transfer event destination does not match the persisted destination.", receipt);
  }
  if (transfer.value !== BigInt(expected.amountUnits)) {
    return failed("TRANSFER_EVENT_AMOUNT_MISMATCH", "Transfer event value does not match the persisted base-unit amount.", receipt);
  }
  const log = transfer.log;
  if (
    log.removed || log.logIndex === null || log.logIndex < 0 ||
    log.transactionHash?.toLowerCase() !== receipt.transactionHash.toLowerCase() ||
    log.blockHash?.toLowerCase() !== receipt.blockHash.toLowerCase() ||
    log.blockNumber !== receipt.blockNumber
  ) {
    return failed("TRANSFER_EVENT_INTEGRITY_MISMATCH", "Transfer log is removed or does not belong to the verified receipt block and transaction.", receipt);
  }
  return {
    state: "CONFIRMED",
    ...receiptEvidence(receipt),
    transferLogIndex: log.logIndex,
    failureCode: null,
    failureReason: null,
  };
}

async function rpcRead<T>(operation: () => Promise<T>, message: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof FujiError) throw error;
    throw new FujiError("VERIFICATION_RPC_ERROR", message);
  }
}

export function createVerificationService(
  pool: Pool,
  gateway: FujiVerificationGateway = fujiVerificationGateway,
) {
  const repository = new VerificationRepository(pool);

  async function verifyPersistedSettlement(transferId: string): Promise<VerificationResultDto> {
    const expected = await repository.loadByTransferId(transferId);
    if (terminalStates.has(expected.attemptState)) return toDto(expected);
    if (
      expected.attemptState !== "BROADCAST_SUBMITTED" ||
      !expected.localHash || !expected.networkHash ||
      expected.localHash.toLowerCase() !== expected.networkHash.toLowerCase()
    ) {
      throw new FujiError(
        "INVALID_SETTLEMENT_STATE",
        "Only a BROADCAST_SUBMITTED attempt with matching persisted hashes may be verified; uncertain BROADCAST_REQUESTED belongs to Task 4.",
      );
    }

    const chainId = await rpcRead(() => gateway.getChainId(), "Could not reliably determine the Fuji chain; verification state was not changed.");
    if (chainId !== FUJI_CHAIN_ID || chainId !== expected.chainId) {
      throw new FujiError("WRONG_CHAIN", `Expected Avalanche Fuji chain ID ${FUJI_CHAIN_ID}, received ${chainId}.`);
    }

    const transaction = await rpcRead(
      () => gateway.getTransaction(expected.networkHash!),
      "Could not reliably read the Fuji transaction; verification state was not changed.",
    );
    if (!transaction) return toDto(expected, "TRANSACTION_NOT_FOUND");
    const transactionFailure = verifyExpectedTransaction(expected, transaction);
    if (transactionFailure) return toDto(await repository.persistOutcome(expected, transactionFailure));

    const receipt = await rpcRead(
      () => gateway.getReceipt(expected.networkHash!),
      "Could not reliably read the Fuji receipt; verification state was not changed.",
    );
    if (!receipt) return toDto(expected, "RECEIPT_PENDING");

    return toDto(await repository.persistOutcome(expected, verifyReceipt(expected, receipt)));
  }

  return { verifyPersistedSettlement };
}
