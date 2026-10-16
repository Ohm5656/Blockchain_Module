import "../fuji/server-only.js";
import type { Pool } from "pg";
import type { Address } from "viem";
import { FUJI_CHAIN_ID, FUJI_USDC_ADDRESS } from "../fuji/config.js";
import { FujiError } from "../fuji/errors.js";
import { validateSignedTransfer, type SignedUsdcTransfer } from "../fuji/settlement.js";
import { SettlementRepository } from "../persistence/repository.js";
import { createVerificationService, verifyExpectedTransaction } from "../verification/service.js";
import { fujiRecoveryGateway } from "./fuji-gateway.js";
import { RecoveryRepository } from "./repository.js";
import type {
  FujiRecoveryGateway,
  NonceState,
  RecoveryAttempt,
  RecoveryCode,
  RecoveryOutcome,
  RecoveryResultDto,
} from "./types.js";

const terminalStates = new Set(["CONFIRMED", "REVERTED", "VERIFICATION_FAILED"]);

function sameAddress(actual: Address, expected: Address): boolean {
  return actual.toLowerCase() === expected.toLowerCase();
}

function toDto(
  attempt: RecoveryAttempt,
  recoveryOutcome: RecoveryOutcome,
  recoveryCode: RecoveryCode,
  recoveryReason: string,
): RecoveryResultDto {
  return Object.freeze({
    settlementId: attempt.settlementId,
    attemptId: attempt.attemptId,
    transferId: attempt.transferId,
    attemptState: attempt.attemptState,
    recoveryOutcome,
    recoveryCode,
    recoveryReason,
    chainId: attempt.chainId,
    signer: attempt.signer,
    destination: attempt.destination,
    tokenAddress: attempt.tokenAddress,
    amountUnits: attempt.amountUnits,
    nonce: attempt.nonce,
    transactionHash: attempt.networkHash ?? attempt.localHash,
    blockNumber: attempt.receiptBlockNumber,
    blockHash: attempt.receiptBlockHash,
    transferLogIndex: attempt.transferLogIndex,
    verifiedAt: attempt.verifiedAt?.toISOString() ?? null,
    confirmedAt: attempt.confirmedAt?.toISOString() ?? null,
    verificationFailureCode: attempt.failureCode,
    recoveryAttemptCount: attempt.recoveryAttemptCount,
    lastRecoveryAt: attempt.lastRecoveryAt?.toISOString() ?? null,
  });
}

function validNonceState(value: NonceState): boolean {
  return Number.isSafeInteger(value.latest) && value.latest >= 0 &&
    Number.isSafeInteger(value.pending) && value.pending >= value.latest;
}

function nonceConsumed(value: NonceState, reservedNonce: number): boolean {
  return value.latest > reservedNonce || value.pending > reservedNonce;
}

function signedFrom(attempt: RecoveryAttempt): SignedUsdcTransfer {
  if (!attempt.signedTransaction || !attempt.localHash) {
    throw new FujiError("INVALID_SETTLEMENT_STATE", "Recovery requires exact persisted signed bytes and local transaction hash.");
  }
  return {
    chainId: FUJI_CHAIN_ID,
    signer: attempt.signer,
    destination: attempt.destination,
    tokenAddress: attempt.tokenAddress,
    amountUnits: BigInt(attempt.amountUnits),
    nonce: attempt.nonce,
    serializedTransaction: attempt.signedTransaction,
    localHash: attempt.localHash,
  };
}

export function createRecoveryService(
  pool: Pool,
  gateway: FujiRecoveryGateway = fujiRecoveryGateway,
) {
  const recoveryRepository = new RecoveryRepository(pool);
  const settlementRepository = new SettlementRepository(pool);
  const verificationService = createVerificationService(pool, gateway);

  async function recordResult(
    attemptId: string,
    outcome: RecoveryOutcome,
    code: RecoveryCode,
    reason: string,
  ): Promise<RecoveryResultDto> {
    return toDto(await recoveryRepository.record(attemptId, code, reason), outcome, code, reason);
  }

  async function rpcUncertain(attemptId: string, reason: string): Promise<RecoveryResultDto> {
    return recordResult(attemptId, "RPC_UNCERTAIN", "RPC_UNCERTAIN", reason);
  }

  async function readRpc<T>(
    attemptId: string,
    operation: () => Promise<T>,
    reason: string,
  ): Promise<{ value: T; uncertain: null } | { value: null; uncertain: RecoveryResultDto }> {
    try {
      return { value: await operation(), uncertain: null };
    } catch (error) {
      if (error instanceof FujiError && error.code === "WRONG_CHAIN") throw error;
      return { value: null, uncertain: await rpcUncertain(attemptId, reason) };
    }
  }

  async function requireFuji(attempt: RecoveryAttempt): Promise<RecoveryResultDto | null> {
    const read = await readRpc(
      attempt.attemptId,
      () => gateway.getChainId(),
      "Fuji chain identity could not be determined; no recovery action was performed.",
    );
    if (read.uncertain) return read.uncertain;
    if (read.value !== FUJI_CHAIN_ID || read.value !== attempt.chainId) {
      await recoveryRepository.record(
        attempt.attemptId,
        "NO_ACTION",
        "Recovery rejected a chain other than persisted Avalanche Fuji chain 43113.",
      );
      throw new FujiError("WRONG_CHAIN", `Expected Avalanche Fuji chain ID ${FUJI_CHAIN_ID}, received ${read.value}.`);
    }
    return null;
  }

  async function readNonceState(attempt: RecoveryAttempt): Promise<NonceState | RecoveryResultDto> {
    const read = await readRpc(
      attempt.attemptId,
      () => gateway.getNonceState(attempt.signer),
      "Fuji signer nonce state could not be determined; no signing or rebroadcast was performed.",
    );
    if (read.uncertain) return read.uncertain;
    if (!validNonceState(read.value)) {
      return rpcUncertain(
        attempt.attemptId,
        "Fuji returned invalid latest/pending nonce evidence; no recovery action was performed.",
      );
    }
    return read.value;
  }

  async function recoverPreparing(attempt: RecoveryAttempt): Promise<RecoveryResultDto> {
    const chainResult = await requireFuji(attempt);
    if (chainResult) return chainResult;

    const identity = gateway.getIdentity();
    if (
      identity.chainId !== attempt.chainId || identity.chainId !== FUJI_CHAIN_ID ||
      !sameAddress(identity.signer, attempt.signer) ||
      !sameAddress(identity.tokenAddress, attempt.tokenAddress) ||
      !sameAddress(identity.tokenAddress, FUJI_USDC_ADDRESS)
    ) {
      return recordResult(
        attempt.attemptId,
        "RECOVERY_CONFLICT",
        "NO_ACTION",
        "Configured recovery signer/token identity does not match the persisted settlement.",
      );
    }

    const nonceState = await readNonceState(attempt);
    if ("recoveryOutcome" in nonceState) return nonceState;
    if (nonceConsumed(nonceState, attempt.nonce)) {
      return recordResult(
        attempt.attemptId,
        "NONCE_CONFLICT",
        "NONCE_CONFLICT",
        "The reserved nonce is already consumed or occupied on Fuji; recovery refused to sign.",
      );
    }

    const claim = await recoveryRepository.claimPreparingSign(attempt);
    if (!claim.claimed) {
      return recordResult(
        attempt.attemptId,
        "NO_ACTION",
        "RECOVERY_ACTION_ALREADY_CLAIMED",
        "Another recovery invocation already claimed PREPARING signing; no signing was performed.",
      );
    }

    try {
      const signed = await gateway.prepareAndSign(
        claim.attempt.destination,
        BigInt(claim.attempt.amountUnits),
        claim.attempt.nonce,
      );
      await validateSignedTransfer(signed);
      await settlementRepository.persistSigned(claim.attempt.attemptId, signed);
    } catch (error) {
      const code: RecoveryCode = error instanceof FujiError && error.code === "INVALID_SIGNED_TRANSACTION"
        ? "INVALID_SIGNED_TRANSACTION"
        : "SIGNING_FAILED";
      await recoveryRepository.record(
        attempt.attemptId,
        code,
        "Recovery signing or durable signed-transaction persistence failed; the one-shot claim remains consumed.",
      );
      throw error;
    }

    return recordResult(
      attempt.attemptId,
      "RECOVERED",
      "PREPARING_SIGNED",
      "PREPARING resumed with the same reserved nonce and persisted signed bytes before any broadcast.",
    );
  }

  async function broadcastClaimedSigned(attempt: RecoveryAttempt): Promise<RecoveryResultDto> {
    const chainResult = await requireFuji(attempt);
    if (chainResult) return chainResult;
    // The recovery claim and SIGNED -> BROADCAST_REQUESTED transition commit
    // together. It also consumes the one Task 4 outbound-send claim so a
    // concurrent reconciler cannot mistake the in-flight send for a gap.
    const claim = await settlementRepository.claimBroadcast(attempt.attemptId, { recovery: true });
    if (!claim.signed) {
      return recordResult(
        attempt.attemptId,
        "NO_ACTION",
        "RECOVERY_ACTION_ALREADY_CLAIMED",
        "Another invocation already claimed the persisted transaction for broadcast; no send was performed.",
      );
    }
    await recoveryRepository.record(
      attempt.attemptId,
      "SIGNED_BROADCAST_CLAIMED",
      "Recovery claimed broadcast of the exact transaction already persisted by Task 2.",
    );
    await validateSignedTransfer(claim.signed);

    let networkHash;
    try {
      networkHash = await gateway.broadcast(claim.signed);
    } catch {
      return rpcUncertain(
        attempt.attemptId,
        "Broadcast response is uncertain; the attempt remains BROADCAST_REQUESTED and no fresh transaction will be created.",
      );
    }
    if (networkHash.toLowerCase() !== claim.signed.localHash.toLowerCase()) {
      return rpcUncertain(
        attempt.attemptId,
        "Broadcast hash differs from the persisted local hash; no retry or replacement was performed.",
      );
    }
    await settlementRepository.markSubmitted(attempt.attemptId, networkHash);
    return recordResult(
      attempt.attemptId,
      "RECOVERED",
      "SIGNED_BROADCAST_SUBMITTED",
      "The exact persisted signed transaction was broadcast once and its matching hash was recorded.",
    );
  }

  async function reconcileRequested(attempt: RecoveryAttempt): Promise<RecoveryResultDto> {
    const chainResult = await requireFuji(attempt);
    if (chainResult) return chainResult;
    if (!attempt.localHash || !attempt.signedTransaction) {
      throw new FujiError("INVALID_SETTLEMENT_STATE", "BROADCAST_REQUESTED recovery requires persisted bytes and local hash.");
    }

    const txRead = await readRpc(
      attempt.attemptId,
      () => gateway.getTransaction(attempt.localHash!),
      "Fuji transaction lookup was uncertain; no rebroadcast or new transaction was performed.",
    );
    if (txRead.uncertain) return txRead.uncertain;
    if (txRead.value) {
      const mismatch = verifyExpectedTransaction(attempt, txRead.value, attempt.localHash);
      if (mismatch) {
        return recordResult(
          attempt.attemptId,
          "RECOVERY_CONFLICT",
          "TRANSACTION_MISMATCH",
          "The transaction found under the persisted local hash did not match immutable settlement metadata.",
        );
      }
      await settlementRepository.markSubmitted(attempt.attemptId, attempt.localHash);
      return recordResult(
        attempt.attemptId,
        "RECOVERED",
        "BROADCAST_TRANSACTION_FOUND",
        "Fuji already contained the expected transaction; its local hash was recovered as the network hash without rebroadcast.",
      );
    }

    const nonceState = await readNonceState(attempt);
    if ("recoveryOutcome" in nonceState) return nonceState;
    if (nonceConsumed(nonceState, attempt.nonce)) {
      return recordResult(
        attempt.attemptId,
        "NONCE_CONFLICT",
        "NONCE_CONFLICT",
        "The expected hash was not found and the persisted nonce is already consumed or occupied; no transaction was sent.",
      );
    }

    const claim = await recoveryRepository.claimExactRebroadcast(attempt);
    if (!claim.claimed) {
      const current = claim.attempt;
      if (current.attemptState === "BROADCAST_SUBMITTED" || terminalStates.has(current.attemptState)) {
        return recordResult(
          attempt.attemptId,
          "NO_ACTION",
          "NO_ACTION",
          "The settlement already progressed while recovery was reconciling; no rebroadcast was performed.",
        );
      }
      return recordResult(
        attempt.attemptId,
        "RPC_UNCERTAIN",
        "RECOVERY_ACTION_ALREADY_CLAIMED",
        "Exact-byte rebroadcast was already claimed; recovery will not send the transaction a second time.",
      );
    }

    let signed: SignedUsdcTransfer;
    try {
      signed = signedFrom(claim.attempt);
      await validateSignedTransfer(signed);
    } catch {
      return recordResult(
        attempt.attemptId,
        "RECOVERY_CONFLICT",
        "INVALID_SIGNED_TRANSACTION",
        "Persisted signed bytes failed local envelope validation; no rebroadcast was performed.",
      );
    }

    let networkHash;
    try {
      networkHash = await gateway.broadcast(signed);
    } catch {
      return rpcUncertain(
        attempt.attemptId,
        "Exact-byte rebroadcast response is uncertain; its one-shot claim remains consumed and no fresh transaction will be created.",
      );
    }
    if (networkHash.toLowerCase() !== signed.localHash.toLowerCase()) {
      return rpcUncertain(
        attempt.attemptId,
        "Exact-byte rebroadcast returned a hash different from the persisted local hash; no further send was attempted.",
      );
    }
    await settlementRepository.markSubmitted(attempt.attemptId, networkHash);
    return recordResult(
      attempt.attemptId,
      "RECOVERED",
      "EXACT_REBROADCAST_SUBMITTED",
      "The exact persisted bytes were rebroadcast once with the same nonce, signature, calldata and hash.",
    );
  }

  async function verifySubmitted(attempt: RecoveryAttempt): Promise<RecoveryResultDto> {
    try {
      const result = await verificationService.verifyPersistedSettlement(attempt.transferId);
      if (result.status === "PENDING") {
        return recordResult(
          attempt.attemptId,
          "PENDING",
          result.pendingReason === "TRANSACTION_NOT_FOUND" ? "TRANSACTION_PENDING" : "VERIFICATION_PENDING",
          "The submitted transaction or receipt is not yet available; no sign or rebroadcast was performed.",
        );
      }
      return recordResult(
        attempt.attemptId,
        "TERMINAL",
        "TERMINAL",
        `Task 3 verification reached terminal blockchain state ${result.status}.`,
      );
    } catch (error) {
      if (error instanceof FujiError && error.code === "WRONG_CHAIN") throw error;
      return rpcUncertain(
        attempt.attemptId,
        "Task 3 could not determine blockchain evidence reliably; no recovery blockchain write was performed.",
      );
    }
  }

  async function reconcilePersistedSettlement(transferId: string): Promise<RecoveryResultDto> {
    const attempt = await recoveryRepository.beginByTransferId(transferId);
    switch (attempt.attemptState) {
      case "PREPARING":
        return recoverPreparing(attempt);
      case "SIGNED":
        return broadcastClaimedSigned(attempt);
      case "BROADCAST_REQUESTED":
        return reconcileRequested(attempt);
      case "BROADCAST_SUBMITTED":
        return verifySubmitted(attempt);
      case "CONFIRMED":
      case "REVERTED":
      case "VERIFICATION_FAILED":
        return recordResult(
          attempt.attemptId,
          "TERMINAL",
          "TERMINAL",
          `Settlement is already in terminal blockchain state ${attempt.attemptState}; no blockchain action was performed.`,
        );
    }
  }

  return { reconcilePersistedSettlement };
}
