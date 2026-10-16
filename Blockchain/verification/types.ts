import type { Address, Hash, Hex } from "viem";
import type { AttemptState } from "../persistence/types.js";

export type VerificationFailureCode =
  | "TRANSACTION_HASH_MISMATCH"
  | "TRANSACTION_CHAIN_MISMATCH"
  | "SIGNER_MISMATCH"
  | "NONCE_MISMATCH"
  | "TOKEN_MISMATCH"
  | "CALLDATA_MISMATCH"
  | "CALLDATA_DESTINATION_MISMATCH"
  | "CALLDATA_AMOUNT_MISMATCH"
  | "RECEIPT_HASH_MISMATCH"
  | "RECEIPT_BLOCK_MISSING"
  | "TRANSACTION_REVERTED"
  | "TRANSFER_EVENT_MISSING"
  | "TRANSFER_EVENT_WRONG_CONTRACT"
  | "TRANSFER_EVENT_SENDER_MISMATCH"
  | "TRANSFER_EVENT_DESTINATION_MISMATCH"
  | "TRANSFER_EVENT_AMOUNT_MISMATCH"
  | "TRANSFER_EVENT_DUPLICATE"
  | "TRANSFER_EVENT_INTEGRITY_MISMATCH";

export type VerificationStatus = "PENDING" | "CONFIRMED" | "REVERTED" | "VERIFICATION_FAILED";
export type PendingReason = "TRANSACTION_NOT_FOUND" | "RECEIPT_PENDING";

export type ExpectedSettlement = Readonly<{
  settlementId: string;
  attemptId: string;
  transferId: string;
  attemptState: AttemptState;
  chainId: number;
  signer: Address;
  destination: Address;
  tokenAddress: Address;
  amountUnits: string;
  nonce: number;
  localHash: Hash | null;
  networkHash: Hash | null;
  verifiedAt: Date | null;
  receiptBlockNumber: string | null;
  receiptBlockHash: Hash | null;
  receiptStatus: "success" | "reverted" | null;
  transferLogIndex: number | null;
  confirmedAt: Date | null;
  failureCode: VerificationFailureCode | null;
  failureReason: string | null;
}>;

// Explicit public-safe allowlist. Signed bytes and credentials are never loaded.
export type VerificationResultDto = Readonly<{
  settlementId: string;
  attemptId: string;
  transferId: string;
  status: VerificationStatus;
  attemptState: AttemptState;
  pendingReason: PendingReason | null;
  transactionHash: Hash;
  chainId: number;
  signer: Address;
  destination: Address;
  tokenAddress: Address;
  amountUnits: string;
  nonce: number;
  blockNumber: string | null;
  blockHash: Hash | null;
  transferLogIndex: number | null;
  verifiedAt: string | null;
  confirmedAt: string | null;
  failureCode: VerificationFailureCode | null;
  failureReason: string | null;
}>;

export type VerificationTransaction = Readonly<{
  hash: Hash;
  chainId: number | undefined;
  from: Address;
  to: Address | null;
  nonce: number;
  input: Hex;
}>;

export type VerificationLog = Readonly<{
  address: Address;
  data: Hex;
  topics: readonly Hex[];
  logIndex: number | null;
  transactionHash: Hash | null;
  blockNumber: bigint | null;
  blockHash: Hash | null;
  removed: boolean;
}>;

export type VerificationReceipt = Readonly<{
  transactionHash: Hash;
  status: "success" | "reverted";
  blockNumber: bigint | null;
  blockHash: Hash | null;
  logs: readonly VerificationLog[];
}>;

export interface FujiVerificationGateway {
  getChainId(): Promise<number>;
  getTransaction(hash: Hash): Promise<VerificationTransaction | null>;
  getReceipt(hash: Hash): Promise<VerificationReceipt | null>;
}

export type VerificationOutcome = Readonly<{
  state: "CONFIRMED" | "REVERTED" | "VERIFICATION_FAILED";
  receiptBlockNumber: bigint | null;
  receiptBlockHash: Hash | null;
  receiptStatus: "success" | "reverted" | null;
  transferLogIndex: number | null;
  failureCode: VerificationFailureCode | null;
  failureReason: string | null;
}>;
