# Task 3 — Fuji Receipt and ERC-20 Transfer Verification

Task 3 independently proves that a persisted Task 2 settlement produced the exact expected Circle Test USDC movement on Avalanche Fuji. A transaction hash, an existing transaction, or a successful receipt alone is insufficient.

## Boundary

The verifier is server-only and read-only toward Fuji. It can read chain ID, transaction, receipt, and logs. It cannot sign, send, resend, replace, or rebroadcast a transaction. Its only writes append verification state and compact evidence to Postgres.

`CONFIRMED` means the blockchain Test USDC movement is confirmed. It does not mean THB payout, fiat conversion, remittance, or overall payment completion.

Task 4 recovery/reconciliation delegates submitted attempts back to this verifier. Task 5 adds only bounded orchestration around Task 4 and does not alter verification.

## API and source of truth

```ts
const verifier = createVerificationService(pool);
const result = await verifier.verifyPersistedSettlement(transferId);
```

The operation accepts only the stable transfer ID. It loads all expected values from the Task 2 database record:

- chain ID
- signer
- destination
- token contract
- amount in exact base units
- nonce
- local transaction hash
- network transaction hash

The repository query intentionally does not load `signed_transaction`. Callers cannot override expected settlement fields.

## Verification flow

```text
transferId
  -> load persisted BROADCAST_SUBMITTED attempt
  -> require local hash == network hash
  -> read Fuji chain ID
  -> read transaction by persisted hash
  -> verify hash / chain / from / nonce / token target
  -> decode transfer(address,uint256) and verify destination / amount
  -> read receipt
  -> distinguish pending / reverted / success
  -> decode Test USDC Transfer logs
  -> require exactly one matching contract / from / to / value event
  -> atomically append evidence and terminal state
```

Addresses are compared after normalization and token amounts use `bigint`; floating point is never used.

## Result semantics

- `PENDING` with `TRANSACTION_NOT_FOUND`: the transaction is not available yet. The database remains `BROADCAST_SUBMITTED`.
- `PENDING` with `RECEIPT_PENDING`: the receipt is not mined/available yet. The database remains `BROADCAST_SUBMITTED`.
- `CONFIRMED`: all transaction, receipt, and event checks passed.
- `REVERTED`: a mined receipt definitively reports reverted execution.
- `VERIFICATION_FAILED`: available blockchain evidence contradicts persisted intent or fails integrity checks.
- RPC/infrastructure error: throws a sanitized `VERIFICATION_RPC_ERROR` and does not change verification state.

`BROADCAST_REQUESTED` is rejected because it does not prove the transaction exists or provide a reliable submitted hash. Resolving this uncertainty belongs to Task 4.

## Exact checks

Transaction checks:

- RPC chain and transaction chain are Fuji chain ID `43113`
- returned transaction hash equals the persisted network hash
- `from` equals the persisted signer
- `to` equals both persisted token and official Circle Test USDC
- nonce equals the persisted nonce
- calldata decodes strictly as `transfer(address,uint256)`
- decoded destination and amount equal persisted values

Receipt checks:

- receipt hash equals the persisted transaction hash
- block number and block hash exist
- status is distinguished as success or reverted

Transfer event checks:

- exactly one Test USDC `Transfer` log is present
- event contract equals the expected token contract
- `from`, `to`, and `value` match exactly
- log is not removed and belongs to the same transaction and block as the receipt

## Migration

Apply migrations in filename order. Task 3 adds the forward-only migration below; current deployments must then apply the Task 4 migration documented in `task-4-recovery-reconciliation.md`.

`supabase/migrations/202610160002_receipt_verification.sql`

It extends `blockchain_private.settlement_attempts` with:

- `verified_at`
- `receipt_block_number`
- `receipt_block_hash`
- `receipt_status`
- `verified_transfer_log_index`
- `confirmed_at`
- `verification_failure_code`
- `verification_failure_reason`

It adds terminal states `CONFIRMED`, `REVERTED`, and `VERIFICATION_FAILED`, plus evidence/state consistency constraints and a partial verification-state index. The replacement guard trigger permits only a forward transition from `BROADCAST_SUBMITTED` to one terminal verification state and rejects changes to intent, signing, broadcast, or existing verification evidence.

The service persists outcomes with a compare-and-set update (`WHERE state = 'BROADCAST_SUBMITTED'`). Concurrent losers reload and return the one canonical terminal record. Re-verifying a terminal attempt returns persisted evidence without calling Fuji RPC.

## Manual verification

After applying both migrations, configure:

```dotenv
SUPABASE_DB_URL=...
FUJI_SETTLEMENT_TRANSFER_ID=...
```

Then run:

```sh
npm run settlement:verify
```

The command verifies an already persisted transaction. It does not require `FUJI_SIGNER_PRIVATE_KEY` or `FUJI_DESTINATION_ADDRESS`, and it never sends a transfer.

If no safe test-only Fuji transaction and configured database are available, use the automated tests. Do not invent a transaction hash or automatically broadcast one for verification.

## Test coverage

```sh
npm run test:verification
npm test
npm run typecheck
```

Tests use the Task 2 temporary Postgres fixture and a mocked Fuji gateway. They cover success, pending transaction/receipt, revert, every required mismatch, malformed calldata, receipt/log integrity, RPC errors, commit failure, exact `uint256`, idempotency, and concurrent verification. They also assert that no private key, signed bytes, signing, or broadcasting enters the verification path.
