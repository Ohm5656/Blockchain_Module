-- Task 4 only. Minimal on-demand recovery metadata and one-shot action claims.
BEGIN;
SET LOCAL synchronous_commit = on;

ALTER TABLE blockchain_private.settlement_attempts
  ADD COLUMN recovery_attempt_count integer NOT NULL DEFAULT 0 CHECK (recovery_attempt_count >= 0),
  ADD COLUMN last_recovery_at timestamptz,
  ADD COLUMN last_recovery_code text CHECK (
    last_recovery_code IN (
      'INSPECTING', 'PREPARING_SIGN_CLAIMED', 'PREPARING_SIGNED',
      'SIGNED_BROADCAST_CLAIMED', 'SIGNED_BROADCAST_SUBMITTED',
      'BROADCAST_TRANSACTION_FOUND', 'EXACT_REBROADCAST_CLAIMED',
      'EXACT_REBROADCAST_SUBMITTED', 'NONCE_CONFLICT',
      'TRANSACTION_MISMATCH', 'TRANSACTION_PENDING', 'VERIFICATION_PENDING',
      'RPC_UNCERTAIN', 'RECOVERY_ACTION_ALREADY_CLAIMED',
      'SIGNING_FAILED', 'INVALID_SIGNED_TRANSACTION', 'TERMINAL', 'NO_ACTION'
    )
  ),
  ADD COLUMN last_recovery_reason text CHECK (
    last_recovery_reason IS NULL OR length(last_recovery_reason) BETWEEN 1 AND 256
  ),
  ADD COLUMN recovery_sign_claimed_at timestamptz,
  ADD COLUMN recovery_rebroadcast_claimed_at timestamptz,
  ADD CONSTRAINT settlement_attempts_recovery_metadata_check CHECK (
    (recovery_attempt_count = 0 AND last_recovery_at IS NULL AND last_recovery_code IS NULL AND last_recovery_reason IS NULL)
    OR
    (recovery_attempt_count > 0 AND last_recovery_at IS NOT NULL AND last_recovery_code IS NOT NULL AND last_recovery_reason IS NOT NULL)
  );

CREATE INDEX settlement_attempts_last_recovery_idx
  ON blockchain_private.settlement_attempts (last_recovery_at)
  WHERE last_recovery_at IS NOT NULL;

CREATE OR REPLACE FUNCTION blockchain_private.guard_attempt() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Settlement attempts cannot be deleted';
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.attempt_state <> 'PREPARING' THEN
      RAISE EXCEPTION 'New attempts must start in PREPARING';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(NEW.id, NEW.settlement_id, NEW.attempt_number, NEW.chain_id, NEW.signer_address, NEW.destination_address, NEW.token_address, NEW.amount_units, NEW.nonce, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.settlement_id, OLD.attempt_number, OLD.chain_id, OLD.signer_address, OLD.destination_address, OLD.token_address, OLD.amount_units, OLD.nonce, OLD.created_at) THEN
    RAISE EXCEPTION 'Attempt identity, intent and nonce are immutable';
  END IF;

  IF NOT (
    NEW.attempt_state = OLD.attempt_state
    OR (OLD.attempt_state = 'PREPARING' AND NEW.attempt_state = 'SIGNED')
    OR (OLD.attempt_state = 'SIGNED' AND NEW.attempt_state = 'BROADCAST_REQUESTED')
    OR (OLD.attempt_state = 'BROADCAST_REQUESTED' AND NEW.attempt_state = 'BROADCAST_SUBMITTED')
    OR (OLD.attempt_state = 'BROADCAST_SUBMITTED' AND NEW.attempt_state IN ('CONFIRMED', 'REVERTED', 'VERIFICATION_FAILED'))
  ) THEN
    RAISE EXCEPTION 'Invalid settlement attempt state transition';
  END IF;

  IF OLD.attempt_state <> 'PREPARING' AND
    ROW(NEW.signed_transaction, NEW.local_tx_hash, NEW.signed_at)
      IS DISTINCT FROM ROW(OLD.signed_transaction, OLD.local_tx_hash, OLD.signed_at) THEN
    RAISE EXCEPTION 'Signed transaction is immutable';
  END IF;
  IF OLD.broadcast_requested_at IS NOT NULL AND NEW.broadcast_requested_at IS DISTINCT FROM OLD.broadcast_requested_at THEN
    RAISE EXCEPTION 'Broadcast claim is immutable';
  END IF;
  IF OLD.broadcast_submitted_at IS NOT NULL AND
    ROW(NEW.broadcast_submitted_at, NEW.network_tx_hash)
      IS DISTINCT FROM ROW(OLD.broadcast_submitted_at, OLD.network_tx_hash) THEN
    RAISE EXCEPTION 'Broadcast evidence is immutable';
  END IF;
  IF OLD.verified_at IS NOT NULL AND
    ROW(NEW.verified_at, NEW.receipt_block_number, NEW.receipt_block_hash, NEW.receipt_status,
        NEW.verified_transfer_log_index, NEW.confirmed_at, NEW.verification_failure_code, NEW.verification_failure_reason)
      IS DISTINCT FROM
    ROW(OLD.verified_at, OLD.receipt_block_number, OLD.receipt_block_hash, OLD.receipt_status,
        OLD.verified_transfer_log_index, OLD.confirmed_at, OLD.verification_failure_code, OLD.verification_failure_reason) THEN
    RAISE EXCEPTION 'Verification evidence is immutable';
  END IF;

  IF NEW.recovery_attempt_count < OLD.recovery_attempt_count THEN
    RAISE EXCEPTION 'Recovery attempt count cannot decrease';
  END IF;
  IF OLD.recovery_sign_claimed_at IS NOT NULL
    AND NEW.recovery_sign_claimed_at IS DISTINCT FROM OLD.recovery_sign_claimed_at THEN
    RAISE EXCEPTION 'Recovery signing claim is immutable';
  END IF;
  IF OLD.recovery_sign_claimed_at IS NULL AND NEW.recovery_sign_claimed_at IS NOT NULL
    AND OLD.attempt_state <> 'PREPARING' THEN
    RAISE EXCEPTION 'Recovery signing may be claimed only from PREPARING';
  END IF;
  IF OLD.recovery_rebroadcast_claimed_at IS NOT NULL
    AND NEW.recovery_rebroadcast_claimed_at IS DISTINCT FROM OLD.recovery_rebroadcast_claimed_at THEN
    RAISE EXCEPTION 'Recovery rebroadcast claim is immutable';
  END IF;
  IF OLD.recovery_rebroadcast_claimed_at IS NULL AND NEW.recovery_rebroadcast_claimed_at IS NOT NULL
    AND OLD.attempt_state NOT IN ('SIGNED', 'BROADCAST_REQUESTED') THEN
    RAISE EXCEPTION 'Recovery broadcast may be claimed only from SIGNED or BROADCAST_REQUESTED';
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;

COMMIT;
