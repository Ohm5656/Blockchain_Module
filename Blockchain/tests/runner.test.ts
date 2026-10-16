import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { readFile } from "node:fs/promises";
import { encodeFunctionData, type Address, type Hash } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ERC20_ABI } from "../fuji/erc20.js";
import { FUJI_CHAIN_ID, FUJI_USDC_ADDRESS } from "../fuji/config.js";
import type { SignedUsdcTransfer } from "../fuji/settlement.js";
import { SettlementRepository } from "../persistence/repository.js";
import type { SettlementIntent } from "../persistence/types.js";
import { createRecoveryService } from "../recovery/service.js";
import { RecoveryRepository } from "../recovery/repository.js";
import type { FujiRecoveryGateway, RecoveryResultDto } from "../recovery/types.js";
import { createDurableReconciliationRunner } from "../runner/service.js";
import type { ReconciliationOperation } from "../runner/types.js";
import { startTestPostgres } from "./postgres-fixture.js";

const account = privateKeyToAccount(generatePrivateKey());
const signer = account.address.toLowerCase() as Address;
const destination = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;
const blockHash = `0x${"ab".repeat(32)}` as Hash;
let db: Awaited<ReturnType<typeof startTestPostgres>>;

before(async () => {
  db = await startTestPostgres();
});

beforeEach(async () => {
  await db.admin.query("TRUNCATE blockchain_private.settlement_attempts, blockchain_private.settlements, blockchain_private.signer_nonces");
});

after(async () => {
  await db?.close();
});

function intent(transferId: string, amountUnits = 1000n): SettlementIntent {
  return {
    transferId,
    chainId: FUJI_CHAIN_ID,
    signer,
    destination,
    tokenAddress: FUJI_USDC_ADDRESS.toLowerCase() as Address,
    amountUnits,
  };
}

async function signedTransfer(nonce: number, amountUnits = 1000n): Promise<SignedUsdcTransfer> {
  const serializedTransaction = await account.signTransaction({
    chainId: FUJI_CHAIN_ID,
    type: "eip1559",
    to: FUJI_USDC_ADDRESS,
    value: 0n,
    nonce,
    gas: 60_000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [destination, amountUnits] }),
  });
  return {
    chainId: FUJI_CHAIN_ID,
    signer: account.address,
    destination,
    tokenAddress: FUJI_USDC_ADDRESS,
    amountUnits,
    nonce,
    serializedTransaction,
    localHash: (await import("viem")).keccak256(serializedTransaction),
  };
}

async function preparing(transferId: string) {
  return new SettlementRepository(db.pool).claim(intent(transferId), async () => 7);
}

async function signed(transferId: string) {
  const claim = await preparing(transferId);
  const value = await signedTransfer(claim.attempt.nonce);
  const attempt = await new SettlementRepository(db.pool).persistSigned(claim.attempt.attemptId, value);
  return { attempt, signed: value };
}

async function requested(transferId: string) {
  const value = await signed(transferId);
  await new SettlementRepository(db.pool).claimBroadcast(value.attempt.attemptId);
  return value;
}

async function submitted(transferId: string) {
  const value = await requested(transferId);
  const attempt = await new SettlementRepository(db.pool).markSubmitted(value.attempt.attemptId, value.signed.localHash);
  return { attempt, signed: value.signed };
}

async function terminal(transferId: string, state: "CONFIRMED" | "REVERTED" | "VERIFICATION_FAILED") {
  const value = await submitted(transferId);
  if (state === "CONFIRMED") {
    await db.admin.query(`
      UPDATE blockchain_private.settlement_attempts
      SET attempt_state = 'CONFIRMED', verified_at = clock_timestamp(), receipt_block_number = 1,
          receipt_block_hash = $2, receipt_status = 'success', verified_transfer_log_index = 0,
          confirmed_at = clock_timestamp()
      WHERE id = $1`, [value.attempt.attemptId, blockHash]);
  } else if (state === "REVERTED") {
    await db.admin.query(`
      UPDATE blockchain_private.settlement_attempts
      SET attempt_state = 'REVERTED', verified_at = clock_timestamp(), receipt_block_number = 1,
          receipt_block_hash = $2, receipt_status = 'reverted',
          verification_failure_code = 'TRANSACTION_REVERTED', verification_failure_reason = 'test reverted'
      WHERE id = $1`, [value.attempt.attemptId, blockHash]);
  } else {
    await db.admin.query(`
      UPDATE blockchain_private.settlement_attempts
      SET attempt_state = 'VERIFICATION_FAILED', verified_at = clock_timestamp(),
          verification_failure_code = 'TRANSACTION_HASH_MISMATCH', verification_failure_reason = 'test mismatch'
      WHERE id = $1`, [value.attempt.attemptId]);
  }
  return value;
}

function result(outcome: RecoveryResultDto["recoveryOutcome"]): RecoveryResultDto {
  return {
    settlementId: "safe-settlement",
    attemptId: "safe-attempt",
    transferId: "safe-transfer",
    attemptState: outcome === "TERMINAL" ? "CONFIRMED" : "BROADCAST_SUBMITTED",
    recoveryOutcome: outcome,
    recoveryCode: outcome === "RECOVERED" ? "BROADCAST_TRANSACTION_FOUND" : outcome === "PENDING" ? "VERIFICATION_PENDING" : outcome === "RPC_UNCERTAIN" ? "RPC_UNCERTAIN" : outcome === "TERMINAL" ? "TERMINAL" : outcome === "NO_ACTION" ? "NO_ACTION" : "NONCE_CONFLICT",
    recoveryReason: "safe test outcome",
    chainId: FUJI_CHAIN_ID,
    signer,
    destination,
    tokenAddress: FUJI_USDC_ADDRESS,
    amountUnits: "1000",
    nonce: 7,
    transactionHash: null,
    blockNumber: null,
    blockHash: null,
    transferLogIndex: null,
    verifiedAt: null,
    confirmedAt: null,
    verificationFailureCode: null,
    recoveryAttemptCount: 0,
    lastRecoveryAt: null,
  };
}

function recorder(
  outcomes: Readonly<Record<string, RecoveryResultDto["recoveryOutcome"]>> = {},
  failing = new Set<string>(),
) {
  const calls: string[] = [];
  const operation: ReconciliationOperation = {
    async reconcilePersistedSettlement(transferId) {
      calls.push(transferId);
      if (failing.has(transferId)) throw new Error("sensitive rpc response");
      return result(outcomes[transferId] ?? "NO_ACTION");
    },
  };
  return { calls, operation };
}

test("runner selects every recoverable state and excludes all terminal states", async () => {
  await preparing("runner-preparing");
  await signed("runner-signed");
  await requested("runner-requested");
  await submitted("runner-submitted");
  await terminal("runner-confirmed", "CONFIRMED");
  await terminal("runner-reverted", "REVERTED");
  await terminal("runner-failed", "VERIFICATION_FAILED");

  const mock = recorder({
    "runner-preparing": "RECOVERED",
    "runner-signed": "NO_ACTION",
    "runner-requested": "PENDING",
    "runner-submitted": "RPC_UNCERTAIN",
  });
  const runner = createDurableReconciliationRunner(db.pool, mock.operation);
  const summary = await runner.runOnce({ batchSize: 10, cooldownMs: 0 });

  assert.deepEqual(new Set(mock.calls), new Set([
    "runner-preparing", "runner-signed", "runner-requested", "runner-submitted",
  ]));
  assert.equal(summary.scanned, 4);
  assert.equal(summary.processed, 4);
  assert.equal(summary.recovered, 1);
  assert.equal(summary.pending, 1);
  assert.equal(summary.rpcUncertain, 1);
  assert.equal(summary.noAction, 1);
});

test("runner calls the supplied Task 4 reconciliation service using only transfer IDs", async () => {
  await preparing("runner-one");
  const mock = recorder({ "runner-one": "RECOVERED" });
  const summary = await createDurableReconciliationRunner(db.pool, mock.operation).runOnce({ batchSize: 1, cooldownMs: 0 });
  assert.deepEqual(mock.calls, ["runner-one"]);
  assert.deepEqual(summary, {
    scanned: 1, processed: 1, recovered: 1, pending: 0, terminal: 0,
    rpcUncertain: 0, noAction: 0, conflicts: 0, failed: 0,
  });
});

test("one reconciliation failure does not stop later selected settlements", async () => {
  await preparing("runner-fail");
  await preparing("runner-after-fail");
  const mock = recorder({ "runner-after-fail": "PENDING" }, new Set(["runner-fail"]));
  const summary = await createDurableReconciliationRunner(db.pool, mock.operation).runOnce({ batchSize: 2, cooldownMs: 0 });
  assert.equal(mock.calls.length, 2);
  assert.equal(summary.processed, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.pending, 1);
});

test("runner respects the configured bounded batch size", async () => {
  await preparing("runner-batch-a");
  await preparing("runner-batch-b");
  await preparing("runner-batch-c");
  const mock = recorder();
  const summary = await createDurableReconciliationRunner(db.pool, mock.operation).runOnce({ batchSize: 2, cooldownMs: 0 });
  assert.equal(summary.scanned, 2);
  assert.equal(summary.processed, 2);
  assert.equal(mock.calls.length, 2);
});

test("cooldown defers recent records and permits them again later", async () => {
  await preparing("runner-cooldown");
  await new RecoveryRepository(db.pool).beginByTransferId("runner-cooldown");
  const mock = recorder();
  const runner = createDurableReconciliationRunner(db.pool, mock.operation);
  assert.equal((await runner.runOnce({ batchSize: 1, cooldownMs: 60_000 })).processed, 0);
  assert.equal((await runner.runOnce({ batchSize: 1, cooldownMs: 0 })).processed, 1);
});

test("Task 3 pending evidence is reconsidered only on a later eligible invocation", async () => {
  const existing = await submitted("runner-pending-later");
  const input = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [destination, 1000n],
  });
  const gateway: FujiRecoveryGateway = {
    getIdentity: () => ({ chainId: FUJI_CHAIN_ID, signer: account.address, tokenAddress: FUJI_USDC_ADDRESS }),
    getChainId: async () => FUJI_CHAIN_ID,
    getNonceState: async () => ({ latest: existing.attempt.nonce, pending: existing.attempt.nonce }),
    prepareAndSign: async () => { throw new Error("not expected"); },
    broadcast: async () => { throw new Error("not expected"); },
    getTransaction: async (hash) => ({
      hash,
      chainId: FUJI_CHAIN_ID,
      from: account.address,
      to: FUJI_USDC_ADDRESS,
      nonce: existing.attempt.nonce,
      input,
    }),
    getReceipt: async () => null,
  };
  const runner = createDurableReconciliationRunner(db.pool, createRecoveryService(db.pool, gateway));
  const first = await runner.runOnce({ batchSize: 1, cooldownMs: 0 });
  const deferred = await runner.runOnce({ batchSize: 1, cooldownMs: 60_000 });
  const later = await runner.runOnce({ batchSize: 1, cooldownMs: 0 });
  assert.equal(first.pending, 1);
  assert.equal(deferred.processed, 0);
  assert.equal(later.pending, 1);
});

test("runner is process-restart safe and uses no memory-held work queue", async () => {
  await preparing("runner-restart");
  const first = recorder({ "runner-restart": "PENDING" });
  const initial = await createDurableReconciliationRunner(db.pool, first.operation).runOnce({ batchSize: 1, cooldownMs: 0 });
  const second = recorder({ "runner-restart": "TERMINAL" });
  const afterRestart = await createDurableReconciliationRunner(db.secondPool, second.operation).runOnce({ batchSize: 1, cooldownMs: 0 });
  assert.equal(initial.processed, 1);
  assert.equal(afterRestart.processed, 1);
  assert.deepEqual(first.calls, ["runner-restart"]);
  assert.deepEqual(second.calls, ["runner-restart"]);
});

test("overlapping runners delegate to Task 4 claims and broadcast at most once", async () => {
  await signed("runner-overlap");
  let broadcasts = 0;
  const gateway: FujiRecoveryGateway = {
    getIdentity: () => ({ chainId: FUJI_CHAIN_ID, signer: account.address, tokenAddress: FUJI_USDC_ADDRESS }),
    getChainId: async () => FUJI_CHAIN_ID,
    getNonceState: async () => ({ latest: 7, pending: 7 }),
    prepareAndSign: async () => { throw new Error("must not sign a SIGNED attempt"); },
    async broadcast(value) {
      broadcasts++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return value.localHash;
    },
    getTransaction: async () => null,
    getReceipt: async () => null,
  };
  const first = createDurableReconciliationRunner(db.pool, createRecoveryService(db.pool, gateway));
  const second = createDurableReconciliationRunner(db.secondPool, createRecoveryService(db.secondPool, gateway));
  const [one, two] = await Promise.all([
    first.runOnce({ batchSize: 1, cooldownMs: 0 }),
    second.runOnce({ batchSize: 1, cooldownMs: 0 }),
  ]);
  assert.equal(one.processed + two.processed, 2);
  assert.equal(broadcasts, 1);
  const row = (await db.admin.query("SELECT attempt_state FROM blockchain_private.settlement_attempts")).rows[0];
  assert.equal(row.attempt_state, "BROADCAST_SUBMITTED");
});

test("safe runner summary cannot expose signed bytes, private keys, credentials, or raw errors", async () => {
  await preparing("runner-safe");
  const mock = recorder({}, new Set(["runner-safe"]));
  const summary = await createDurableReconciliationRunner(db.pool, mock.operation).runOnce({ batchSize: 1, cooldownMs: 0 });
  const serialized = JSON.stringify(summary);
  assert.equal(summary.failed, 1);
  assert.ok(!serialized.includes("sensitive rpc response"));
  assert.ok(!serialized.includes("0x02"));
  assert.ok(!serialized.toLowerCase().includes("private"));
});

test("runner contains no independent signer, broadcast, transaction, receipt, or polling implementation", async () => {
  const source = await readFile(new URL("../runner/service.ts", import.meta.url), "utf8");
  assert.ok(source.includes("reconcilePersistedSettlement"));
  for (const forbidden of [
    "prepareAndSign", "broadcastSigned", "sendRawTransaction", "signTransaction",
    "getTransactionCount", "getTransactionReceipt", "decodeEventLog", "while (true)", "setInterval",
  ]) {
    assert.ok(!source.includes(forbidden), `runner service must not contain ${forbidden}`);
  }
});

test("runner option validation rejects unbounded batch and invalid cooldown", async () => {
  const runner = createDurableReconciliationRunner(db.pool, recorder().operation);
  await assert.rejects(runner.runOnce({ batchSize: 51 }), /batch size/i);
  await assert.rejects(runner.runOnce({ batchSize: 1, cooldownMs: -1 }), /cooldown/i);
});
