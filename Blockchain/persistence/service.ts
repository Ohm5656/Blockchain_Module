import "../fuji/server-only.js";
import type { Pool } from "pg";
import type { Address } from "viem";
import { assertUsdcAmount, FUJI_CHAIN_ID, FUJI_USDC_ADDRESS, validateFujiAddress } from "../fuji/config.js";
import { FujiError, fujiOperation } from "../fuji/errors.js";
import { validateSignedTransfer } from "../fuji/settlement.js";
import { fujiSettlementGateway } from "./fuji-gateway.js";
import { SettlementRepository } from "./repository.js";
import type { FujiSettlementGateway, SettlementDto, SettlementIntent, SettlementRequest } from "./types.js";

export function createPersistedSettlementService(pool: Pool, gateway: FujiSettlementGateway = fujiSettlementGateway) {
  const repository = new SettlementRepository(pool);

  function normalize(request: SettlementRequest): SettlementIntent {
    if (typeof request.transferId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(request.transferId)) {
      throw new FujiError("CONFIG", "transferId must be a stable 1–128 character application identifier (letters, digits, . _ : / -).");
    }
    assertUsdcAmount(request.amountUnits);
    const identity = gateway.getIdentity();
    if (identity.chainId !== FUJI_CHAIN_ID) throw new FujiError("WRONG_CHAIN", "Persisted settlements support only Fuji chain 43113.");
    const signer = validateFujiAddress(identity.signer, "Signer").toLowerCase() as Address;
    const destination = validateFujiAddress(request.destination, "Destination").toLowerCase() as Address;
    const tokenAddress = validateFujiAddress(identity.tokenAddress, "Token").toLowerCase() as Address;
    if (tokenAddress !== FUJI_USDC_ADDRESS.toLowerCase()) throw new FujiError("CONFIG", "Only Circle Test USDC on Fuji is allowed.");
    if (signer === destination) throw new FujiError("INVALID_ADDRESS", "Wallet B must differ from Wallet A.");
    return { transferId: request.transferId, amountUnits: request.amountUnits, chainId: FUJI_CHAIN_ID, signer, destination, tokenAddress };
  }

  async function preparePersistedSettlement(request: SettlementRequest): Promise<SettlementDto> {
    const intent = normalize(request);
    const claim = await repository.claim(intent, () => gateway.getPendingNonce(intent.signer));
    // PREPARING is an explicit durable stop, not permission to sign again.
    if (!claim.created) return claim.attempt;

    const signed = await fujiOperation("SIGNING_FAILED", "Preparation/signing failed. The reserved attempt remains PREPARING; no fresh signing retry is allowed.",
      () => gateway.prepareAndSign(intent.destination, intent.amountUnits, claim.attempt.nonce));
    await validateSignedTransfer(signed);
    // Conditional UPDATE also checks every immutable parameter and the reserved nonce.
    return repository.persistSigned(claim.attempt.attemptId, signed);
  }

  async function executePersistedSettlement(request: SettlementRequest): Promise<SettlementDto> {
    const prepared = await preparePersistedSettlement(request);
    const claimed = await repository.claimBroadcast(prepared.attemptId);
    if (!claimed.signed) return claimed.attempt; // PREPARING/REQUESTED/SUBMITTED: no retry.
    const networkHash = await fujiOperation("BROADCAST_FAILED",
      "Broadcast failed or is uncertain. The attempt remains BROADCAST_REQUESTED; no automatic rebroadcast or replacement is allowed.",
      () => gateway.broadcast(claimed.signed!));
    if (typeof networkHash !== "string" || networkHash.toLowerCase() !== claimed.signed.localHash.toLowerCase()) {
      throw new FujiError("HASH_MISMATCH", "RPC hash differs from the persisted local hash; broadcast outcome is uncertain.");
    }
    return repository.markSubmitted(prepared.attemptId, networkHash);
  }

  return { preparePersistedSettlement, executePersistedSettlement };
}
