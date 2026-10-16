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
import { SettlementRepository } from "../persistence/repository.js";
import { createPersistedSettlementService } from "../persistence/service.js";
import type { FujiSettlementGateway, SettlementIntent } from "../persistence/types.js";
import { createRecoveryService } from "../recovery/service.js";
import type { FujiRecoveryGateway, RecoveryResultDto } from "../recovery/types.js";
import type {
  VerificationLog,
  VerificationReceipt,
  VerificationTransaction,
} from "../verification/types.js";
import { startTestPostgres } from "./postgres-fixture.js";

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);
const destination = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;
const secondDestination = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;
const otherAddress = privateKeyToAccount(generatePrivateKey()).address;
const signer = account.address.toLowerCase() as Address;
const token = FUJI_USDC_ADDRESS.toLowerCase() as Address;
const blockHash = `0x${"ab".repeat(32)}` as Hash;
const otherHash = `0x${"cd".repeat(32)}` as Hash;
let db: Awaited<ReturnType<typeof startTestPostgres>>;

type GatewayControls = {
  calls: { chain: number; nonce: number; sign: number; broadcast: number; transaction: number; receipt: number };
  broadcastBytes: string[];
  signedNonces: number[];
};

before(async () => {
  db = await startTestPostgres();
});

beforeEach(async () => {
  await db.admin.query("DROP TRIGGER IF EXISTS inject_recovery_failure ON blockchain_private.settlement_attempts");
  await db.admin.query("DROP FUNCTION IF EXISTS blockchain_private.inject_recovery_failure()");
  await db.admin.query("TRUNCATE blockchain_private.settlement_attempts, blockchain_private.settlements, blockchain_private.signer_nonces");
});

after(async () => {
  await db?.close();
});

function intent(transferId: string, amountUnits = 1000n, to = destination): SettlementIntent {
  return {
    transferId,
    chainId: FUJI_CHAIN_ID,
    signer,
    destination: to,
    tokenAddress: token,
    amountUnits,
  };
}

async function signedTransfer(nonce: number, amountUnits = 1000n, to = destination): Promise<SignedUsdcTransfer> {
  const serializedTransaction = await account.signTransaction({
    chainId: FUJI_CHAIN_ID,
    type: "eip1559",
    to: FUJI_USDC_ADDRESS,
    value: 0n,
    nonce,
    gas: 60_000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    data: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [to, amountUnits],
    }),
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
  };
}

async function preparing(transferId = "recover-1", amountUnits = 1000n, pending = 7, to = destination) {
  return new SettlementRepository(db.pool).claim(intent(transferId, amountUnits, to), async () => pending);
}

async function signed(transferId = "recover-1", amountUnits = 1000n, pending = 7, to = destination) {
  const claim = await preparing(transferId, amountUnits, pending, to);
  const value = await signedTransfer(claim.attempt.nonce, amountUnits, to);
  const attempt = await new SettlementRepository(db.pool).persistSigned(claim.attempt.attemptId, value);
  return { attempt, signed: value };
}

async function requested(transferId = "recover-1", amountUnits = 1000n) {
  const value = await signed(transferId, amountUnits);
  await new SettlementRepository(db.pool).claimBroadcast(value.attempt.attemptId);
  return value;
}

async function submitted(transferId = "recover-1", amountUnits = 1000n) {
  const value = await requested(transferId, amountUnits);
  const attempt = await new SettlementRepository(db.pool).markSubmitted(value.attempt.attemptId, value.signed.localHash);
  return { attempt, signed: value.signed };
}

function transaction(hash: Hash, nonce = 7, amountUnits = 1000n, overrides: Partial<VerificationTransaction> = {}): VerificationTransaction {
  return {
    hash,
    chainId: FUJI_CHAIN_ID,
    from: account.address,
    to: FUJI_USDC_ADDRESS,
    nonce,
    input: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [destination, amountUnits] }),
    ...overrides,
  };
}

function transferLog(hash: Hash, amountUnits = 1000n): VerificationLog {
  return {
    address: FUJI_USDC_ADDRESS,
    data: encodeAbiParameters([{ type: "uint256" }], [amountUnits]),
    topics: encodeEventTopics({
      abi: ERC20_ABI,
      eventName: "Transfer",
      args: { from: account.address, to: destination },
    }) as unknown as readonly `0x${string}`[],
    logIndex: 5,
    transactionHash: hash,
    blockNumber: 1234n,
    blockHash,
    removed: false,
  };
}

function receipt(hash: Hash, amountUnits = 1000n, overrides: Partial<VerificationReceipt> = {}): VerificationReceipt {
  return {
    transactionHash: hash,
    status: "success",
    blockNumber: 1234n,
    blockHash,
    logs: [transferLog(hash, amountUnits)],
    ...overrides,
  };
}

function recoveryGateway(overrides: Partial<FujiRecoveryGateway> = {}): { value: FujiRecoveryGateway; controls: GatewayControls } {
  const controls: GatewayControls = {
    calls: { chain: 0, nonce: 0, sign: 0, broadcast: 0, transaction: 0, receipt: 0 },
    broadcastBytes: [],
    signedNonces: [],
  };
  const value: FujiRecoveryGateway = {
    getIdentity: () => ({ chainId: FUJI_CHAIN_ID, signer: account.address, tokenAddress: FUJI_USDC_ADDRESS }),
    async getChainId() {
      controls.calls.chain++;
      return FUJI_CHAIN_ID;
    },
    async getNonceState() {
      controls.calls.nonce++;
      return { latest: 7, pending: 7 };
    },
    async prepareAndSign(to, amountUnits, nonce) {
      controls.calls.sign++;
      controls.signedNonces.push(nonce);
      return signedTransfer(nonce, amountUnits, to);
    },
    async broadcast(value) {
      controls.calls.broadcast++;
      controls.broadcastBytes.push(value.serializedTransaction);
      return value.localHash;
    },
    async getTransaction() {
      controls.calls.transaction++;
      return null;
    },
    async getReceipt() {
      controls.calls.receipt++;
      return null;
    },
    ...overrides,
  };
  return { value, controls };
}

async function attemptRow() {
  return (await db.admin.query("SELECT * FROM blockchain_private.settlement_attempts")).rows[0];
}

async function counts() {
  const result = await db.admin.query(`
    SELECT
      (SELECT count(*)::int FROM blockchain_private.settlements) AS settlements,
      (SELECT count(*)::int FROM blockchain_private.settlement_attempts) AS attempts`);
  return result.rows[0] as { settlements: number; attempts: number };
}

test("PREPARING recovery reuses the same reserved nonce", async () => {
  const initial = await preparing();
  const mock = recoveryGateway();
  const result = await createRecoveryService(db.pool, mock.value).reconcilePersistedSettlement("recover-1");
  assert.equal(result.attemptState, "SIGNED");
  assert.equal(result.recoveryOutcome, "RECOVERED");
  assert.deepEqual(mock.controls.signedNonces, [initial.attempt.nonce]);
});

test("PREPARING recovery never allocates another nonce", async () => {
  const initial = await preparing();
  const before = (await db.admin.query("SELECT next_nonce FROM blockchain_private.signer_nonces")).rows[0].next_nonce;
  await createRecoveryService(db.pool, recoveryGateway().value).reconcilePersistedSettlement("recover-1");
  const after = (await db.admin.query("SELECT next_nonce FROM blockchain_private.signer_nonces")).rows[0].next_nonce;
  assert.equal(initial.attempt.nonce, 7);
  assert.equal(before, "8");
  assert.equal(after, "8");
});

test("PREPARING recovery persists signed bytes and stops before broadcast", async () => {
  await preparing();
  const mock = recoveryGateway();
  await createRecoveryService(db.pool, mock.value).reconcilePersistedSettlement("recover-1");
  const row = await attemptRow();
  assert.equal(row.attempt_state, "SIGNED");
  assert.match(row.signed_transaction, /^0x02/);
  assert.match(row.local_tx_hash, /^0x[0-9a-f]{64}$/);
  assert.equal(mock.controls.calls.broadcast, 0);
});

test("PREPARING with consumed nonce refuses to sign", async () => {
  await preparing();
  const mock = recoveryGateway({ getNonceState: async () => ({ latest: 8, pending: 8 }) });
  const result = await createRecoveryService(db.pool, mock.value).reconcilePersistedSettlement("recover-1");
  assert.equal(result.recoveryOutcome, "NONCE_CONFLICT");
  assert.equal((await attemptRow()).attempt_state, "PREPARING");
  assert.equal(mock.controls.calls.sign, 0);
  assert.equal(mock.controls.calls.broadcast, 0);
});

test("concurrent PREPARING recovery signs at most once", async () => {
  await preparing();
  const mock = recoveryGateway({
    async prepareAndSign(to, amount, nonce) {
      mock.controls.calls.sign++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return signedTransfer(nonce, amount, to);
    },
  });
  const services = Array.from({ length: 8 }, (_, index) =>
    createRecoveryService(index % 2 ? db.pool : db.secondPool, mock.value));
  const results = await Promise.all(services.map((service) => service.reconcilePersistedSettlement("recover-1")));
  assert.equal(mock.controls.calls.sign, 1);
  assert.ok(results.some((result) => result.attemptState === "SIGNED"));
});

test("SIGNED recovery does not sign again", async () => {
  await signed();
  const mock = recoveryGateway();
  const result = await createRecoveryService(db.pool, mock.value).reconcilePersistedSettlement("recover-1");
  assert.equal(result.attemptState, "BROADCAST_SUBMITTED");
  assert.equal(mock.controls.calls.sign, 0);
});

test("SIGNED recovery broadcasts exact persisted bytes", async () => {
  const existing = await signed();
  const mock = recoveryGateway();
  await createRecoveryService(db.pool, mock.value).reconcilePersistedSettlement("recover-1");
  assert.deepEqual(mock.controls.broadcastBytes, [existing.signed.serializedTransaction]);
  assert.equal((await attemptRow()).network_tx_hash, existing.signed.localHash);
});

test("concurrent SIGNED recovery broadcasts at most once", async () => {
  await signed();
  const mock = recoveryGateway({
    async broadcast(value) {
      mock.controls.calls.broadcast++;
      mock.controls.broadcastBytes.push(value.serializedTransaction);
      await new Promise((resolve) => setTimeout(resolve, 30));
      return value.localHash;
    },
  });
  const services = Array.from({ length: 10 }, (_, index) =>
    createRecoveryService(index % 2 ? db.pool : db.secondPool, mock.value));
  await Promise.all(services.map((service) => service.reconcilePersistedSettlement("recover-1")));
  assert.equal(mock.controls.calls.broadcast, 1);
  assert.equal((await attemptRow()).attempt_state, "BROADCAST_SUBMITTED");
});

test("BROADCAST_REQUESTED finds the transaction by local hash without rebroadcast", async () => {
  const existing = await requested();
  const mock = recoveryGateway({
    getTransaction: async (hash) => transaction(hash, existing.attempt.nonce),
  });
  const result = await createRecoveryService(db.pool, mock.value).reconcilePersistedSettlement("recover-1");
  assert.equal(result.recoveryCode, "BROADCAST_TRANSACTION_FOUND");
  assert.equal(result.attemptState, "BROADCAST_SUBMITTED");
  assert.equal(mock.controls.calls.broadcast, 0);
});

test("lost RPC response recovers the original accepted transaction", async () => {
  let accepted: VerificationTransaction | null = null;
  let signatures = 0;
  let broadcasts = 0;
  const task2Gateway: FujiSettlementGateway = {
    getIdentity: () => ({ chainId: FUJI_CHAIN_ID, signer, tokenAddress: token }),
    getPendingNonce: async () => 7,
    async prepareAndSign(to, amount, nonce) {
      signatures++;
      return signedTransfer(nonce, amount, to);
    },
    async broadcast(value) {
      broadcasts++;
      accepted = transaction(value.localHash, value.nonce, value.amountUnits);
      throw new Error("lost response with sensitive details");
    },
  };
  await assert.rejects(
    createPersistedSettlementService(db.pool, task2Gateway).executePersistedSettlement({
      transferId: "lost-response",
      destination,
      amountUnits: 1000n,
    }),
    (error: unknown) => error instanceof FujiError && error.code === "BROADCAST_FAILED",
  );
  assert.equal((await attemptRow()).attempt_state, "BROADCAST_REQUESTED");

  const mock = recoveryGateway({ getTransaction: async () => accepted });
  const result = await createRecoveryService(db.secondPool, mock.value).reconcilePersistedSettlement("lost-response");
  assert.equal(result.attemptState, "BROADCAST_SUBMITTED");
  assert.deepEqual(await counts(), { settlements: 1, attempts: 1 });
  assert.equal(signatures, 1);
  assert.equal(broadcasts, 1);
  assert.equal(mock.controls.calls.broadcast, 0);
});

test("missing transaction with safe nonce performs one exact-byte rebroadcast", async () => {
  const existing = await requested();
  const mock = recoveryGateway();
  const result = await createRecoveryService(db.pool, mock.value).reconcilePersistedSettlement("recover-1");
  assert.equal(result.recoveryCode, "EXACT_REBROADCAST_SUBMITTED");
  assert.equal(result.transactionHash, existing.signed.localHash);
  assert.deepEqual(mock.controls.broadcastBytes, [existing.signed.serializedTransaction]);
  assert.equal(mock.controls.calls.sign, 0);
});

test("concurrent exact-byte rebroadcast sends at most once", async () => {
  await requested();
  const mock = recoveryGateway({
    async broadcast(value) {
      mock.controls.calls.broadcast++;
      mock.controls.broadcastBytes.push(value.serializedTransaction);
      await new Promise((resolve) => setTimeout(resolve, 30));
      return value.localHash;
    },
  });
  const services = Array.from({ length: 10 }, (_, index) =>
    createRecoveryService(index % 2 ? db.pool : db.secondPool, mock.value));
  await Promise.all(services.map((service) => service.reconcilePersistedSettlement("recover-1")));
  assert.equal(mock.controls.calls.broadcast, 1);
  assert.equal((await attemptRow()).attempt_state, "BROADCAST_SUBMITTED");
});

test("missing transaction with advanced nonce becomes conflict without send", async () => {
  await requested();
  const mock = recoveryGateway({ getNonceState: async () => ({ latest: 8, pending: 9 }) });
  const result = await createRecoveryService(db.pool, mock.value).reconcilePersistedSettlement("recover-1");
  assert.equal(result.recoveryOutcome, "NONCE_CONFLICT");
  assert.equal(mock.controls.calls.sign, 0);
  assert.equal(mock.controls.calls.broadcast, 0);
  assert.deepEqual(await counts(), { settlements: 1, attempts: 1 });
});

test("RPC timeout during reconciliation remains uncertain without blockchain write", async () => {
  await requested();
  const mock = recoveryGateway({ getTransaction: async () => { throw new Error("timeout secret"); } });
  const result = await createRecoveryService(db.pool, mock.value).reconcilePersistedSettlement("recover-1");
  assert.equal(result.recoveryOutcome, "RPC_UNCERTAIN");
  assert.equal((await attemptRow()).attempt_state, "BROADCAST_REQUESTED");
  assert.equal(mock.controls.calls.sign, 0);
  assert.equal(mock.controls.calls.broadcast, 0);
  assert.ok(!result.recoveryReason.includes("secret"));
});

test("BROADCAST_SUBMITTED delegates transaction and receipt reads to Task 3", async () => {
  const existing = await submitted();
  const mock = recoveryGateway({
    getTransaction: async (hash) => { mock.controls.calls.transaction++; return transaction(hash); },
    getReceipt: async (hash) => { mock.controls.calls.receipt++; return receipt(hash); },
  });
  const result = await createRecoveryService(db.pool, mock.value).reconcilePersistedSettlement("recover-1");
  assert.equal(result.attemptState, "CONFIRMED");
  assert.equal(mock.controls.calls.transaction, 1);
  assert.equal(mock.controls.calls.receipt, 1);
  assert.equal(result.transactionHash, existing.signed.localHash);
});

test("BROADCAST_SUBMITTED receipt pending remains pending and never rebroadcasts", async () => {
  await submitted();
  const mock = recoveryGateway({
    getTransaction: async (hash) => transaction(hash),
    getReceipt: async () => null,
  });
  const result = await createRecoveryService(db.pool, mock.value).reconcilePersistedSettlement("recover-1");
  assert.equal(result.recoveryOutcome, "PENDING");
  assert.equal(result.attemptState, "BROADCAST_SUBMITTED");
  assert.equal(mock.controls.calls.broadcast, 0);
});

test("BROADCAST_SUBMITTED reaches CONFIRMED through exact Task 3 evidence", async () => {
  await submitted();
  const mock = recoveryGateway({
    getTransaction: async (hash) => transaction(hash),
    getReceipt: async (hash) => receipt(hash),
  });
  const result = await createRecoveryService(db.pool, mock.value).reconcilePersistedSettlement("recover-1");
  assert.equal(result.recoveryOutcome, "TERMINAL");
  assert.equal(result.attemptState, "CONFIRMED");
  assert.equal(result.blockNumber, "1234");
});

test("CONFIRMED recovery performs no blockchain operation", async () => {
  await submitted();
  const confirming = recoveryGateway({
    getTransaction: async (hash) => transaction(hash),
    getReceipt: async (hash) => receipt(hash),
  });
  await createRecoveryService(db.pool, confirming.value).reconcilePersistedSettlement("recover-1");
  const terminal = recoveryGateway();
  const result = await createRecoveryService(db.pool, terminal.value).reconcilePersistedSettlement("recover-1");
  assert.equal(result.attemptState, "CONFIRMED");
  assert.deepEqual(terminal.controls.calls, { chain: 0, nonce: 0, sign: 0, broadcast: 0, transaction: 0, receipt: 0 });
});

test("REVERTED recovery performs no replacement", async () => {
  const existing = await submitted();
  const reverting = recoveryGateway({
    getTransaction: async (hash) => transaction(hash),
    getReceipt: async (hash) => receipt(hash, 1000n, { status: "reverted", logs: [] }),
  });
  await createRecoveryService(db.pool, reverting.value).reconcilePersistedSettlement("recover-1");
  const terminal = recoveryGateway();
  const result = await createRecoveryService(db.pool, terminal.value).reconcilePersistedSettlement("recover-1");
  assert.equal(result.attemptState, "REVERTED");
  assert.equal(result.transactionHash, existing.signed.localHash);
  assert.equal(terminal.controls.calls.sign, 0);
  assert.equal(terminal.controls.calls.broadcast, 0);
});

test("VERIFICATION_FAILED recovery performs no replacement", async () => {
  await submitted();
  const failing = recoveryGateway({
    getTransaction: async (hash) => transaction(hash),
    getReceipt: async (hash) => receipt(hash, 1000n, { logs: [] }),
  });
  await createRecoveryService(db.pool, failing.value).reconcilePersistedSettlement("recover-1");
  const terminal = recoveryGateway();
  const result = await createRecoveryService(db.pool, terminal.value).reconcilePersistedSettlement("recover-1");
  assert.equal(result.attemptState, "VERIFICATION_FAILED");
  assert.equal(terminal.controls.calls.sign, 0);
  assert.equal(terminal.controls.calls.broadcast, 0);
});

test("service re-instantiation recovers only from durable DB and Fuji state", async () => {
  const existing = await requested();
  const first = createRecoveryService(db.pool, recoveryGateway({ getTransaction: async () => { throw new Error(); } }).value);
  assert.equal((await first.reconcilePersistedSettlement("recover-1")).recoveryOutcome, "RPC_UNCERTAIN");
  const secondMock = recoveryGateway({ getTransaction: async (hash) => transaction(hash, existing.attempt.nonce) });
  const second = createRecoveryService(db.secondPool, secondMock.value);
  const result = await second.reconcilePersistedSettlement("recover-1");
  assert.equal(result.attemptState, "BROADCAST_SUBMITTED");
  assert.equal(secondMock.controls.calls.broadcast, 0);
});

test("duplicate reconciliation keeps one settlement and one attempt", async () => {
  const existing = await requested();
  const mock = recoveryGateway({ getTransaction: async (hash) => transaction(hash, existing.attempt.nonce) });
  const service = createRecoveryService(db.pool, mock.value);
  await service.reconcilePersistedSettlement("recover-1");
  await service.reconcilePersistedSettlement("recover-1");
  assert.deepEqual(await counts(), { settlements: 1, attempts: 1 });
  assert.equal(mock.controls.calls.broadcast, 0);
});

test("safe recovery DTO never exposes exact signed bytes", async () => {
  const existing = await signed();
  const result = await createRecoveryService(db.pool, recoveryGateway().value).reconcilePersistedSettlement("recover-1");
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(existing.signed.serializedTransaction));
  assert.ok(!("signedTransaction" in result));
  assert.deepEqual(Object.keys(result).sort(), [
    "amountUnits", "attemptId", "attemptState", "blockHash", "blockNumber",
    "chainId", "confirmedAt", "destination", "lastRecoveryAt", "nonce",
    "recoveryAttemptCount", "recoveryCode", "recoveryOutcome", "recoveryReason",
    "settlementId", "signer", "tokenAddress", "transactionHash", "transferId",
    "transferLogIndex", "verificationFailureCode", "verifiedAt",
  ].sort());
});

test("database schema and rows never persist a private key", async () => {
  await preparing();
  await createRecoveryService(db.pool, recoveryGateway().value).reconcilePersistedSettlement("recover-1");
  const columns = (await db.admin.query(`
    SELECT column_name FROM information_schema.columns WHERE table_schema = 'blockchain_private'`))
    .rows.map((row) => row.column_name);
  assert.ok(!columns.some((name) => /private|seed|mnemonic/i.test(name)));
  assert.ok(!JSON.stringify(await attemptRow()).includes(privateKey));
});

test("recovery cannot change immutable intent, nonce, signed bytes or hash", async () => {
  const existing = await signed();
  await createRecoveryService(db.pool, recoveryGateway().value).reconcilePersistedSettlement("recover-1");
  await assert.rejects(db.pool.query(`
    UPDATE blockchain_private.settlement_attempts
    SET amount_units = '999', destination_address = $2, nonce = nonce + 1,
        signed_transaction = '0x02ff', local_tx_hash = $3
    WHERE id = $1`, [existing.attempt.attemptId, otherAddress.toLowerCase(), otherHash]));
});

test("two different settlements retain distinct reserved nonces during recovery", async () => {
  const first = await preparing("recover-a", 1000n, 7, destination);
  const second = await preparing("recover-b", 2000n, 7, secondDestination);
  assert.equal(first.attempt.nonce, 7);
  assert.equal(second.attempt.nonce, 8);
  const firstMock = recoveryGateway({ getNonceState: async () => ({ latest: 7, pending: 7 }) });
  const secondMock = recoveryGateway({ getNonceState: async () => ({ latest: 7, pending: 7 }) });
  await Promise.all([
    createRecoveryService(db.pool, firstMock.value).reconcilePersistedSettlement("recover-a"),
    createRecoveryService(db.secondPool, secondMock.value).reconcilePersistedSettlement("recover-b"),
  ]);
  const rows = (await db.admin.query("SELECT nonce FROM blockchain_private.settlement_attempts ORDER BY nonce")).rows;
  assert.deepEqual(rows.map((row) => row.nonce), ["7", "8"]);
});

test("max uint256 amount remains exact through PREPARING recovery", async () => {
  await preparing("recover-max", maxUint256);
  const mock = recoveryGateway();
  const result = await createRecoveryService(db.pool, mock.value).reconcilePersistedSettlement("recover-max");
  assert.equal(result.amountUnits, maxUint256.toString());
  assert.equal((await attemptRow()).amount_units, maxUint256.toString());
});

test("recovery claim DB failure happens before signing or broadcast", async () => {
  await preparing();
  await db.admin.query(`
    CREATE FUNCTION blockchain_private.inject_recovery_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.recovery_sign_claimed_at IS NULL AND NEW.recovery_sign_claimed_at IS NOT NULL THEN
        RAISE EXCEPTION 'sensitive-database-detail';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER inject_recovery_failure BEFORE UPDATE ON blockchain_private.settlement_attempts
    FOR EACH ROW EXECUTE FUNCTION blockchain_private.inject_recovery_failure()`);
  const mock = recoveryGateway();
  await assert.rejects(
    createRecoveryService(db.pool, mock.value).reconcilePersistedSettlement("recover-1"),
    (error: unknown) => error instanceof FujiError && error.code === "PERSISTENCE_FAILED" &&
      !String(error).includes("sensitive-database-detail"),
  );
  assert.equal(mock.controls.calls.sign, 0);
  assert.equal(mock.controls.calls.broadcast, 0);
  assert.deepEqual(await counts(), { settlements: 1, attempts: 1 });
});

test("exact-byte rebroadcast hash mismatch never creates a second send", async () => {
  await requested();
  const mock = recoveryGateway({ broadcast: async () => { mock.controls.calls.broadcast++; return otherHash; } });
  const service = createRecoveryService(db.pool, mock.value);
  const first = await service.reconcilePersistedSettlement("recover-1");
  const second = await service.reconcilePersistedSettlement("recover-1");
  assert.equal(first.recoveryOutcome, "RPC_UNCERTAIN");
  assert.equal(second.recoveryOutcome, "RPC_UNCERTAIN");
  assert.equal(mock.controls.calls.broadcast, 1);
  assert.equal((await attemptRow()).attempt_state, "BROADCAST_REQUESTED");
});

test("wrong chain is rejected before signing or broadcast", async () => {
  await preparing();
  const mock = recoveryGateway({ getChainId: async () => 1 });
  await assert.rejects(
    createRecoveryService(db.pool, mock.value).reconcilePersistedSettlement("recover-1"),
    (error: unknown) => error instanceof FujiError && error.code === "WRONG_CHAIN",
  );
  assert.equal(mock.controls.calls.sign, 0);
  assert.equal(mock.controls.calls.broadcast, 0);
});

test("one reconciliation call is bounded to one state branch and one blockchain action", async () => {
  await preparing();
  const mock = recoveryGateway();
  const first = await createRecoveryService(db.pool, mock.value).reconcilePersistedSettlement("recover-1");
  assert.equal(first.attemptState, "SIGNED");
  assert.equal(mock.controls.calls.sign, 1);
  assert.equal(mock.controls.calls.broadcast, 0);
  assert.equal(mock.controls.calls.transaction, 0);
  assert.equal(mock.controls.calls.receipt, 0);
});

test("transaction found with mismatched metadata is a conflict, not a send", async () => {
  const existing = await requested();
  const mock = recoveryGateway({
    getTransaction: async (hash) => transaction(hash, existing.attempt.nonce, 1000n, { from: otherAddress }),
  });
  const result = await createRecoveryService(db.pool, mock.value).reconcilePersistedSettlement("recover-1");
  assert.equal(result.recoveryOutcome, "RECOVERY_CONFLICT");
  assert.equal(result.recoveryCode, "TRANSACTION_MISMATCH");
  assert.equal(mock.controls.calls.broadcast, 0);
});

test("invalid persisted signed bytes cannot be exact-byte rebroadcast", async () => {
  await requested();
  await db.admin.query("ALTER TABLE blockchain_private.settlement_attempts DISABLE TRIGGER guard_attempt");
  await db.admin.query("UPDATE blockchain_private.settlement_attempts SET signed_transaction = '0x02ff'");
  await db.admin.query("ALTER TABLE blockchain_private.settlement_attempts ENABLE TRIGGER guard_attempt");
  const mock = recoveryGateway();
  const result = await createRecoveryService(db.pool, mock.value).reconcilePersistedSettlement("recover-1");
  assert.equal(result.recoveryOutcome, "RECOVERY_CONFLICT");
  assert.equal(result.recoveryCode, "INVALID_SIGNED_TRANSACTION");
  assert.equal(mock.controls.calls.broadcast, 0);
});

test("recovery metadata records each invocation without exposing secrets", async () => {
  await requested();
  const mock = recoveryGateway({ getTransaction: async () => { throw new Error("credential-bearing-url"); } });
  const result = await createRecoveryService(db.pool, mock.value).reconcilePersistedSettlement("recover-1");
  const row = await attemptRow();
  assert.equal(row.recovery_attempt_count, 1);
  assert.equal(row.last_recovery_code, "RPC_UNCERTAIN");
  assert.ok(row.last_recovery_at instanceof Date);
  assert.ok(!result.recoveryReason.includes("credential-bearing-url"));
});
