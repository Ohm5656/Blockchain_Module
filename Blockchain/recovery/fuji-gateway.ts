import "../fuji/server-only.js";
import { assertFujiNetwork, fujiPublicClient } from "../fuji/clients.js";
import { fujiSettlementGateway } from "../persistence/fuji-gateway.js";
import { fujiVerificationGateway } from "../verification/fuji-gateway.js";
import type { FujiRecoveryGateway } from "./types.js";

export const fujiRecoveryGateway: FujiRecoveryGateway = {
  getIdentity: fujiSettlementGateway.getIdentity,
  getChainId: fujiVerificationGateway.getChainId,
  getTransaction: fujiVerificationGateway.getTransaction,
  getReceipt: fujiVerificationGateway.getReceipt,
  prepareAndSign: fujiSettlementGateway.prepareAndSign,
  broadcast: fujiSettlementGateway.broadcast,

  async getNonceState(signer) {
    await assertFujiNetwork();
    const [latest, pending] = await Promise.all([
      fujiPublicClient.getTransactionCount({ address: signer, blockTag: "latest" }),
      fujiPublicClient.getTransactionCount({ address: signer, blockTag: "pending" }),
    ]);
    return { latest, pending };
  },
};
