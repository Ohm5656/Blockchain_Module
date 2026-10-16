-- Task 3 only. Forward-only extension of Task 2 persisted attempts.
BEGIN;
SET LOCAL synchronous_commit = on;

ALTER TABLE blockchain_private.settlement_attempts
  ADD COLUMN verified_at timestamptz,
  ADD COLUMN receipt_block_number bigint CHECK (receipt_block_number >= 0),
  ADD COLUMN receipt_block_hash text CHECK (receipt_block_hash ~ '^0x[0-9a-f]{64}$'),
  ADD COLUMN receipt_status text CHECK (receipt_status IN ('success', 'reverted')),
  ADD COLUMN verified_transfer_log_index integer CHECK (verified_transfer_log_index >= 0),
  ADD COLUMN confirmed_at timestamptz,
  ADD COLUMN verification_failure_code text CHECK (
    verification_failure_code IN (
      'TRANSACTION_HASH_MISMATCH', 'TRANSACTION_CHAIN_MISMATCH',
      'SIGNER_MISMATCH', 'NONCE_MISMATCH',
      'TOKEN_MISMATCH', 'CALLDATA_MISMATCH', 'CALLDATA_DESTINATION_MISMATCH',
      'CALLDATA_AMOUNT_MISMATCH', 'RECEIPT_HASH_MISMATCH',
      'RECEIPT_BLOCK_MISSING', 'TRANSACTION_REVERTED',
      'TRANSFER_EVENT_MISSING', 'TRANSFER_EVENT_WRONG_CONTRACT',
      'TRANSFER_EVENT_SENDER_MISMATCH', 'TRANSFER_EVENT_DESTINATION_MISMATCH',
      'TRANSFER_EVENT_AMOUNT_MISMATCH', 'TRANSFER_EVENT_DUPLICATE',
      'TRANSFER_EVENT_INTEGRITY_MISMATCH'
    )
  ),
  ADD COLUMN verification_failure_reason text CHECK (
    verification_failure_reason IS NULL OR length(verification_failure_reason) BETWEEN 1 AND 256
  );

ALTER TABLE blockchain_private.settlement_attempts
  DROP CONSTRAINT settlement_attempts_attempt_state_check,
  DROP CONSTRAINT settlement_attempts_check1;

ALTER TABLE blockchain_private.settlement_attempts
  ADD CONSTRAINT settlement_attempts_attempt_state_check CHECK (
    attempt_state IN (
      'PREPARING', 'SIGNED', 'BROADCAST_REQUESTED', 'BROADCAST_SUBMITTED',
      'CONFIRMED', 'REVERTED', 'VERIFICATION_FAILED'
    )
  ),
  ADD CONSTRAINT settlement_attempts_state_evidence_check CHECK (
    (
      attempt_state = 'PREPARING'
      AND signed_transaction IS NULL AND local_tx_hash IS NULL AND signed_at IS NULL
      AND broadcast_requested_at IS NULL AND broadcast_submitted_at IS NULL AND network_tx_hash IS NULL
      AND verified_at IS NULL AND receipt_block_number IS NULL AND receipt_block_hash IS NULL
      AND receipt_status IS NULL AND verified_transfer_log_index IS NULL AND confirmed_at IS NULL
      AND verification_failure_code IS NULL AND verification_failure_reason IS NULL
    ) OR (
      attempt_state = 'SIGNED'
      AND signed_transaction IS NOT NULL AND local_tx_hash IS NOT NULL AND signed_at IS NOT NULL
      AND broadcast_requested_at IS NULL AND broadcast_submitted_at IS NULL AND network_tx_hash IS NULL
      AND verified_at IS NULL AND receipt_block_number IS NULL AND receipt_block_hash IS NULL
      AND receipt_status IS NULL AND verified_transfer_log_index IS NULL AND confirmed_at IS NULL
      AND verification_failure_code IS NULL AND verification_failure_reason IS NULL
    ) OR (
      attempt_state = 'BROADCAST_REQUESTED'
      AND signed_transaction IS NOT NULL AND local_tx_hash IS NOT NULL AND signed_at IS NOT NULL
      AND broadcast_requested_at IS NOT NULL AND broadcast_submitted_at IS NULL AND network_tx_hash IS NULL
      AND verified_at IS NULL AND receipt_block_number IS NULL AND receipt_block_hash IS NULL
      AND receipt_status IS NULL AND verified_transfer_log_index IS NULL AND confirmed_at IS NULL
      AND verification_failure_code IS NULL AND verification_failure_reason IS NULL
    ) OR (
      attempt_state = 'BROADCAST_SUBMITTED'
      AND signed_transaction IS NOT NULL AND local_tx_hash IS NOT NULL AND signed_at IS NOT NULL
      AND broadcast_requested_at IS NOT NULL AND broadcast_submitted_at IS NOT NULL AND network_tx_hash IS NOT NULL
      AND verified_at IS NULL AND receipt_block_number IS NULL AND receipt_block_hash IS NULL
      AND receipt_status IS NULL AND verified_transfer_log_index IS NULL AND confirmed_at IS NULL
      AND verification_failure_code IS NULL AND verification_failure_reason IS NULL
    ) OR (
      attempt_state = 'CONFIRMED'
      AND signed_transaction IS NOT NULL AND local_tx_hash IS NOT NULL AND signed_at IS NOT NULL
      AND broadcast_requested_at IS NOT NULL AND broadcast_submitted_at IS NOT NULL AND network_tx_hash IS NOT NULL
      AND verified_at IS NOT NULL AND receipt_block_number IS NOT NULL AND receipt_block_hash IS NOT NULL
      AND receipt_status = 'success' AND verified_transfer_log_index IS NOT NULL AND confirmed_at IS NOT NULL
      AND verification_failure_code IS NULL AND verification_failure_reason IS NULL
    ) OR (
      attempt_state = 'REVERTED'
      AND signed_transaction IS NOT NULL AND local_tx_hash IS NOT NULL AND signed_at IS NOT NULL
      AND broadcast_requested_at IS NOT NULL AND broadcast_submitted_at IS NOT NULL AND network_tx_hash IS NOT NULL
      AND verified_at IS NOT NULL AND receipt_block_number IS NOT NULL AND receipt_block_hash IS NOT NULL
      AND receipt_status = 'reverted' AND verified_transfer_log_index IS NULL AND confirmed_at IS NULL
      AND verification_failure_code = 'TRANSACTION_REVERTED' AND verification_failure_reason IS NOT NULL
    ) OR (
      attempt_state = 'VERIFICATION_FAILED'
      AND signed_transaction IS NOT NULL AND local_tx_hash IS NOT NULL AND signed_at IS NOT NULL
      AND broadcast_requested_at IS NOT NULL AND broadcast_submitted_at IS NOT NULL AND network_tx_hash IS NOT NULL
      AND verified_at IS NOT NULL AND verified_transfer_log_index IS NULL AND confirmed_at IS NULL
      AND verification_failure_code IS NOT NULL AND verification_failure_reason IS NOT NULL
      AND (
        (receipt_block_number IS NULL AND receipt_block_hash IS NULL AND receipt_status IS NULL)
        OR
        (receipt_block_number IS NOT NULL AND receipt_block_hash IS NOT NULL AND receipt_status IS NOT NULL)
      )
    )
  );

CREATE INDEX settlement_attempts_verification_state_idx
  ON blockchain_private.settlement_attempts (attempt_state, verified_at)
  WHERE attempt_state IN ('CONFIRMED', 'REVERTED', 'VERIFICATION_FAILED');

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
    (OLD.attempt_state = 'PREPARING' AND NEW.attempt_state = 'SIGNED')
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
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;

COMMIT;
