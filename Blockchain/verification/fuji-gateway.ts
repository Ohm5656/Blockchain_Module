import "../fuji/server-only.js";
import {
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Hash,
} from "viem";
import { assertFujiNetwork, fujiPublicClient } from "../fuji/clients.js";
import { FujiError } from "../fuji/errors.js";
import type { FujiVerificationGateway } from "./types.js";

export const fujiVerificationGateway: FujiVerificationGateway = {
  getChainId: assertFujiNetwork,

  async getTransaction(hash: Hash) {
    try {
      const transaction = await fujiPublicClient.getTransaction({ hash });
      return {
        hash: transaction.hash,
        chainId: transaction.chainId,
        from: transaction.from,
        to: transaction.to,
        nonce: transaction.nonce,
        input: transaction.input,
      };
    } catch (error) {
      if (error instanceof TransactionNotFoundError) return null;
      if (error instanceof FujiError) throw error;
      throw new FujiError("VERIFICATION_RPC_ERROR", "Could not reliably read the Fuji transaction; verification state was not changed.");
    }
  },

  async getReceipt(hash: Hash) {
    try {
      const receipt = await fujiPublicClient.getTransactionReceipt({ hash });
      return {
        transactionHash: receipt.transactionHash,
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        logs: receipt.logs.map((log) => ({
          address: log.address,
          data: log.data,
          topics: log.topics,
          logIndex: log.logIndex,
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber,
          blockHash: log.blockHash,
          removed: log.removed,
        })),
      };
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return null;
      if (error instanceof FujiError) throw error;
      throw new FujiError("VERIFICATION_RPC_ERROR", "Could not reliably read the Fuji receipt; verification state was not changed.");
    }
  },
};
