import type { Address, Hash, Hex } from "viem";
import type { SignedUsdcTransfer } from "../fuji/settlement.js";
import type { AttemptState } from "../persistence/types.js";
import type {
  ExpectedSettlement,
  FujiVerificationGateway,
} from "../verification/types.js";

export type RecoveryOutcome =
  | "RECOVERED"
  | "NO_ACTION"
  | "PENDING"
  | "RPC_UNCERTAIN"
  | "NONCE_CONFLICT"
  | "RECOVERY_CONFLICT"
  | "TERMINAL";

export type RecoveryCode =
  | "INSPECTING"
  | "PREPARING_SIGN_CLAIMED"
  | "PREPARING_SIGNED"
  | "SIGNED_BROADCAST_CLAIMED"
  | "SIGNED_BROADCAST_SUBMITTED"
  | "BROADCAST_TRANSACTION_FOUND"
  | "EXACT_REBROADCAST_CLAIMED"
  | "EXACT_REBROADCAST_SUBMITTED"
  | "NONCE_CONFLICT"
  | "TRANSACTION_MISMATCH"
  | "TRANSACTION_PENDING"
  | "VERIFICATION_PENDING"
  | "RPC_UNCERTAIN"
  | "RECOVERY_ACTION_ALREADY_CLAIMED"
  | "SIGNING_FAILED"
  | "INVALID_SIGNED_TRANSACTION"
  | "TERMINAL"
  | "NO_ACTION";

export type NonceState = Readonly<{ latest: number; pending: number }>;

export interface FujiRecoveryGateway extends FujiVerificationGateway {
  getIdentity(): { chainId: number; signer: Address; tokenAddress: Address };
  getNonceState(signer: Address): Promise<NonceState>;
  prepareAndSign(destination: Address, amountUnits: bigint, nonce: number): Promise<SignedUsdcTransfer>;
  broadcast(signed: SignedUsdcTransfer): Promise<Hash>;
}

export type RecoveryAttempt = ExpectedSettlement & Readonly<{
  signedTransaction: Hex | null;
  recoveryAttemptCount: number;
  lastRecoveryAt: Date | null;
  lastRecoveryCode: RecoveryCode | null;
  lastRecoveryReason: string | null;
  recoverySignClaimedAt: Date | null;
  recoveryRebroadcastClaimedAt: Date | null;
}>;

// Explicit safe allowlist. signedTransaction is intentionally absent.
export type RecoveryResultDto = Readonly<{
  settlementId: string;
  attemptId: string;
  transferId: string;
  attemptState: AttemptState;
  recoveryOutcome: RecoveryOutcome;
  recoveryCode: RecoveryCode;
  recoveryReason: string;
  chainId: number;
  signer: Address;
  destination: Address;
  tokenAddress: Address;
  amountUnits: string;
  nonce: number;
  transactionHash: Hash | null;
  blockNumber: string | null;
  blockHash: Hash | null;
  transferLogIndex: number | null;
  verifiedAt: string | null;
  confirmedAt: string | null;
  verificationFailureCode: string | null;
  recoveryAttemptCount: number;
  lastRecoveryAt: string | null;
}>;
