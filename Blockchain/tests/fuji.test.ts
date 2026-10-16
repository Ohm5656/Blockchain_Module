import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import {
  decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256,
  maxUint256, parseTransaction, recoverTransactionAddress, toHex,
  type Address, type Hex, type TransactionSerialized,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { startTestPostgres } from "./postgres-fixture.js";

type RpcCall = { id: number; method: string; params: unknown[] };
// Ephemeral test-only keys, never committed or used on any real network.
const testKey = generatePrivateKey();
const account = privateKeyToAccount(testKey);
const destination = privateKeyToAccount(generatePrivateKey()).address;
const calls: RpcCall[] = [];
const rawBodies: string[] = [];
let chainId = 43113;
let avax = 10n ** 18n;
let usdc = 1_000_000n;
let decimals = 6;
let symbol = "USDC";
let simulation = true;
let failedMethod = "";
let broadcastMode: "ok" | "error" | "mismatch" = "ok";
let url: string;
let fuji: typeof import("../fuji/index.js");
let config: typeof import("../fuji/config.js");
let ERC20_ABI: typeof import("../fuji/erc20.js").ERC20_ABI;

const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  rawBodies.push(body);
  const call = JSON.parse(body) as RpcCall;
  calls.push(call);
  const reply = (result: unknown) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
  };
  const fail = (code = -32000) => {
    res.setHeader("content-type", "application/json");
    // Deliberately hostile RPC error, to prove it cannot reach caller logs.
    res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code, message: "unsafe-rpc-detail" } }));
  };
  if (call.method === failedMethod) return fail();
  switch (call.method) {
    case "eth_chainId": return reply(toHex(chainId));
    case "eth_blockNumber": return reply("0x1234");
    case "eth_getBalance": return reply(toHex(avax));
    case "eth_getTransactionCount": return reply("0x7");
    case "eth_getBlockByNumber":
      return reply({ number: "0x1234", baseFeePerGas: "0x3b9aca00", timestamp: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [] });
    case "eth_maxPriorityFeePerGas": return reply("0x3b9aca00");
    case "eth_gasPrice": return reply("0x77359400");
    case "eth_estimateGas": return reply("0xea60");
    case "eth_fillTransaction": return fail(-32601);
    case "eth_call": {
      const { data } = call.params[0] as { data: Hex };
      const decoded = decodeFunctionData({ abi: ERC20_ABI, data });
      if (decoded.functionName === "balanceOf") return reply(encodeAbiParameters([{ type: "uint256" }], [usdc]));
      if (decoded.functionName === "decimals") return reply(encodeAbiParameters([{ type: "uint8" }], [decimals]));
      if (decoded.functionName === "symbol") return reply(encodeAbiParameters([{ type: "string" }], [symbol]));
      return reply(encodeAbiParameters([{ type: "bool" }], [simulation]));
    }
    case "eth_sendRawTransaction":
      if (broadcastMode === "error") return fail();
      return reply(broadcastMode === "mismatch" ? toHex(1, { size: 32 }) : keccak256(call.params[0] as Hex));
    default: return fail(-32601);
  }
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  url = `http://127.0.0.1:${address.port}`;
  process.env.AVALANCHE_FUJI_RPC_URL = url;
  delete process.env.FUJI_USDC_ADDRESS;
  fuji = await import("../fuji/index.js");
  config = await import("../fuji/config.js");
  ({ ERC20_ABI } = await import("../fuji/erc20.js"));
});
beforeEach(() => {
  calls.length = 0;
  rawBodies.length = 0;
  chainId = 43113;
  avax = 10n ** 18n;
  usdc = 1_000_000n;
  decimals = 6;
  symbol = "USDC";
  simulation = true;
  failedMethod = "";
  broadcastMode = "ok";
  process.env.FUJI_SIGNER_PRIVATE_KEY = testKey;
  process.env.FUJI_DESTINATION_ADDRESS = destination;
  delete process.env.FUJI_SMOKE_TEST_USDC_UNITS;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

function expectCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof fuji.FujiError);
    assert.equal(error.code, code);
    assert.ok(!String(error).includes(testKey));
    assert.ok(!String(error).includes("unsafe-rpc-detail"));
    return true;
  };
}
function noBroadcast() {
  assert.equal(calls.filter((call) => call.method === "eth_sendRawTransaction").length, 0);
}
async function cli(script: string, overrides: Record<string, string> = {}, args: string[] = []) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", script, ...args], {
      env: { ...process.env, ...overrides }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

test("health checks Fuji block, wallet balances, token metadata and destination", async () => {
  const health = await fuji.getFujiModuleHealth();
  assert.equal(health.chainId, 43113);
  assert.equal(health.blockNumber, "4660");
  assert.equal(health.signerAddress, account.address);
  assert.equal(health.destinationAddress, destination);
  assert.equal(health.avax.units, avax.toString());
  assert.equal(health.usdc.units, usdc.toString());
  assert.equal(health.usdc.decimals, 6);
  noBroadcast();
});

test("real local signing exposes nonce/hash/bytes before one exact broadcast, without key access at broadcast", async () => {
  const signed = await fuji.prepareAndSignUsdcTransfer(destination, 1000n);
  noBroadcast();
  const tx = parseTransaction(signed.serializedTransaction);
  assert.equal(tx.chainId, 43113);
  assert.equal(tx.nonce, 7);
  assert.equal(tx.to?.toLowerCase(), fuji.FUJI_USDC_ADDRESS.toLowerCase());
  assert.equal(tx.value ?? 0n, 0n);
  assert.equal(signed.localHash, keccak256(signed.serializedTransaction));
  assert.equal(await recoverTransactionAddress({
    serializedTransaction: signed.serializedTransaction as TransactionSerialized<"eip1559">,
  }), account.address);
  assert.deepEqual(decodeFunctionData({ abi: ERC20_ABI, data: tx.data! }).args, [destination, 1000n]);
  const nonceCall = calls.find((call) => call.method === "eth_getTransactionCount")!;
  assert.equal(nonceCall.params[1], "pending");
  const transferCall = calls.findIndex((call) => call.method === "eth_call" &&
    (call.params[0] as { data: string }).data.startsWith("0xa9059cbb"));
  assert.ok(transferCall >= 0 && transferCall < calls.indexOf(nonceCall));

  delete process.env.FUJI_SIGNER_PRIVATE_KEY;
  assert.equal(await fuji.broadcastSignedTransaction(signed), signed.localHash);
  const broadcasts = calls.filter((call) => call.method === "eth_sendRawTransaction");
  assert.equal(broadcasts.length, 1);
  assert.deepEqual(broadcasts[0].params, [signed.serializedTransaction]);
  assert.ok(rawBodies.every((body) => !body.includes(testKey.slice(2))));
  assert.ok(calls.every((call) => !["eth_signTransaction", "eth_sendTransaction", "eth_getTransactionReceipt"].includes(call.method)));
});

test("wrong chain is rejected before token reads, signing or broadcast", async () => {
  chainId = 43114;
  await assert.rejects(fuji.getFujiNetworkHealth(), expectCode("WRONG_CHAIN"));
  await assert.rejects(fuji.prepareAndSignUsdcTransfer(destination, 1000n), expectCode("WRONG_CHAIN"));
  assert.ok(calls.every((call) => call.method === "eth_chainId"));
});

test("Task 2 reserved nonce is signed as supplied without fetching another pending nonce", async () => {
  const signed = await fuji.prepareAndSignUsdcTransfer(destination, 1000n, { nonce: 42 });
  assert.equal(signed.nonce, 42);
  assert.equal(parseTransaction(signed.serializedTransaction).nonce, 42);
  assert.ok(!calls.some((call) => call.method === "eth_getTransactionCount"));
  noBroadcast();
});

test("invalid reserved nonce is rejected before RPC or signing", async () => {
  for (const nonce of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(fuji.prepareAndSignUsdcTransfer(destination, 1000n, { nonce }), expectCode("PREPARATION_FAILED"));
  }
  assert.equal(calls.length, 0);
});

test("chain is rechecked before broadcast", async () => {
  const signed = await fuji.prepareAndSignUsdcTransfer(destination, 1000n);
  chainId = 1;
  await assert.rejects(fuji.broadcastSignedTransaction(signed), expectCode("WRONG_CHAIN"));
  noBroadcast();
});

test("read RPC failure is sanitized and not retried", async () => {
  failedMethod = "eth_chainId";
  await assert.rejects(fuji.getFujiNetworkHealth(), expectCode("RPC_UNAVAILABLE"));
  assert.equal(calls.length, 1);
});

test("missing, malformed and out-of-range signer keys fail without exposing values", async () => {
  for (const key of ["", "invalid", `0x${"0".repeat(64)}`, `0x${"f".repeat(64)}`]) {
    process.env.FUJI_SIGNER_PRIVATE_KEY = key;
    await assert.rejects(fuji.prepareAndSignUsdcTransfer(destination, 1000n), expectCode("CONFIG"));
  }
  assert.equal(calls.length, 0);
});

test("invalid, zero and self destinations are rejected", async () => {
  for (const address of ["bad", `0x${"0".repeat(40)}`, account.address]) {
    await assert.rejects(fuji.prepareAndSignUsdcTransfer(address as Address, 1000n), expectCode("INVALID_ADDRESS"));
  }
  process.env.FUJI_DESTINATION_ADDRESS = "";
  assert.throws(() => fuji.getFujiDestinationAddress(), expectCode("CONFIG"));
  noBroadcast();
});

test("amounts must be positive bigint uint256 base units", async () => {
  for (const amount of [0n, -1n, maxUint256 + 1n, 0.001, 1000, "1000"]) {
    await assert.rejects(fuji.prepareAndSignUsdcTransfer(destination, amount as bigint), expectCode("INVALID_AMOUNT"));
  }
  assert.equal(calls.length, 0);
  assert.equal(config.getFujiSmokeAmount(), 1000n);
  for (const amount of ["0", "-1", "0.001", "1e3", ""]) {
    process.env.FUJI_SMOKE_TEST_USDC_UNITS = amount;
    assert.throws(() => config.getFujiSmokeAmount(), expectCode("INVALID_AMOUNT"));
  }
});

test("zero gas and insufficient estimated gas funds are rejected", async () => {
  avax = 0n;
  await assert.rejects(fuji.prepareAndSignUsdcTransfer(destination, 1000n), expectCode("NO_GAS"));
  avax = 1n;
  await assert.rejects(fuji.prepareAndSignUsdcTransfer(destination, 1000n), expectCode("NO_GAS"));
  noBroadcast();
});

test("insufficient USDC is rejected before simulation", async () => {
  usdc = 999n;
  await assert.rejects(fuji.prepareAndSignUsdcTransfer(destination, 1000n), expectCode("INSUFFICIENT_USDC"));
  assert.ok(!calls.some((call) => call.method === "eth_getTransactionCount"));
  noBroadcast();
});

test("unexpected token metadata is rejected", async () => {
  decimals = 18;
  await assert.rejects(fuji.getFujiNetworkHealth(), expectCode("TOKEN_METADATA"));
  decimals = 6;
  symbol = "OTHER";
  await assert.rejects(fuji.prepareAndSignUsdcTransfer(destination, 1000n), expectCode("TOKEN_METADATA"));
  noBroadcast();
});

test("simulation false result and RPC revert stop before signing", async () => {
  simulation = false;
  await assert.rejects(fuji.prepareAndSignUsdcTransfer(destination, 1000n), expectCode("SIMULATION_FAILED"));
  const { fujiPublicClient } = await import("../fuji/clients.js");
  const original = fujiPublicClient.simulateContract;
  fujiPublicClient.simulateContract = (async () => { throw new Error("unsafe-rpc-detail"); }) as typeof original;
  try {
    await assert.rejects(fuji.prepareAndSignUsdcTransfer(destination, 1000n), expectCode("SIMULATION_FAILED"));
  } finally {
    fujiPublicClient.simulateContract = original;
  }
  noBroadcast();
});

test("nonce/preparation RPC failures are sanitized", async () => {
  failedMethod = "eth_getTransactionCount";
  await assert.rejects(fuji.prepareAndSignUsdcTransfer(destination, 1000n), expectCode("PREPARATION_FAILED"));
  noBroadcast();
});

test("modified metadata/hash and foreign-chain signed bytes are rejected before sending", async () => {
  const signed = await fuji.prepareAndSignUsdcTransfer(destination, 1000n);
  for (const changed of [
    { ...signed, amountUnits: 2000n },
    { ...signed, localHash: toHex(1, { size: 32 }) },
    { ...signed, nonce: 9 },
    { ...signed, serializedTransaction: "0x02ff" as const },
  ]) {
    await assert.rejects(fuji.broadcastSignedTransaction(changed), expectCode("INVALID_SIGNED_TRANSACTION"));
  }
  const serializedTransaction = await account.signTransaction({
    chainId: 43114, type: "eip1559", to: fuji.FUJI_USDC_ADDRESS, value: 0n, nonce: 7,
    gas: 60_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [destination, 1000n] }),
  });
  await assert.rejects(fuji.broadcastSignedTransaction({
    ...signed, serializedTransaction, localHash: keccak256(serializedTransaction),
  }), expectCode("INVALID_SIGNED_TRANSACTION"));
  noBroadcast();
});

test("broadcast errors and mismatched network hashes never trigger another send", async () => {
  const signed = await fuji.prepareAndSignUsdcTransfer(destination, 1000n);
  broadcastMode = "error";
  await assert.rejects(fuji.broadcastSignedTransaction(signed), expectCode("BROADCAST_FAILED"));
  assert.equal(calls.filter((call) => call.method === "eth_sendRawTransaction").length, 1);
  calls.length = 0;
  broadcastMode = "mismatch";
  await assert.rejects(fuji.broadcastSignedTransaction(signed), expectCode("HASH_MISMATCH"));
  assert.equal(calls.filter((call) => call.method === "eth_sendRawTransaction").length, 1);
});

test("persisted smoke CLI integrates real Task 1 signing, Postgres, and mock RPC without duplicate sends", async (t) => {
  const db = await startTestPostgres();
  t.after(() => db.close());
  const env = { SUPABASE_DB_URL: db.connectionString, FUJI_SETTLEMENT_TRANSFER_ID: "cli-transfer-1" };
  const result = await cli("Blockchain/scripts/fuji-smoke.ts", env);
  assert.equal(result.code, 0, result.output);
  assert.ok(result.output.includes('"status": "BROADCAST_SUBMITTED"'));
  assert.ok(result.output.includes('"tokenAddress":'));
  assert.ok(!result.output.includes(testKey));
  const broadcasts = calls.filter((call) => call.method === "eth_sendRawTransaction");
  assert.equal(broadcasts.length, 1);
  assert.ok(!result.output.includes(broadcasts[0].params[0] as string));
  assert.ok(!calls.some((call) => call.method === "eth_getTransactionReceipt"));
  const duplicate = await cli("Blockchain/scripts/fuji-smoke.ts", env);
  assert.equal(duplicate.code, 0, duplicate.output);
  assert.equal(calls.filter((call) => call.method === "eth_sendRawTransaction").length, 1);
  const another = await cli("Blockchain/scripts/settlement-smoke.ts", {
    ...env, FUJI_SETTLEMENT_TRANSFER_ID: "cli-transfer-2",
  });
  assert.equal(another.code, 0, another.output);
  const persisted = await db.admin.query("SELECT nonce, signed_transaction FROM blockchain_private.settlement_attempts ORDER BY nonce");
  assert.deepEqual(persisted.rows.map((r) => r.nonce), ["7", "8"]);
  const sends = calls.filter((call) => call.method === "eth_sendRawTransaction");
  assert.equal(sends.length, 2); // One each for two distinct explicit CLI requests.
  assert.equal(persisted.rows[0].signed_transaction, sends[0].params[0]);
  assert.equal(persisted.rows[1].signed_transaction, sends[1].params[0]);
});

test("CLI missing configuration and invalid token/RPC errors are actionable and sanitized", async () => {
  const missing = await cli("Blockchain/scripts/fuji-health.ts", { FUJI_SIGNER_PRIVATE_KEY: "" });
  assert.equal(missing.code, 1);
  assert.ok(missing.output.includes("FUJI_SIGNER_PRIVATE_KEY is missing"));
  const wrongToken = await cli("Blockchain/scripts/fuji-health.ts", { FUJI_USDC_ADDRESS: destination });
  assert.equal(wrongToken.code, 1);
  assert.ok(wrongToken.output.includes("official Circle Test USDC"));
  const badRpc = await cli("Blockchain/scripts/fuji-health.ts", { AVALANCHE_FUJI_RPC_URL: "file:///unsafe-rpc-detail" });
  assert.equal(badRpc.code, 1);
  assert.ok(badRpc.output.includes("HTTP(S)"));
  assert.ok(!badRpc.output.includes("unsafe-rpc-detail"));
  noBroadcast();
});

test("network-only CLI works without signer or destination", async () => {
  const result = await cli("Blockchain/scripts/fuji-health.ts", {
    FUJI_SIGNER_PRIVATE_KEY: "", FUJI_DESTINATION_ADDRESS: "",
  }, ["--network-only"]);
  assert.equal(result.code, 0, result.output);
  assert.equal(JSON.parse(result.output).chainId, 43113);
  noBroadcast();
});
