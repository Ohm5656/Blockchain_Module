export type FujiErrorCode =
  | "CONFIG" | "RPC_UNAVAILABLE" | "WRONG_CHAIN" | "TOKEN_METADATA"
  | "INVALID_ADDRESS" | "INVALID_AMOUNT" | "NO_GAS" | "INSUFFICIENT_USDC"
  | "SIMULATION_FAILED" | "PREPARATION_FAILED" | "SIGNING_FAILED"
  | "INVALID_SIGNED_TRANSACTION" | "BROADCAST_FAILED" | "HASH_MISMATCH"
  | "IDEMPOTENCY_CONFLICT" | "PERSISTENCE_FAILED" | "NONCE_ALLOCATION_FAILED"
  | "INVALID_SETTLEMENT_STATE" | "VERIFICATION_RPC_ERROR" | "RECOVERY_RPC_ERROR";

export class FujiError extends Error {
  constructor(public readonly code: FujiErrorCode, message: string) {
    super(message);
    this.name = "FujiError";
  }
}

// Do not attach raw viem errors: they may contain credential-bearing RPC URLs
// and serialized signed transactions. Callers may safely log this error.
export async function fujiOperation<T>(
  code: FujiErrorCode,
  message: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof FujiError) throw error;
    throw new FujiError(code, message);
  }
}
