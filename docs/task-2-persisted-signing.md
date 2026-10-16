# Task 2: persisted signing (server-only)

## Entry point and invariant

Use `createPersistedSettlementService(pool)` from `Blockchain/persistence/index.ts`.
It returns `preparePersistedSettlement(request)` and `executePersistedSettlement(request)`.
Both accept `{ transferId, destination, amountUnits: bigint }` and return only `SettlementDto`.
The service never broadcasts until signed bytes and the broadcast claim have committed.

Task 1 remains the low-level Fuji adapter. Its existing two-argument preparation API still works;
Task 2 adds an optional third argument `{ nonce }` for the durably allocated nonce. Backend settlement
code must call the persisted service, not the low-level sign/broadcast functions.
Both `npm run fuji:smoke` (existing alias) and `npm run settlement:smoke` use persistence.

## Database setup and migration order

This repository previously had no database infrastructure. It now uses `pg` directly against
Supabase Postgres, with one connection per transaction. There are no browser APIs or Supabase
service-role API keys. Direct, session-pooler and transaction-pooler connections work with this
design: transactions use one checked-out connection, row locks are transaction-scoped, and queries
do not use named prepared statements. See [Supabase connection guidance](https://supabase.com/docs/guides/database/connecting-to-postgres)
and [node-postgres transactions](https://node-postgres.com/features/transactions).

1. Select a **test project/database** and an administrator/migration-owner connection.
2. Apply `supabase/migrations/202610160001_persisted_signing.sql` **once**, before starting the service,
   then apply the Task 3 and Task 4 forward-only migrations in filename order. The first migration
   creates new objects; later migrations extend them without resetting existing data.
   Run the file in Supabase SQL Editor, or use `psql` with securely configured libpq credentials:
   `psql --set ON_ERROR_STOP=1 --file supabase/migrations/202610160001_persisted_signing.sql`.
   The file includes BEGIN/COMMIT; do not put it inside an application transaction.
   It is deliberately not an idempotent schema reset.
3. Provision a server-only database login through your team's secrets/admin process and grant
   membership in the migration's `fuji_settlement_service` NOLOGIN role:
   `GRANT fuji_settlement_service TO your_backend_login;`.
   Use an inheriting role. The service role can SELECT/INSERT/UPDATE, but cannot DELETE/TRUNCATE.
   Do not grant this role to Supabase `anon`, `authenticated`, browser users, or unrelated services.
4. Set `SUPABASE_DB_URL` in server-side `.env.local` / secret storage using the runtime login.
   Do not use `NEXT_PUBLIC_`. Non-loopback connections always verify TLS certificates; if needed,
   configure `SUPABASE_DB_CA_CERT` with the project's CA certificate in PEM format. SSL URL options
   are removed so they cannot disable verification. Only loopback development DBs use plaintext.
5. Keep `blockchain_private` outside PostgREST's exposed schemas. RLS plus explicit grants restrict
   all three tables to the backend role (database owners/admins remain trusted).
   Do not log bind parameters, signed rows, connection URIs, or query values in APM/analytics/database
   audit integrations. Signed transactions are operationally sensitive even though they contain no key.

The implementation uses `SET LOCAL synchronous_commit = on`. Local tests use a temporary real
Postgres cluster with fsync enabled. No remote migration is applied automatically by the code/tests.
This work did not deploy to Supabase; no Supabase connection was configured.

## Tables and constraints

```text
blockchain_private.settlements
  PK id (UUID)
  UNIQUE transfer_id
          |
          | FK: settlement_id + full immutable intent
          v
blockchain_private.settlement_attempts
  PK id (UUID)
  UNIQUE settlement_id                   one initial attempt
  attempt_number = 1                     no replacement attempts in Task 2
  UNIQUE (chain_id, signer_address, nonce)
  UNIQUE local_tx_hash
          |
          | FK (chain_id, signer_address)
          v
blockchain_private.signer_nonces
  PK (chain_id, signer_address)
  next_nonce
```

Intent: transfer ID, chain, signer, destination, token, amount. Addresses are stored lowercase.
USDC amounts are canonical positive base-10 **strings**, constrained to uint256; they are never
converted to JS Number or rounded by SQL. Nonces are bigint in Postgres, constrained to the
range safely representable by viem's JS number nonce. Dates are timestamptz.

Attempts also store exact signed bytes, local hash, optional matching network hash, state,
attempt number, created/updated/signed/broadcast-requested/broadcast-submitted timestamps.
There is an index on `(attempt_state, created_at)`; PK/UNIQUE constraints provide lookup indexes.

Composite foreign keys bind attempt metadata to the original intent. Triggers enforce immutable
intent/nonce/signed bytes, forward-only states, and a nondecreasing nonce cursor. Initial attempts
must be PREPARING. No table has a private-key, seed-phrase or credential column.

## Exact flow and concurrency

```text
request: stable transferId + destination + integer amount
  |
  v
Transaction 1
  INSERT intent ON CONFLICT (transfer_id) DO NOTHING
  | duplicate -> compare ALL immutable parameters -> return existing DTO
  | first request
  v
  INSERT signer cursor if absent
  SELECT cursor FOR UPDATE (chain + signer)
  read and validate Fuji pending nonce while holding row lock
  nonce = max(database.next_nonce, rpc.pending_nonce)
  advance database.next_nonce = nonce + 1
  INSERT attempt PREPARING with reserved nonce
  COMMIT
  |
  v
Only the original successful claimant prepares/simulates/signs once
  |
  v
Transaction 2
  verify signed envelope + match immutable intent and reserved nonce
  UPDATE PREPARING -> SIGNED; save exact bytes + local hash
  COMMIT
  |
  v
Transaction 3 (execute only)
  conditional UPDATE SIGNED -> BROADCAST_REQUESTED
  load the persisted signed bytes FROM DATABASE
  COMMIT
  |
  v
Only the successful broadcast claimant sends those exact bytes once
  |
  v
Transaction 4
  UPDATE BROADCAST_REQUESTED -> BROADCAST_SUBMITTED
  store matching network hash + timestamp
  COMMIT
```

Transactions 1 and 3 use database atomic writes/locks, not process-local mutexes.
A duplicate ID racing with its first request waits for the intent insert transaction to finish,
then returns the same attempt. It may return PREPARING while the original claimant is signing;
that is **not** permission to sign again. Conflicting parameters raise IDEMPOTENCY_CONFLICT.
Different transfer IDs sharing a signer serialize nonce allocation under the same row lock.
The DB unique signer/nonce constraint is an additional final boundary.

Use the same database and this service for **all** transactions from the dedicated signer.
External wallet software or another DB cannot participate in these locks. Reservations are never
released or reused in Task 2. An abandoned PREPARING nonce can leave later transactions queued;
do not reset the cursor or create a new transfer ID to bypass it.

## State model and crash boundaries

| State | Meaning | Duplicate execute behavior |
| --- | --- | --- |
| PREPARING | Intent and nonce committed; signed bytes not durably available | Return existing DTO; never sign again |
| SIGNED | Exact signed bytes + hash committed; no send claimed | One caller may claim and broadcast |
| BROADCAST_REQUESTED | Send right committed; send may not have happened, may be pending, or response may be lost | Return existing DTO; never rebroadcast |
| BROADCAST_SUBMITTED | RPC returned the expected hash and that response was saved | Return existing DTO; never rebroadcast |

No state means confirmed, settled, or completed. There is no receipt/event validation.

- **Before signing:** if Transaction 1 failed, no signing can start; if it committed and the process
  stops, the attempt remains PREPARING. A failed/uncertain COMMIT never grants signing permission.
- **After signing, before persistence:** the durable PREPARING reservation prevents another signature.
  No broadcast occurs. Signed bytes may be unavailable after process loss.
- **After persistence, before broadcast:** SIGNED may be loaded by an explicit execute call without
  signing again. Once BROADCAST_REQUESTED commits, no other caller sends, even if the owner crashes
  before making the RPC call.
- **During broadcast:** preserve BROADCAST_REQUESTED. A timeout, wrong chain on the broadcast check,
  mismatched hash, or post-send DB failure does not prove the transfer failed. No retry/replacement.
- DB errors are sanitized to PERSISTENCE_FAILED; signing/RPC errors use existing safe Fuji errors.
  PREPARING and BROADCAST_REQUESTED are handled by the explicit Task 4 reconciliation operation.

## Backend example

```ts
import { createSettlementPool, createPersistedSettlementService } from "./Blockchain/persistence/index.js";
import { getFujiDestinationAddress } from "./Blockchain/fuji/index.js";

const pool = createSettlementPool(); // reuse one pool for the Node backend lifecycle
const service = createPersistedSettlementService(pool);

const request = {
  transferId: "your-application-transfer-id", // stable identity, not a per-request random ID
  destination: getFujiDestinationAddress(),
  amountUnits: 1000n,
};

const prepared = await service.preparePersistedSettlement(request); // safe DTO; no broadcast
const result = await service.executePersistedSettlement(request); // reuses the signed attempt
// Do not interpret BROADCAST_SUBMITTED as receipt confirmation.
```

Close the pool on backend shutdown. No HTTP endpoint is created. Return values have an explicit safe
allowlist: settlement/attempt/transfer IDs, addresses, chain, decimal amount, nonce, hashes and status.
Signed bytes remain inside the repository/service/adapter path and never enter DTOs or CLI output.
Only trusted server code should use the internal repository; it is not exported by the public barrel.

## Explicit smoke and automated tests

Set wallet config, `SUPABASE_DB_URL`, `FUJI_SETTLEMENT_TRANSFER_ID`, and optional
`FUJI_SMOKE_TEST_USDC_UNITS` (default 1000), then manually run:

```sh
npm run settlement:smoke
# Existing command routes through the same persisted flow:
npm run fuji:smoke
```

One invocation sends at most one Test USDC transaction. Repeat the SAME transfer ID for the SAME
logical intent. A different ID represents a different payment. Missing configuration stops clearly;
no addresses or keys are invented. Normal automated tests never run this against live Fuji.

```sh
npm run typecheck
npm run test:persistence
npm test
```

Tests start a new local native Postgres via the dev-only `embedded-postgres` package, apply the
actual migration, connect using restricted runtime roles with separate pools, and clean up the
temporary cluster afterwards. Docker/Supabase credentials are not required. On Linux, run tests
as a non-root user; the harness never creates host OS users. The package needs its normal install
scripts and a supported native platform.

Coverage includes duplicate/concurrent claims, concurrent nonce allocation, immutable constraints,
SQL and deferred-COMMIT failures, exact persisted-byte broadcast, no repeat after uncertain send,
uint256 preservation, role isolation, safe DTOs and absence of persisted private keys.
The Task 1 integration test additionally runs the real CLI/default adapter against localhost RPC
and local Postgres, including repeating an ID and allocating a second distinct nonce.

Task 3 attaches receipt/Transfer verification using the persisted hash and expected metadata.
Task 4 adds explicit on-demand recovery for these durable stop states without replacement transactions.
Task 5 adds a bounded runner around Task 4; it does not change persisted signing or create a separate transaction path.
