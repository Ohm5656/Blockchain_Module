import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  maxUint256,
  type Address,
  type Hash,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ERC20_ABI } from "../fuji/erc20.js";
import { FUJI_CHAIN_ID, FUJI_USDC_ADDRESS } from "../fuji/config.js";
import { FujiError } from "../fuji/errors.js";
import type { SignedUsdcTransfer } from "../fuji/settlement.js";
import { createPersistedSettlementService } from "../persistence/service.js";
import type { FujiSettlementGateway } from "../persistence/types.js";
import { createVerificationService } from "../verification/service.js";
import type {
  FujiVerificationGateway,
  VerificationLog,
  VerificationReceipt,
  VerificationTransaction,
} from "../verification/types.js";
import { startTestPostgres } from "./postgres-fixture.js";

const key = generatePrivateKey();
const account = privateKeyToAccount(key);
const destination = privateKeyToAccount(generatePrivateKey()).address;
const other = privateKeyToAccount(generatePrivateKey()).address;
const blockHash = `0x${"ab".repeat(32)}` as Hash;
const otherHash = `0x${"cd".repeat(32)}` as Hash;
let db: Awaited<ReturnType<typeof startTestPostgres>>;
let signingCalls = 0;
let broadcastCalls = 0;

const settlementGateway: FujiSettlementGateway = {
  getIdentity: () => ({ chainId: FUJI_CHAIN_ID, signer: account.address, tokenAddress: FUJI_USDC_ADDRESS }),
  getPendingNonce: async () => 7,
  async prepareAndSign(to, amountUnits, nonce) {
    signingCalls++;
    const serializedTransaction = await account.signTransaction({
      chainId: FUJI_CHAIN_ID,
      type: "eip1559",
      to: FUJI_USDC_ADDRESS,
      value: 0n,
      nonce,
      gas: 60_000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [to, amountUnits] }),
    });
    return {
      chainId: FUJI_CHAIN_ID,
      signer: account.address,
      destination: to,
      tokenAddress: FUJI_USDC_ADDRESS,
      amountUnits,
      nonce,
      serializedTransaction,
      localHash: (await import("viem")).keccak256(serializedTransaction),
    } satisfies SignedUsdcTransfer;
  },
  async broadcast(signed) {
    broadcastCalls++;
    return signed.localHash;
  },
};

before(async () => {
  db = await startTestPostgres();
});

beforeEach(async () => {
  await db.admin.query("DROP TRIGGER IF EXISTS inject_verification_failure ON blockchain_private.settlement_attempts");
  await db.admin.query("DROP FUNCTION IF EXISTS blockchain_private.inject_verification_failure()");
  await db.admin.query("TRUNCATE blockchain_private.settlement_attempts, blockchain_private.settlements, blockchain_private.signer_nonces");
  signingCalls = 0;
  broadcastCalls = 0;
});

after(async () => {
  await db?.close();
});

async function submitted(transferId = "verify-1", amountUnits = 1000n) {
  return createPersistedSettlementService(db.pool, settlementGateway).executePersistedSettlement({
    transferId,
    destination,
    amountUnits,
  });
}

function transaction(hash: Hash, amountUnits = 1000n, overrides: Partial<VerificationTransaction> = {}): VerificationTransaction {
  return {
    hash,
    chainId: FUJI_CHAIN_ID,
    from: account.address,
    to: FUJI_USDC_ADDRESS,
    nonce: 7,
    input: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [destination, amountUnits],
    }),
    ...overrides,
  };
}

function transferLog(
  hash: Hash,
  amountUnits = 1000n,
  overrides: Partial<VerificationLog> & {
    eventFrom?: Address;
    eventTo?: Address;
    eventValue?: bigint;
  } = {},
): VerificationLog {
  const {
    eventFrom = account.address,
    eventTo = destination,
    eventValue = amountUnits,
    ...logOverrides
  } = overrides;
  return {
    address: FUJI_USDC_ADDRESS,
    data: encodeAbiParameters([{ type: "uint256" }], [eventValue]),
    topics: encodeEventTopics({
      abi: ERC20_ABI,
      eventName: "Transfer",
      args: { from: eventFrom, to: eventTo },
    }) as unknown as readonly `0x${string}`[],
    logIndex: 5,
    transactionHash: hash,
    blockNumber: 1234n,
    blockHash,
    removed: false,
    ...logOverrides,
  };
}

function receipt(
  hash: Hash,
  amountUnits = 1000n,
  overrides: Partial<VerificationReceipt> = {},
): VerificationReceipt {
  return {
    transactionHash: hash,
    status: "success",
    blockNumber: 1234n,
    blockHash,
    logs: [transferLog(hash, amountUnits)],
    ...overrides,
  };
}

function gateway(
  hash: Hash,
  amountUnits = 1000n,
  overrides: Partial<FujiVerificationGateway> = {},
) {
  const calls = { chain: 0, transaction: 0, receipt: 0 };
  const value: FujiVerificationGateway = {
    async getChainId() {
      calls.chain++;
      return FUJI_CHAIN_ID;
    },
    async getTransaction() {
      calls.transaction++;
      return transaction(hash, amountUnits);
    },
    async getReceipt() {
      calls.receipt++;
      return receipt(hash, amountUnits);
    },
    ...overrides,
  };
  return { value, calls };
}

async function row() {
  return (await db.admin.query("SELECT * FROM blockchain_private.settlement_attempts")).rows[0];
}

function expectFujiCode(expected: string) {
  return (error: unknown) => {
    assert.ok(error instanceof FujiError);
    assert.equal(error.code, expected);
    assert.ok(!String(error).includes(key));
    assert.ok(!String(error).includes("sensitive-rpc-detail"));
    assert.ok(!String(error).includes("sensitive-database-detail"));
    return true;
  };
}

test("successful transaction, receipt and exact Transfer event become CONFIRMED with evidence", async () => {
  const attempt = await submitted();
  const { value, calls } = gateway(attempt.networkHash!);
  signingCalls = broadcastCalls = 0;

  const result = await createVerificationService(db.pool, value).verifyPersistedSettlement("verify-1");

  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.attemptState, "CONFIRMED");
  assert.equal(result.transactionHash, attempt.networkHash);
  assert.equal(result.blockNumber, "1234");
  assert.equal(result.blockHash, blockHash);
  assert.equal(result.transferLogIndex, 5);
  assert.ok(result.verifiedAt);
  assert.ok(result.confirmedAt);
  assert.equal(result.failureCode, null);
  assert.deepEqual(calls, { chain: 1, transaction: 1, receipt: 1 });
  assert.equal(signingCalls, 0);
  assert.equal(broadcastCalls, 0);

  const persisted = await row();
  assert.equal(persisted.attempt_state, "CONFIRMED");
  assert.equal(persisted.receipt_status, "success");
  assert.equal(persisted.receipt_block_number, "1234");
  assert.equal(persisted.receipt_block_hash, blockHash);
  assert.equal(persisted.verified_transfer_log_index, 5);
  assert.ok(persisted.verified_at instanceof Date);
  assert.ok(persisted.confirmed_at instanceof Date);
});

test("already CONFIRMED returns canonical evidence without any RPC call", async () => {
  const attempt = await submitted();
  const first = gateway(attempt.networkHash!);
  const service = createVerificationService(db.pool, first.value);
  const confirmed = await service.verifyPersistedSettlement("verify-1");

  const never: FujiVerificationGateway = {
    getChainId: async () => { throw new Error("must not call chain"); },
    getTransaction: async () => { throw new Error("must not fetch transaction"); },
    getReceipt: async () => { throw new Error("must not fetch receipt"); },
  };
  const repeated = await createVerificationService(db.secondPool, never).verifyPersistedSettlement("verify-1");
  assert.deepEqual(repeated, confirmed);
  assert.equal((await row()).attempt_state, "CONFIRMED");
});

test("transaction not found returns PENDING and writes no failure evidence", async () => {
  const attempt = await submitted();
  const mock = gateway(attempt.networkHash!, 1000n, { getTransaction: async () => null });
  const result = await createVerificationService(db.pool, mock.value).verifyPersistedSettlement("verify-1");
  assert.equal(result.status, "PENDING");
  assert.equal(result.pendingReason, "TRANSACTION_NOT_FOUND");
  assert.equal(result.attemptState, "BROADCAST_SUBMITTED");
  const persisted = await row();
  assert.equal(persisted.attempt_state, "BROADCAST_SUBMITTED");
  assert.equal(persisted.verified_at, null);
  assert.equal(mock.calls.receipt, 0);
});

test("receipt not found returns PENDING and is not treated as reverted or failed", async () => {
  const attempt = await submitted();
  const mock = gateway(attempt.networkHash!, 1000n, { getReceipt: async () => null });
  const result = await createVerificationService(db.pool, mock.value).verifyPersistedSettlement("verify-1");
  assert.equal(result.status, "PENDING");
  assert.equal(result.pendingReason, "RECEIPT_PENDING");
  assert.equal(result.failureCode, null);
  const persisted = await row();
  assert.equal(persisted.attempt_state, "BROADCAST_SUBMITTED");
  assert.equal(persisted.receipt_status, null);
  assert.equal(persisted.verification_failure_code, null);
});

test("definitively reverted receipt becomes REVERTED, not CONFIRMED", async () => {
  const attempt = await submitted();
  const mock = gateway(attempt.networkHash!, 1000n, {
    getReceipt: async () => receipt(attempt.networkHash!, 1000n, { status: "reverted", logs: [] }),
  });
  const result = await createVerificationService(db.pool, mock.value).verifyPersistedSettlement("verify-1");
  assert.equal(result.status, "REVERTED");
  assert.equal(result.failureCode, "TRANSACTION_REVERTED");
  assert.equal(result.blockNumber, "1234");
  assert.equal(result.confirmedAt, null);
  const persisted = await row();
  assert.equal(persisted.attempt_state, "REVERTED");
  assert.equal(persisted.receipt_status, "reverted");
});

const transactionMismatchCases: Array<{
  name: string;
  code: string;
  mutate: (hash: Hash) => Partial<VerificationTransaction>;
}> = [
  { name: "wrong transaction hash", code: "TRANSACTION_HASH_MISMATCH", mutate: () => ({ hash: otherHash }) },
  { name: "wrong transaction chain", code: "TRANSACTION_CHAIN_MISMATCH", mutate: () => ({ chainId: 1 }) },
  { name: "wrong signer", code: "SIGNER_MISMATCH", mutate: () => ({ from: other }) },
  { name: "wrong nonce", code: "NONCE_MISMATCH", mutate: () => ({ nonce: 8 }) },
  { name: "wrong token contract", code: "TOKEN_MISMATCH", mutate: () => ({ to: other }) },
  {
    name: "decoded destination mismatch",
    code: "CALLDATA_DESTINATION_MISMATCH",
    mutate: () => ({
      input: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [other, 1000n] }),
    }),
  },
  {
    name: "decoded amount mismatch",
    code: "CALLDATA_AMOUNT_MISMATCH",
    mutate: () => ({
      input: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [destination, 1001n] }),
    }),
  },
];

for (const item of transactionMismatchCases) {
  test(`${item.name} becomes VERIFICATION_FAILED without fetching receipt`, async () => {
    const attempt = await submitted();
    const mock = gateway(attempt.networkHash!, 1000n, {
      getTransaction: async () => transaction(attempt.networkHash!, 1000n, item.mutate(attempt.networkHash!)),
    });
    const result = await createVerificationService(db.pool, mock.value).verifyPersistedSettlement("verify-1");
    assert.equal(result.status, "VERIFICATION_FAILED");
    assert.equal(result.failureCode, item.code);
    assert.equal(result.confirmedAt, null);
    assert.equal(mock.calls.receipt, 0);
    assert.equal((await row()).attempt_state, "VERIFICATION_FAILED");
  });
}

test("malformed transfer calldata is rejected", async () => {
  const attempt = await submitted();
  const mock = gateway(attempt.networkHash!, 1000n, {
    getTransaction: async () => transaction(attempt.networkHash!, 1000n, { input: "0x1234" }),
  });
  const result = await createVerificationService(db.pool, mock.value).verifyPersistedSettlement("verify-1");
  assert.equal(result.status, "VERIFICATION_FAILED");
  assert.equal(result.failureCode, "CALLDATA_MISMATCH");
});

test("receipt hash mismatch becomes VERIFICATION_FAILED", async () => {
  const attempt = await submitted();
  const mock = gateway(attempt.networkHash!, 1000n, {
    getReceipt: async () => receipt(otherHash),
  });
  const result = await createVerificationService(db.pool, mock.value).verifyPersistedSettlement("verify-1");
  assert.equal(result.failureCode, "RECEIPT_HASH_MISMATCH");
  assert.equal(result.status, "VERIFICATION_FAILED");
});

test("receipt without block evidence becomes VERIFICATION_FAILED", async () => {
  const attempt = await submitted();
  const mock = gateway(attempt.networkHash!, 1000n, {
    getReceipt: async () => receipt(attempt.networkHash!, 1000n, { blockNumber: null, blockHash: null }),
  });
  const result = await createVerificationService(db.pool, mock.value).verifyPersistedSettlement("verify-1");
  assert.equal(result.failureCode, "RECEIPT_BLOCK_MISSING");
  assert.equal(result.blockNumber, null);
});

const eventMismatchCases: Array<{
  name: string;
  code: string;
  logs: (hash: Hash) => VerificationLog[];
}> = [
  { name: "expected Transfer event missing", code: "TRANSFER_EVENT_MISSING", logs: () => [] },
  {
    name: "Transfer sender mismatch",
    code: "TRANSFER_EVENT_SENDER_MISMATCH",
    logs: (hash) => [transferLog(hash, 1000n, { eventFrom: other })],
  },
  {
    name: "Transfer destination mismatch",
    code: "TRANSFER_EVENT_DESTINATION_MISMATCH",
    logs: (hash) => [transferLog(hash, 1000n, { eventTo: other })],
  },
  {
    name: "Transfer amount mismatch",
    code: "TRANSFER_EVENT_AMOUNT_MISMATCH",
    logs: (hash) => [transferLog(hash, 1000n, { eventValue: 1001n })],
  },
  {
    name: "matching Transfer emitted by wrong contract",
    code: "TRANSFER_EVENT_WRONG_CONTRACT",
    logs: (hash) => [transferLog(hash, 1000n, { address: other })],
  },
  {
    name: "duplicate Test USDC Transfer evidence",
    code: "TRANSFER_EVENT_DUPLICATE",
    logs: (hash) => [transferLog(hash), transferLog(hash, 1000n, { logIndex: 6 })],
  },
  {
    name: "removed Transfer log",
    code: "TRANSFER_EVENT_INTEGRITY_MISMATCH",
    logs: (hash) => [transferLog(hash, 1000n, { removed: true })],
  },
];

for (const item of eventMismatchCases) {
  test(`${item.name} becomes VERIFICATION_FAILED`, async () => {
    const attempt = await submitted();
    const mock = gateway(attempt.networkHash!, 1000n, {
      getReceipt: async () => receipt(attempt.networkHash!, 1000n, { logs: item.logs(attempt.networkHash!) }),
    });
    const result = await createVerificationService(db.pool, mock.value).verifyPersistedSettlement("verify-1");
    assert.equal(result.status, "VERIFICATION_FAILED");
    assert.equal(result.failureCode, item.code);
    assert.equal(result.blockNumber, "1234");
    assert.equal(result.confirmedAt, null);
  });
}

test("wrong Fuji chain is rejected and does not write verification evidence", async () => {
  const attempt = await submitted();
  const mock = gateway(attempt.networkHash!, 1000n, { getChainId: async () => 1 });
  await assert.rejects(
    createVerificationService(db.pool, mock.value).verifyPersistedSettlement("verify-1"),
    expectFujiCode("WRONG_CHAIN"),
  );
  assert.equal((await row()).attempt_state, "BROADCAST_SUBMITTED");
  assert.equal(mock.calls.transaction, 0);
});

test("RPC timeout/error remains uncertain and never becomes REVERTED", async () => {
  const attempt = await submitted();
  const mock = gateway(attempt.networkHash!, 1000n, {
    getTransaction: async () => { throw new Error("sensitive-rpc-detail"); },
  });
  await assert.rejects(
    createVerificationService(db.pool, mock.value).verifyPersistedSettlement("verify-1"),
    expectFujiCode("VERIFICATION_RPC_ERROR"),
  );
  const persisted = await row();
  assert.equal(persisted.attempt_state, "BROADCAST_SUBMITTED");
  assert.equal(persisted.verified_at, null);
});

test("verification DB failure cannot falsely mark the attempt CONFIRMED", async () => {
  const attempt = await submitted();
  await db.admin.query(`
    CREATE FUNCTION blockchain_private.inject_verification_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.attempt_state = 'CONFIRMED' THEN RAISE EXCEPTION 'sensitive-database-detail'; END IF;
      RETURN NEW;
    END $$`);
  await db.admin.query(`
    CREATE CONSTRAINT TRIGGER inject_verification_failure
    AFTER UPDATE ON blockchain_private.settlement_attempts
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION blockchain_private.inject_verification_failure()`);
  const mock = gateway(attempt.networkHash!);
  await assert.rejects(
    createVerificationService(db.pool, mock.value).verifyPersistedSettlement("verify-1"),
    expectFujiCode("PERSISTENCE_FAILED"),
  );
  const persisted = await row();
  assert.equal(persisted.attempt_state, "BROADCAST_SUBMITTED");
  assert.equal(persisted.confirmed_at, null);
});

test("concurrent verifiers produce one canonical confirmed evidence set", async () => {
  const attempt = await submitted();
  const mock = gateway(attempt.networkHash!);
  const services = [
    createVerificationService(db.pool, mock.value),
    createVerificationService(db.secondPool, mock.value),
  ];
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    services[index % 2].verifyPersistedSettlement("verify-1")));
  assert.equal(new Set(results.map((result) => JSON.stringify(result))).size, 1);
  assert.equal(results[0].status, "CONFIRMED");
  const persisted = await row();
  assert.equal(persisted.attempt_state, "CONFIRMED");
  assert.equal(persisted.verified_transfer_log_index, 5);
});

test("verification needs no private key, does not sign/broadcast, and safe DTO omits signed bytes", async () => {
  const attempt = await submitted();
  const persistedBefore = await row();
  const previousKey = process.env.FUJI_SIGNER_PRIVATE_KEY;
  process.env.FUJI_SIGNER_PRIVATE_KEY = "";
  signingCalls = broadcastCalls = 0;
  try {
    const mock = gateway(attempt.networkHash!);
    const result = await createVerificationService(db.pool, mock.value).verifyPersistedSettlement("verify-1");
    const safe = JSON.stringify(result);
    assert.equal(result.status, "CONFIRMED");
    assert.equal(signingCalls, 0);
    assert.equal(broadcastCalls, 0);
    assert.ok(!safe.includes(persistedBefore.signed_transaction));
    assert.ok(!safe.includes("signed_transaction"));
    assert.ok(!safe.includes("serializedTransaction"));
    assert.ok(!safe.includes(key));
    assert.deepEqual(Object.keys(result).sort(), [
      "amountUnits", "attemptId", "attemptState", "blockHash", "blockNumber",
      "chainId", "confirmedAt", "destination", "failureCode", "failureReason",
      "nonce", "pendingReason", "settlementId", "signer", "status",
      "tokenAddress", "transactionHash", "transferId", "transferLogIndex", "verifiedAt",
    ]);
  } finally {
    if (previousKey === undefined) delete process.env.FUJI_SIGNER_PRIVATE_KEY;
    else process.env.FUJI_SIGNER_PRIVATE_KEY = previousKey;
  }
});

test("uint256 base-unit amount survives exact transaction and event comparison", async () => {
  const attempt = await submitted("verify-max", maxUint256);
  const mock = gateway(attempt.networkHash!, maxUint256);
  const result = await createVerificationService(db.pool, mock.value).verifyPersistedSettlement("verify-max");
  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.amountUnits, maxUint256.toString());
  assert.equal((await row()).amount_units, maxUint256.toString());
});

test("BROADCAST_REQUESTED cannot be treated as submitted or pending verification", async () => {
  const service = createPersistedSettlementService(db.pool, {
    ...settlementGateway,
    broadcast: async () => { throw new Error("uncertain"); },
  });
  await assert.rejects(service.executePersistedSettlement({
    transferId: "requested-only",
    destination,
    amountUnits: 1000n,
  }));
  const mock = gateway(otherHash);
  await assert.rejects(
    createVerificationService(db.pool, mock.value).verifyPersistedSettlement("requested-only"),
    expectFujiCode("INVALID_SETTLEMENT_STATE"),
  );
  assert.equal(mock.calls.chain, 0);
});

test("database enforces append-only verification evidence and terminal state", async () => {
  const attempt = await submitted();
  await createVerificationService(db.pool, gateway(attempt.networkHash!).value).verifyPersistedSettlement("verify-1");
  for (const sql of [
    "UPDATE blockchain_private.settlement_attempts SET receipt_block_number = receipt_block_number + 1",
    "UPDATE blockchain_private.settlement_attempts SET verified_transfer_log_index = 8",
    "UPDATE blockchain_private.settlement_attempts SET attempt_state = 'BROADCAST_SUBMITTED'",
    "UPDATE blockchain_private.settlement_attempts SET signer_address = $1",
  ]) {
    await assert.rejects(db.admin.query(sql, sql.includes("$1") ? [other.toLowerCase()] : []));
  }
  assert.equal((await row()).attempt_state, "CONFIRMED");
});
