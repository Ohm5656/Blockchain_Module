# Task 4 — Recovery and Reconciliation

Task 4 provides one explicit, bounded, server-side operation for resuming or reconciling an existing logical settlement:

```ts
const recovery = createRecoveryService(pool);
const result = await recovery.reconcilePersistedSettlement(transferId);
```

The caller supplies only `transferId`. Chain, signer, destination, token, amount, nonce, hashes, and signed bytes are loaded from the durable Task 2 record. The operation never creates another settlement, allocates another nonce, creates a replacement transaction, or changes transaction fields.

## Safety model

```text
durable database attempt
  -> inspect current state
  -> inspect Fuji chain / hash / nonce when required
  -> atomically claim at most one permitted action
  -> reuse reserved nonce or exact persisted bytes
  -> persist canonical state
  -> delegate submitted transactions to Task 3
```

One invocation follows one state branch. There is no polling loop, retry loop, gas bump, cancel, or replacement transaction. Task 5 is a separate bounded runner that only calls this operation.

## State behavior

### PREPARING

Task 2 guarantees that a PREPARING attempt could not have been broadcast because signed bytes were never durably stored. Recovery verifies Fuji chain identity, the configured signer/token identity, and both latest and pending signer nonces.

If neither Fuji nonce has advanced beyond the reserved nonce, recovery atomically claims one signing action, signs the same intent with the same nonce, validates the envelope, and persists the bytes before returning `SIGNED`. It does not broadcast in that invocation.

If latest or pending nonce is greater than the reservation, recovery records `NONCE_CONFLICT` and refuses to sign. A committed signing claim is one-shot; a crash after the claim requires investigation instead of blind re-signing.

### SIGNED

Recovery uses Task 2's atomic `SIGNED -> BROADCAST_REQUESTED` claim and loads signed bytes from Postgres. It broadcasts those exact bytes once, requires the returned hash to equal the persisted local hash, and then records `BROADCAST_SUBMITTED`.

The recovery outbound-send claim commits with the state transition. A concurrent process therefore cannot interpret the in-flight send as permission for another exact-byte rebroadcast.

### BROADCAST_REQUESTED

Recovery first queries Fuji using the persisted local hash:

- If the expected transaction exists and its Task 3 transaction checks pass, the same hash is recorded as the network hash without rebroadcast.
- If lookup is uncertain, recovery returns `RPC_UNCERTAIN` without signing or sending.
- If the transaction is definitively not found, recovery reads latest and pending nonce state.
- If the nonce has advanced, it records `NONCE_CONFLICT` and sends nothing.
- If the nonce remains safe, one atomic exact-byte rebroadcast claim may send the persisted bytes once.

Exact-byte rebroadcast preserves the nonce, signature, calldata, fees, amount, destination, and local hash. A mismatch or uncertain response consumes the one-shot claim and cannot trigger another automatic send.

### BROADCAST_SUBMITTED

Recovery delegates directly to `verifyPersistedSettlement()` from Task 3. Pending transaction/receipt evidence leaves the attempt safely `BROADCAST_SUBMITTED`; exact receipt/event evidence may transition it to `CONFIRMED`, `REVERTED`, or `VERIFICATION_FAILED`.

### Terminal states

`CONFIRMED`, `REVERTED`, and `VERIFICATION_FAILED` return canonical persisted evidence without chain reads, signing, broadcasting, or replacement.

## Migration and evidence

Apply migrations in filename order. Task 4 adds:

`supabase/migrations/202610160003_recovery_reconciliation.sql`

New attempt metadata:

- `recovery_attempt_count`
- `last_recovery_at`
- `last_recovery_code`
- `last_recovery_reason`
- `recovery_sign_claimed_at`
- `recovery_rebroadcast_claimed_at`

The two claim timestamps are immutable one-shot compare-and-set boundaries. The updated guard still protects settlement intent, nonce, signed bytes, broadcast evidence, and Task 3 verification evidence. No private key or raw RPC response is stored.

## Outcomes

- `RECOVERED`: safe forward progress occurred.
- `NO_ACTION`: another invocation already progressed or claimed the action.
- `PENDING`: Task 3 evidence is not available yet.
- `RPC_UNCERTAIN`: reliable chain evidence was unavailable; no new payment was created.
- `NONCE_CONFLICT`: the reserved nonce appears consumed or occupied.
- `RECOVERY_CONFLICT`: configured/persisted/on-chain integrity evidence does not agree.
- `TERMINAL`: the current attempt is confirmed, reverted, or verification-failed.

The safe DTO contains public settlement fields, state, public hash, recovery outcome, and verification block evidence. Exact signed bytes, private keys, and database credentials are never returned.

## Manual command

After all three migrations are applied and `SUPABASE_DB_URL` is configured, reconcile one existing test settlement explicitly:

```sh
npm run settlement:recover -- existing-transfer-id
```

Alternatively set `FUJI_SETTLEMENT_TRANSFER_ID`. Depending on persisted state, PREPARING recovery needs the dedicated test-only signer key. Other branches can reconcile existing signed/hash evidence without creating a new signature.

The command performs one bounded invocation and never creates an unrelated payment. Automated tests do not spend real assets.

## Tests

```sh
npm run test:recovery
npm test
npm run typecheck
```

Tests use temporary Postgres and mocked Fuji RPC. They cover all states, lost responses, exact-byte rebroadcast, nonce conflicts, process restart, concurrency, DB failures, immutable data, safe DTOs, exact bigint values, wrong chain, and bounded work.
