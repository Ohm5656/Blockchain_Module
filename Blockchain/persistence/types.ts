import type { Address, Hash } from "viem";
import type { SignedUsdcTransfer } from "../fuji/settlement.js";

export type AttemptState =
  | "PREPARING" | "SIGNED" | "BROADCAST_REQUESTED" | "BROADCAST_SUBMITTED"
  | "CONFIRMED" | "REVERTED" | "VERIFICATION_FAILED";
export type SettlementRequest = Readonly<{ transferId: string; destination: Address; amountUnits: bigint }>;

export type SettlementIntent = SettlementRequest & Readonly<{
  chainId: number;
  signer: Address;
  tokenAddress: Address;
}>;

// Explicit allowlist. Never spread a database row or SignedUsdcTransfer into a DTO.
export type SettlementDto = Readonly<{
  settlementId: string;
  attemptId: string;
  transferId: string;
  status: AttemptState;
  chainId: number;
  signer: Address;
  destination: Address;
  tokenAddress: Address;
  amountUnits: string;
  nonce: number;
  localHash: Hash | null;
  networkHash: Hash | null;
}>;

export interface FujiSettlementGateway {
  getIdentity(): { chainId: number; signer: Address; tokenAddress: Address };
  getPendingNonce(signer: Address): Promise<number>;
  prepareAndSign(destination: Address, amountUnits: bigint, nonce: number): Promise<SignedUsdcTransfer>;
  broadcast(signed: SignedUsdcTransfer): Promise<Hash>;
}
