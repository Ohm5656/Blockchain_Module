# Avalanche Fuji Settlement Module

โมดูล settlement ฝั่ง backend สำหรับส่งและตรวจสอบ **Circle Test USDC บน Avalanche Fuji C-Chain** โดยออกแบบให้ทนต่อ process crash, RPC timeout, request ซ้ำ และ concurrent workers โดยไม่สร้างธุรกรรมซ้ำหรือเปลี่ยนจำนวนเงินเอง

> TESTNET ONLY — repository นี้ไม่รองรับ Avalanche mainnet, real USDC หรือเงินจริง

## Tech Stack

| Layer | Technology | Responsibility |
| --- | --- | --- |
| Runtime | Node.js 22 | Server-side execution and secret isolation |
| Language | TypeScript (strict mode) | Exact types for state, units, evidence, and recovery results |
| EVM client | viem | Fuji RPC, local signing, calldata encoding/decoding, receipt and event parsing |
| Blockchain | Avalanche Fuji C-Chain (`43113`) | EVM-compatible testnet settlement network |
| Token | Circle Test USDC | Existing ERC-20 contract used as the test settlement asset |
| Persistence | PostgreSQL / Supabase-compatible Postgres | Durable intent, nonce, signed bytes, hash, state, and verification evidence |
| Database tests | embedded-postgres | Isolated PostgreSQL integration and concurrency tests |
| Test runner | Node test runner through `tsx` | Unit, persistence, recovery, verification, and runner tests |

Public network configuration:

- Chain: Avalanche Fuji C-Chain
- Chain ID: `43113`
- Circle Test USDC: `0x5425890298aed601595a70AB815c96711a31Bc65`
- Token decimals: `6`
- Default RPC: `https://api.avax-test.network/ext/bc/C/rpc`

## What This Module Does

The module separates blockchain settlement into five responsibilities:

1. **Fuji transaction module** — validates network/token/wallet readiness, simulates an ERC-20 transfer, signs locally, and broadcasts exact serialized bytes.
2. **Persisted signing** — stores immutable intent, reserves a nonce, and commits signed bytes plus transaction hash before any broadcast.
3. **Receipt verification** — verifies transaction metadata, successful receipt, and the exact ERC-20 `Transfer` event.
4. **Recovery and reconciliation** — resumes the same logical settlement from durable state after a crash, timeout, or uncertain RPC response.
5. **Durable runner** — selects a bounded batch of non-terminal settlements and delegates each item to the recovery service.

This is a hybrid architecture. Business orchestration and database state remain off-chain; only the Test USDC settlement leg is on-chain. The project does not deploy a custom smart contract—it calls Circle's existing Test USDC contract.

## Core Blockchain Safety Principles

### 1. Testnet and contract pinning

Every blockchain operation verifies Fuji chain ID `43113`. The token address is allowlisted to Circle Test USDC, and token bytecode, symbol, and decimals are checked before signing.

### 2. The amount is an integer, not floating point

Token values use `bigint` base units end-to-end. For a six-decimal token:

```text
9.8 Test USDC = 9,800,000 base units
```

The settlement layer does not calculate FX, fees, or fiat amounts. It receives an authoritative integer amount from its caller.

### 3. Persist before broadcast

The critical invariant is:

```text
validate intent
    -> reserve nonce
    -> sign locally
    -> compute tx hash
    -> persist nonce + signed bytes + tx hash
    -> COMMIT PostgreSQL transaction
    -> broadcast those exact persisted bytes
```

A transaction is never intentionally broadcast without a durable recovery record. A database write or commit failure stops the flow before RPC submission.

### 4. Idempotency and immutable intent

The logical transfer ID, chain, token, signer, destination, amount, nonce, signed bytes, and hash become immutable. Repeating the same request returns the same attempt. Conflicting retries are rejected instead of creating another payment.

Database constraints protect transfer identity and `(chain_id, signer, nonce)` uniqueness. Concurrent workers cannot allocate the same signer nonce to separate settlements.

### 5. Exact-byte recovery

Recovery never creates a replacement transaction merely because a response was lost. It reuses:

- the same logical transfer ID;
- the same reserved nonce;
- the same serialized signed transaction;
- the same locally computed transaction hash.

For an uncertain broadcast, recovery first looks up the local hash and inspects the signer nonce. It may perform one exact-byte rebroadcast only when state proves that action is safe. There is no gas bump, nonce replacement, or blind resend.

### 6. Verification requires exact evidence

`CONFIRMED` requires all of the following:

- RPC is connected to Fuji;
- network transaction hash equals the persisted local hash;
- chain ID, sender, nonce, and token contract match;
- calldata decodes to `transfer(destination, units)` with exact values;
- receipt belongs to the same transaction and reports success;
- exactly one matching Test USDC `Transfer(from, to, value)` event exists;
- sender, destination, and base units match the immutable database intent.

A missing transaction or receipt remains pending. A reverted receipt becomes `REVERTED`. Contradictory on-chain evidence becomes `VERIFICATION_FAILED`; the module does not guess.

### 7. Bounded execution

Recovery and runner operations execute one bounded state branch per invocation. There is no in-process infinite polling loop or memory-only work queue. An external scheduler can invoke the runner again after the configured cooldown.

### 8. Server-only secrets

The private key and database credentials remain server-side. Public DTOs omit both private keys and serialized signed transaction bytes. Raw provider/database errors are converted into safe error categories.

## Architecture

```text
Backend / Scheduler
        |
        v
Durable Runner (bounded batch)
        |
        v
Recovery Service
        |
        +-----------------------------+
        |                             |
        v                             v
Persistence Service              Verification Service
        |                             |
        v                             v
PostgreSQL                      Avalanche Fuji RPC
  - immutable intent              - transaction
  - reserved nonce                - receipt
  - signed bytes                  - block evidence
  - tx hash                       - ERC-20 logs
  - state/evidence                     |
        |                               v
        +----> exact-byte broadcast -> Circle Test USDC
```

## Settlement State Machine

```text
PREPARING
   |
   | reserve nonce + sign + persist
   v
SIGNED
   |
   | durable broadcast claim
   v
BROADCAST_REQUESTED
   |
   | network accepts the same local hash
   v
BROADCAST_SUBMITTED
   |
   +----> CONFIRMED
   |
   +----> REVERTED
   |
   +----> VERIFICATION_FAILED
```

State meaning:

| State | Meaning |
| --- | --- |
| `PREPARING` | Immutable intent and nonce reservation exist; signing may need recovery |
| `SIGNED` | Exact signed bytes and local hash are durable; nothing has been submitted yet |
| `BROADCAST_REQUESTED` | Submission outcome is uncertain; reconciliation must inspect hash/nonce first |
| `BROADCAST_SUBMITTED` | Network returned the same hash as the persisted local hash; receipt verification remains |
| `CONFIRMED` | Successful receipt and exact Test USDC event are persisted |
| `REVERTED` | A mined receipt definitively reports execution failure |
| `VERIFICATION_FAILED` | Found on-chain evidence conflicts with immutable expected values |

## Project Structure

```text
Blockchain/
  fuji/          Fuji config, clients, ERC-20 ABI, health, signing and broadcast
  persistence/   PostgreSQL repository, nonce allocation and persisted settlement service
  verification/  Transaction/receipt/event verification and canonical evidence
  recovery/      State-based crash and uncertain-broadcast reconciliation
  runner/        Bounded eligible-settlement selection and recovery orchestration
  scripts/       Health, smoke, verify, recover and one-shot worker CLIs
  tests/         Unit, PostgreSQL, concurrency, recovery and verification tests

supabase/migrations/
  Standalone-module schema, privileges, constraints and immutable-state triggers

docs/
  Detailed persisted-signing, verification, recovery and runner design notes
```

The SQL migrations in this repository belong to this standalone module. They are **not** the source of truth for the integrated team backend and must not be applied automatically to another application's database.

## Installation

Requirements:

- Node.js `>=22.9.0`
- npm

```sh
npm ci
npm run typecheck
npm test
```

Current verified result:

```text
TypeScript typecheck: PASS
Automated tests:      121/121 PASS
Live transactions in automated tests: 0
```

The test suite uses mocked RPC behavior and isolated embedded PostgreSQL databases. It covers concurrency, commit failures, idempotency, nonce allocation, lost responses, exact-byte recovery, terminal-state immutability, and receipt/event mismatch cases.

## Environment Variables

Copy `.env.example` to `.env.local`. The local file is ignored by Git.

| Variable | Purpose |
| --- | --- |
| `AVALANCHE_FUJI_RPC_URL` | Fuji JSON-RPC endpoint |
| `FUJI_USDC_ADDRESS` | Circle Test USDC allowlist; defaults to the official Fuji address |
| `FUJI_SIGNER_PRIVATE_KEY` | Dedicated testnet-only server signer |
| `FUJI_DESTINATION_ADDRESS` | Testnet destination wallet |
| `FUJI_SMOKE_TEST_USDC_UNITS` | Positive integer base units for an explicitly authorized smoke test |
| `SUPABASE_DB_URL` | Server-only PostgreSQL connection |
| `SUPABASE_DB_CA_CERT` | Optional custom CA while retaining TLS verification |
| `FUJI_SETTLEMENT_TRANSFER_ID` | Stable ID of the logical settlement being verified or recovered |
| `FUJI_RUNNER_BATCH_SIZE` | Bounded runner batch size, maximum 50 |
| `FUJI_RUNNER_COOLDOWN_MS` | Minimum time before reconsidering a non-terminal settlement |

Never commit `.env.local`, a private key, a database password, a recovery phrase, a session token, or serialized signed transaction bytes.

## Commands

Safe, non-broadcast commands:

```sh
npm run typecheck
npm test
npm run test:persistence
npm run test:verification
npm run test:recovery
npm run test:runner

# Read chain and token metadata only
npm run fuji:health -- --network-only

# Verify an existing persisted transaction; does not sign or broadcast
npm run settlement:verify
```

State-changing commands—run only with explicit Testnet authorization:

```sh
# May sign and send one Test USDC transaction
npm run settlement:smoke

# Reconciles one existing logical settlement from durable state
npm run settlement:recover -- existing-transfer-id

# Processes one bounded batch and exits
npm run settlement:worker
```

Never run a smoke command automatically during install, CI, deployment, or application startup.

## Live Fuji Proof

The integrated backend completed one controlled end-to-end Testnet settlement:

- Network: Avalanche Fuji C-Chain
- Chain ID: `43113`
- Amount: `9.8 Test USDC` (`9800000` base units)
- From: `0xF7c909887933D6717972ab70Ef83f9F4198447a6`
- To: `0x740f00EF9410E7631B2c22CAa750F5EA62273D20`
- Transaction: `0xc021d58f73fb6890c75a3b923d2777011bd7c1f77c81832154088327598c0bdc`
- Block: `59523076`
- Explorer: https://testnet.snowtrace.io/tx/0xc021d58f73fb6890c75a3b923d2777011bd7c1f77c81832154088327598c0bdc
- Final attempt phase: `CONFIRMED`
- Relevant attempts: exactly one
- Duplicate nonce/hash: none

Team-backend integration and review: [U-hackathon_backend PR #5](https://github.com/4rtem1sss/U-hackathon_backend/pull/5)

## Security Boundaries

- Avalanche Fuji testnet only
- No mainnet assets
- No custom smart contract
- No browser-side signing
- Private key never enters PostgreSQL
- Signed transaction bytes never enter public DTOs
- Verification does not require the signer key
- Receiver wallet does not need AVAX merely to receive Test USDC
- Database/runtime errors are sanitized before reaching callers
- Recovery never reconstructs or replaces an uncertain transaction

## Scope and Limitations

- This repository implements the blockchain settlement leg, not a complete remittance product.
- Fiat funding and THB payout remain outside this module.
- The standalone migrations are module-specific and are not interchangeable with the team backend schema.
- Production deployment still requires managed secrets, RPC reliability planning, monitoring, and operational review.
- The frontend should consume backend-provided transaction hash, explorer URL, and verification time; it does not need the private key or a wallet connection for the server-signed architecture.
