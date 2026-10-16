# Task 5 — Durable Reconciliation Runner

Task 5 adds a small server-side orchestrator that discovers persisted, non-terminal settlements and invokes the existing Task 4 operation:

```ts
const runner = createDurableReconciliationRunner(pool);
const summary = await runner.runOnce();
```

The runner contains no blockchain settlement algorithm. It does not sign, allocate nonces, construct transactions, broadcast, decode receipts, or verify Transfer events. Those responsibilities remain in Tasks 1–4.

## Architecture

```text
Scheduler or explicit command
  -> one runOnce() invocation
  -> bounded Postgres eligibility query
  -> reconcilePersistedSettlement(transferId)
  -> Tasks 1–4 durable state machine
  -> safe aggregate summary
  -> process exits
```

No browser session is required. Postgres remains the work source and Task 4 remains the only recovery decision-maker.

## Eligibility and ordering

The query selects only:

- `PREPARING`
- `SIGNED`
- `BROADCAST_REQUESTED`
- `BROADCAST_SUBMITTED`

It excludes `CONFIRMED`, `REVERTED`, and `VERIFICATION_FAILED`.

Eligibility additionally requires `last_recovery_at` to be absent or older than the configured cooldown. Results are deterministic: records never inspected by recovery come first, then oldest recovery timestamp, creation timestamp, and attempt ID. SQL `LIMIT` enforces the batch boundary.

Task 4's existing columns are sufficient, so Task 5 adds no migration or worker-lease table.

## Bounded execution and failures

Defaults:

- Batch size: `10`
- Maximum batch size: `50`
- Cooldown: `60000` milliseconds
- Maximum cooldown: `86400000` milliseconds

The runner executes a finite sequential `for` loop over the selected batch and exits. One settlement failure increments `failed` and does not stop later entries. There is no `while` loop, polling timer, daemon, internal scheduler, or automatic retry.

A later scheduler invocation may select an eligible pending record again. This means “reconcile the same logical settlement again,” never “create another payment.”

## Concurrency

Overlapping runner invocations may select the same row. This is payment-safe because each invocation delegates to Task 4, whose database compare-and-set and immutable one-shot claims protect signing, initial broadcast, exact-byte rebroadcast, and terminal verification.

Task 5 intentionally does not add a second locking system. Duplicate inspection is acceptable; duplicate payment creation is not possible through the runner.

## Safe observability

`RunnerResultDto` contains counters only:

- `scanned`
- `processed`
- `recovered`
- `pending`
- `terminal`
- `rpcUncertain`
- `noAction`
- `conflicts`
- `failed`

Raw exceptions, RPC responses, signed bytes, private keys, and credentials are not returned or logged.

## Local or scheduled invocation

Configure server-only variables and run one batch:

```sh
npm run settlement:worker
```

Optional configuration:

```dotenv
FUJI_RUNNER_BATCH_SIZE=10
FUJI_RUNNER_COOLDOWN_MS=60000
```

The command runs one batch and exits. It must execute in a trusted server environment with the same Postgres and testnet secrets as Task 4.

This repository is a Node module and does not contain a Next.js/Vercel HTTP application, so Task 5 does not add a public cron route. A deployment scheduler should invoke the command as a protected one-off job. Examples include a platform scheduled job, Kubernetes CronJob, or CI scheduler with protected environment secrets. Keep scheduling frequency deployment-defined and at least compatible with the configured cooldown.

If the module is later embedded into a serverless application, its protected cron handler should authenticate using that platform's server-side cron mechanism or a non-`NEXT_PUBLIC_` secret, invoke `runOnce()` once, and return only the safe summary. Do not expose an unauthenticated route.

No production schedule or deployment credentials were configured by this implementation.

## Tests

```sh
npm run test:runner
npm test
npm run typecheck
```

The tests use temporary Postgres and verify state selection, terminal exclusion, batch limits, cooldown behavior, Task 4 delegation, isolated failures, restart safety, safe output, absence of blockchain logic, and overlapping invocations with at most one broadcast.
