import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { encodeFunctionData, keccak256, maxUint256, type Address, type Hash } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { FujiError } from "../fuji/errors.js";
import { ERC20_ABI } from "../fuji/erc20.js";
import { FUJI_CHAIN_ID, FUJI_USDC_ADDRESS } from "../fuji/config.js";
import type { SignedUsdcTransfer } from "../fuji/settlement.js";
import { createPersistedSettlementService } from "../persistence/service.js";
import { createSettlementPool } from "../persistence/database.js";
import type { FujiSettlementGateway, SettlementRequest } from "../persistence/types.js";
import { startTestPostgres } from "./postgres-fixture.js";

const key = generatePrivateKey();
const account = privateKeyToAccount(key);
const destination = privateKeyToAccount(generatePrivateKey()).address;
let db: Awaited<ReturnType<typeof startTestPostgres>>;
let signCount = 0;
let broadcastCount = 0;
let pendingCount = 0;
let pendingNonce = 7;
let beforeSign: (() => Promise<void>) | undefined;
let beforeBroadcast: ((signed: SignedUsdcTransfer) => Promise<void>) | undefined;
let signFailure = false;
let broadcastFailure = false;
let identity = { chainId: FUJI_CHAIN_ID as number, signer: account.address, tokenAddress: FUJI_USDC_ADDRESS };
const signedResults: SignedUsdcTransfer[] = [];

const gateway: FujiSettlementGateway = {
  getIdentity: () => identity,
  async getPendingNonce() { pendingCount++; return pendingNonce; },
  async prepareAndSign(to, amountUnits, nonce) {
    signCount++;
    await beforeSign?.();
    if (signFailure) throw new Error("sensitive-signing-detail");
    const serializedTransaction = await account.signTransaction({
      chainId: FUJI_CHAIN_ID, type: "eip1559", to: FUJI_USDC_ADDRESS, value: 0n,
      nonce, gas: 60_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [to, amountUnits] }),
    });
    const signed: SignedUsdcTransfer = {
      chainId: FUJI_CHAIN_ID, signer: account.address, destination: to, tokenAddress: FUJI_USDC_ADDRESS,
      amountUnits, nonce, serializedTransaction, localHash: keccak256(serializedTransaction),
    };
    signedResults.push(signed);
    return signed;
  },
  async broadcast(signed) {
    broadcastCount++;
    await beforeBroadcast?.(signed);
    if (broadcastFailure) throw new Error("sensitive-rpc-detail");
    return signed.localHash;
  },
};
const request = (transferId = "transfer-1"): SettlementRequest => ({ transferId, destination, amountUnits: 1000n });
const service = () => createPersistedSettlementService(db.pool, gateway);
const secondService = () => createPersistedSettlementService(db.secondPool, gateway);
function code(expected: string) {
  return (error: unknown) => {
    assert.ok(error instanceof FujiError);
    assert.equal(error.code, expected);
    assert.ok(!String(error).includes("sensitive-"));
    assert.ok(!String(error).includes(key));
    return true;
  };
}

before(async () => { db = await startTestPostgres(); });
beforeEach(async () => {
  // Only this fixture's disposable database; never an external connection.
  await db.admin.query("DROP TRIGGER IF EXISTS inject_failure ON blockchain_private.settlement_attempts");
  await db.admin.query("DROP FUNCTION IF EXISTS blockchain_private.inject_failure()");
  await db.admin.query("TRUNCATE blockchain_private.settlement_attempts, blockchain_private.settlements, blockchain_private.signer_nonces");
  signCount = broadcastCount = pendingCount = 0;
  pendingNonce = 7;
  beforeSign = beforeBroadcast = undefined;
  signFailure = broadcastFailure = false;
  identity = { chainId: FUJI_CHAIN_ID, signer: account.address, tokenAddress: FUJI_USDC_ADDRESS };
  signedResults.length = 0;
});
after(async () => { await db?.close(); });

async function counts() {
  return (await db.admin.query(`
    SELECT (SELECT count(*)::int FROM blockchain_private.settlements) AS settlements,
           (SELECT count(*)::int FROM blockchain_private.settlement_attempts) AS attempts`)).rows[0];
}
async function rows() {
  return (await db.admin.query("SELECT * FROM blockchain_private.settlement_attempts ORDER BY nonce")).rows;
}
async function failAt(state: "SIGNED" | "BROADCAST_REQUESTED" | "BROADCAST_SUBMITTED", commit = false) {
  await db.admin.query(`
    CREATE FUNCTION blockchain_private.inject_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.attempt_state = '${state}' THEN RAISE EXCEPTION 'sensitive-database-detail'; END IF; RETURN NEW; END $$`);
  await db.admin.query(commit
    ? "CREATE CONSTRAINT TRIGGER inject_failure AFTER UPDATE ON blockchain_private.settlement_attempts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION blockchain_private.inject_failure()"
    : "CREATE TRIGGER inject_failure BEFORE UPDATE ON blockchain_private.settlement_attempts FOR EACH ROW EXECUTE FUNCTION blockchain_private.inject_failure()");
}

test("first request commits intent/attempt/nonce BEFORE signing, then persists all signed fields", async () => {
  beforeSign = async () => {
    assert.deepEqual(await counts(), { settlements: 1, attempts: 1 });
    const row = (await rows())[0];
    assert.equal(row.attempt_state, "PREPARING");
    assert.equal(row.nonce, "7");
    assert.equal(row.signed_transaction, null);
  };
  const dto = await service().preparePersistedSettlement(request());
  assert.equal(dto.status, "SIGNED");
  assert.equal(signCount, 1);
  assert.equal(broadcastCount, 0);
  const row = (await rows())[0];
  assert.equal(row.chain_id, 43113);
  assert.equal(row.signer_address, account.address.toLowerCase());
  assert.equal(row.destination_address, destination.toLowerCase());
  assert.equal(row.token_address, FUJI_USDC_ADDRESS.toLowerCase());
  assert.equal(row.amount_units, "1000");
  assert.equal(row.nonce, "7");
  assert.equal(row.signed_transaction, signedResults[0].serializedTransaction);
  assert.equal(row.local_tx_hash, signedResults[0].localHash);
  assert.ok(row.signed_at instanceof Date);
});

test("identical duplicate returns same attempt without signing or nonce allocation again", async () => {
  const first = await service().preparePersistedSettlement(request());
  const duplicate = await secondService().preparePersistedSettlement({
    ...request(), destination: destination.toLowerCase() as Address,
  });
  assert.deepEqual(duplicate, first);
  assert.equal(signCount, 1);
  assert.equal(pendingCount, 1);
  assert.deepEqual(await counts(), { settlements: 1, attempts: 1 });
});

test("conflicting amount, destination and signer are rejected without creating another attempt", async () => {
  await service().preparePersistedSettlement(request());
  await assert.rejects(service().preparePersistedSettlement({ ...request(), amountUnits: 2000n }), code("IDEMPOTENCY_CONFLICT"));
  await assert.rejects(service().preparePersistedSettlement({
    ...request(), destination: privateKeyToAccount(generatePrivateKey()).address,
  }), code("IDEMPOTENCY_CONFLICT"));
  identity.signer = privateKeyToAccount(generatePrivateKey()).address;
  await assert.rejects(service().preparePersistedSettlement(request()), code("IDEMPOTENCY_CONFLICT"));
  assert.equal(signCount, 1);
  assert.deepEqual(await counts(), { settlements: 1, attempts: 1 });
});

test("concurrent identical transfer IDs across independent pools create ONE attempt/signature", async () => {
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    (i % 2 ? service() : secondService()).preparePersistedSettlement(request())));
  assert.equal(new Set(results.map((r) => r.attemptId)).size, 1);
  assert.equal(new Set(results.map((r) => r.settlementId)).size, 1);
  assert.equal(signCount, 1);
  assert.equal(pendingCount, 1);
  assert.deepEqual(await counts(), { settlements: 1, attempts: 1 });
  assert.equal((await rows())[0].attempt_state, "SIGNED");
});

test("concurrent different transfers allocate distinct nonces despite identical RPC pending nonce", async () => {
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    (i % 2 ? service() : secondService()).preparePersistedSettlement(request(`transfer-${i}`))));
  assert.deepEqual(results.map((r) => r.nonce).sort((a, b) => a - b), [7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  assert.equal(signCount, 10);
  assert.deepEqual(await counts(), { settlements: 10, attempts: 10 });
});

test("nonce allocator takes max of pending nonce and durable cursor without going backwards", async () => {
  assert.equal((await service().preparePersistedSettlement(request("a"))).nonce, 7);
  pendingNonce = 20;
  assert.equal((await service().preparePersistedSettlement(request("b"))).nonce, 20);
  pendingNonce = 1;
  assert.equal((await secondService().preparePersistedSettlement(request("c"))).nonce, 21);
});

test("broadcast receives exact bytes read from a committed database row", async () => {
  beforeBroadcast = async (signed) => {
    const row = (await rows())[0];
    assert.equal(row.attempt_state, "BROADCAST_REQUESTED");
    assert.ok(row.broadcast_requested_at instanceof Date);
    assert.equal(row.signed_transaction, signed.serializedTransaction);
    assert.equal(row.local_tx_hash, signed.localHash);
    assert.notEqual(signed, signedResults[0]);
  };
  const dto = await service().executePersistedSettlement(request());
  assert.equal(dto.status, "BROADCAST_SUBMITTED");
  assert.equal(dto.localHash, dto.networkHash);
  assert.equal(broadcastCount, 1);
  assert.deepEqual(await secondService().executePersistedSettlement(request()), dto);
  assert.equal(signCount, 1);
  assert.equal(broadcastCount, 1);
});

test("concurrent execute calls claim the same signed broadcast at most once", async () => {
  await service().preparePersistedSettlement(request());
  await Promise.all(Array.from({ length: 10 }, (_, i) =>
    (i % 2 ? service() : secondService()).executePersistedSettlement(request())));
  assert.equal(broadcastCount, 1);
  assert.equal(signCount, 1);
  assert.equal((await rows())[0].attempt_state, "BROADCAST_SUBMITTED");
});

test("DB write failure after signing prevents broadcast and leaves PREPARING, with no fresh retry", async () => {
  await failAt("SIGNED");
  await assert.rejects(service().executePersistedSettlement(request()), code("PERSISTENCE_FAILED"));
  assert.equal(signCount, 1);
  assert.equal(broadcastCount, 0);
  assert.equal((await rows())[0].attempt_state, "PREPARING");
  assert.equal((await secondService().executePersistedSettlement(request())).status, "PREPARING");
  assert.equal(signCount, 1);
  assert.equal(broadcastCount, 0);
});

test("failure at COMMIT (after UPDATE succeeds) still prevents broadcast", async () => {
  await failAt("SIGNED", true);
  await assert.rejects(service().executePersistedSettlement(request()), code("PERSISTENCE_FAILED"));
  assert.equal(signCount, 1);
  assert.equal(broadcastCount, 0);
  assert.equal((await rows())[0].attempt_state, "PREPARING");
});

test("failed broadcast-claim COMMIT prevents the RPC send", async () => {
  await service().preparePersistedSettlement(request());
  await failAt("BROADCAST_REQUESTED", true);
  await assert.rejects(service().executePersistedSettlement(request()), code("PERSISTENCE_FAILED"));
  assert.equal((await rows())[0].attempt_state, "SIGNED");
  assert.equal(broadcastCount, 0);
});

test("DB unavailable before claim prevents signing and broadcasting", async () => {
  const poolLike = { connect: async () => { throw new Error("sensitive-database-detail"); } } as unknown as typeof db.pool;
  await assert.rejects(createPersistedSettlementService(poolLike, gateway).executePersistedSettlement(request()), code("PERSISTENCE_FAILED"));
  assert.equal(signCount, 0);
  assert.equal(broadcastCount, 0);
});

test("signing error leaves a durable PREPARING reservation and repeated calls do not sign again", async () => {
  signFailure = true;
  await assert.rejects(service().executePersistedSettlement(request()), code("SIGNING_FAILED"));
  signFailure = false;
  assert.equal((await secondService().executePersistedSettlement(request())).status, "PREPARING");
  assert.equal(signCount, 1);
  assert.equal(broadcastCount, 0);
  assert.equal((await service().preparePersistedSettlement(request("next"))).nonce, 8);
});

test("broadcast error leaves requested state; repeated calls never sign or send again", async () => {
  broadcastFailure = true;
  await assert.rejects(service().executePersistedSettlement(request()), code("BROADCAST_FAILED"));
  assert.equal((await rows())[0].attempt_state, "BROADCAST_REQUESTED");
  broadcastFailure = false;
  assert.equal((await secondService().executePersistedSettlement(request())).status, "BROADCAST_REQUESTED");
  assert.equal(signCount, 1);
  assert.equal(broadcastCount, 1);
  assert.deepEqual(await counts(), { settlements: 1, attempts: 1 });
});

test("submission-record failure preserves requested state without repeat send", async () => {
  await failAt("BROADCAST_SUBMITTED", true);
  await assert.rejects(service().executePersistedSettlement(request()), code("PERSISTENCE_FAILED"));
  assert.equal(broadcastCount, 1);
  assert.equal((await rows())[0].attempt_state, "BROADCAST_REQUESTED");
  await secondService().executePersistedSettlement(request());
  assert.equal(signCount, 1);
  assert.equal(broadcastCount, 1);
});

test("hash mismatch does not mark submitted and cannot trigger another attempt", async () => {
  const mismatchGateway = { ...gateway, broadcast: async () => { broadcastCount++; return `0x${"0".repeat(64)}` as Hash; } };
  await assert.rejects(createPersistedSettlementService(db.pool, mismatchGateway).executePersistedSettlement(request()), code("HASH_MISMATCH"));
  assert.equal((await rows())[0].attempt_state, "BROADCAST_REQUESTED");
  await service().executePersistedSettlement(request());
  assert.equal(signCount, 1);
  assert.equal(broadcastCount, 1);
});

test("uint256 amount survives persistence/JSON exactly beyond Number.MAX_SAFE_INTEGER", async () => {
  const dto = await service().preparePersistedSettlement({ ...request(), amountUnits: maxUint256 });
  assert.equal(dto.amountUnits, maxUint256.toString());
  assert.equal((await rows())[0].amount_units, maxUint256.toString());
  assert.equal(JSON.parse(JSON.stringify(dto)).amountUnits, maxUint256.toString());
});

test("safe DTO and persisted rows never contain private key; DTO omits signed bytes", async () => {
  const dto = await service().preparePersistedSettlement(request());
  const output = JSON.stringify(dto);
  assert.ok(!output.includes(signedResults[0].serializedTransaction));
  assert.ok(!output.includes("signed_transaction"));
  assert.ok(!output.includes("serializedTransaction"));
  assert.ok(!output.includes(key));
  const persisted = JSON.stringify((await db.admin.query(`
    SELECT row_to_json(s) AS intent, row_to_json(a) AS attempt
    FROM blockchain_private.settlements s JOIN blockchain_private.settlement_attempts a ON a.settlement_id = s.id`)).rows);
  assert.ok(!persisted.includes(key));
  assert.deepEqual(Object.keys(dto).sort(), [
    "amountUnits", "attemptId", "chainId", "destination", "localHash", "networkHash",
    "nonce", "settlementId", "signer", "status", "tokenAddress", "transferId",
  ]);
});

test("wrong chain, unsupported token, invalid amounts/IDs fail before DB/signing", async () => {
  identity.chainId = 43114;
  await assert.rejects(service().preparePersistedSettlement(request()), code("WRONG_CHAIN"));
  identity.chainId = 43113;
  identity.tokenAddress = destination;
  await assert.rejects(service().preparePersistedSettlement(request()), code("CONFIG"));
  identity.tokenAddress = FUJI_USDC_ADDRESS;
  await assert.rejects(service().preparePersistedSettlement({ ...request(), amountUnits: 0n }), code("INVALID_AMOUNT"));
  await assert.rejects(service().preparePersistedSettlement(request("  ")), code("CONFIG"));
  assert.deepEqual(await counts(), { settlements: 0, attempts: 0 });
  assert.equal(signCount, 0);
});

test("wrong chain from pending-nonce RPC rolls back the claim without signing", async () => {
  const wrongNetwork = { ...gateway, getPendingNonce: async () => { throw new FujiError("WRONG_CHAIN", "Expected Fuji."); } };
  await assert.rejects(createPersistedSettlementService(db.pool, wrongNetwork).preparePersistedSettlement(request()), code("WRONG_CHAIN"));
  assert.deepEqual(await counts(), { settlements: 0, attempts: 0 });
  assert.equal(signCount, 0);
});

test("invalid pending nonce rolls back claim and reservation", async () => {
  pendingNonce = -1;
  await assert.rejects(service().preparePersistedSettlement(request()), code("NONCE_ALLOCATION_FAILED"));
  assert.deepEqual(await counts(), { settlements: 0, attempts: 0 });
});

test("a signed transaction with the wrong reserved nonce cannot be persisted or broadcast", async () => {
  const incorrectSigner = {
    ...gateway,
    prepareAndSign: (to: Address, amount: bigint, nonce: number) => gateway.prepareAndSign(to, amount, nonce + 1),
  };
  await assert.rejects(
    createPersistedSettlementService(db.pool, incorrectSigner).executePersistedSettlement(request()),
    code("INVALID_SETTLEMENT_STATE"),
  );
  assert.equal((await rows())[0].attempt_state, "PREPARING");
  assert.equal((await rows())[0].signed_transaction, null);
  assert.equal(broadcastCount, 0);
  await service().executePersistedSettlement(request());
  assert.equal(signCount, 1);
});

test("DB enforces immutable intent, signed bytes, nonce and forward-only state transitions", async () => {
  const dto = await service().preparePersistedSettlement(request());
  for (const sql of [
    "UPDATE blockchain_private.settlements SET amount_units = '2000'",
    "UPDATE blockchain_private.settlement_attempts SET nonce = nonce + 1",
    "UPDATE blockchain_private.settlement_attempts SET signed_transaction = '0x02ff'",
    "UPDATE blockchain_private.settlement_attempts SET attempt_state = 'PREPARING'",
    "UPDATE blockchain_private.signer_nonces SET next_nonce = 0",
  ]) await assert.rejects(db.admin.query(sql));
  assert.equal((await rows())[0].local_tx_hash, dto.localHash);
});

test("DB UNIQUE constraints reject duplicate transfer IDs, initial attempts and signer nonces", async () => {
  await service().preparePersistedSettlement(request());
  await assert.rejects(db.admin.query(`
    INSERT INTO blockchain_private.settlements (transfer_id, chain_id, signer_address, destination_address, token_address, amount_units)
    SELECT transfer_id, chain_id, signer_address, destination_address, token_address, amount_units FROM blockchain_private.settlements`),
    (e: any) => e.code === "23505");
  await assert.rejects(db.admin.query(`
    INSERT INTO blockchain_private.settlement_attempts
      (settlement_id, chain_id, signer_address, destination_address, token_address, amount_units, nonce, attempt_state)
    SELECT settlement_id, chain_id, signer_address, destination_address, token_address, amount_units, nonce + 1, 'PREPARING'
    FROM blockchain_private.settlement_attempts`), (e: any) => e.code === "23505");
  const second = (await db.admin.query(`
    INSERT INTO blockchain_private.settlements (transfer_id, chain_id, signer_address, destination_address, token_address, amount_units)
    SELECT 'second', chain_id, signer_address, destination_address, token_address, amount_units FROM blockchain_private.settlements RETURNING id`)).rows[0];
  await assert.rejects(db.admin.query(`
    INSERT INTO blockchain_private.settlement_attempts
      (settlement_id, chain_id, signer_address, destination_address, token_address, amount_units, nonce, attempt_state)
    SELECT $1, chain_id, signer_address, destination_address, token_address, amount_units, nonce, 'PREPARING'
    FROM blockchain_private.settlement_attempts`, [second.id]), (e: any) => e.code === "23505");
  const constraints = (await db.admin.query(`
    SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid = 'blockchain_private.settlement_attempts'::regclass AND contype = 'u'`)).rows;
  assert.ok(constraints.some((r) => r.definition === "UNIQUE (local_tx_hash)"));
});

test("runtime role cannot delete attempts; anonymous role cannot access private schema", async () => {
  await service().preparePersistedSettlement(request());
  await assert.rejects(db.pool.query("DELETE FROM blockchain_private.settlement_attempts"), (e: any) => e.code === "42501");
  await db.admin.query("CREATE ROLE fuji_test_anonymous NOLOGIN");
  const client = await db.admin.connect();
  try {
    await client.query("SET ROLE fuji_test_anonymous");
    await assert.rejects(client.query("SELECT signed_transaction FROM blockchain_private.settlement_attempts"), (e: any) => e.code === "42501");
  } finally {
    await client.query("RESET ROLE");
    client.release();
  }
});

test("database config failure is actionable and does not echo credentials", () => {
  const prior = process.env.SUPABASE_DB_URL;
  try {
    delete process.env.SUPABASE_DB_URL;
    assert.throws(createSettlementPool, code("CONFIG"));
    process.env.SUPABASE_DB_URL = "https://user:sensitive-password@example.test";
    assert.throws(createSettlementPool, code("CONFIG"));
  } finally {
    if (prior === undefined) delete process.env.SUPABASE_DB_URL;
    else process.env.SUPABASE_DB_URL = prior;
  }
});
