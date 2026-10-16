import "../fuji/server-only.js";
import { assertFujiNetwork, fujiPublicClient, getFujiSignerAccount } from "../fuji/clients.js";
import { FUJI_CHAIN_ID, FUJI_USDC_ADDRESS } from "../fuji/config.js";
import { fujiOperation } from "../fuji/errors.js";
import { broadcastSignedTransaction, prepareAndSignUsdcTransfer } from "../fuji/settlement.js";
import type { FujiSettlementGateway } from "./types.js";

export const fujiSettlementGateway: FujiSettlementGateway = {
  getIdentity: () => ({ chainId: FUJI_CHAIN_ID, signer: getFujiSignerAccount().address, tokenAddress: FUJI_USDC_ADDRESS }),
  async getPendingNonce(signer) {
    await assertFujiNetwork();
    return fujiOperation("NONCE_ALLOCATION_FAILED", "Could not read the Fuji pending nonce. No signing was performed.",
      () => fujiPublicClient.getTransactionCount({ address: signer, blockTag: "pending" }));
  },
  prepareAndSign: (destination, amountUnits, nonce) => prepareAndSignUsdcTransfer(destination, amountUnits, { nonce }),
  broadcast: broadcastSignedTransaction,
};
