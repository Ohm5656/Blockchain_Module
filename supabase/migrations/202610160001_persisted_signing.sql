-- Task 2 only. Apply once, as migration owner, to a TESTNET project's Postgres.
-- Use a private schema, not Supabase's PostgREST-exposed public schema.
BEGIN;
SET LOCAL synchronous_commit = on;

CREATE SCHEMA blockchain_private;
REVOKE ALL ON SCHEMA blockchain_private FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fuji_settlement_service') THEN
    CREATE ROLE fuji_settlement_service NOLOGIN;
  END IF;
END $$;

CREATE TABLE blockchain_private.settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id text NOT NULL UNIQUE CHECK (transfer_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'),
  chain_id integer NOT NULL CHECK (chain_id = 43113),
  signer_address text NOT NULL CHECK (signer_address ~ '^0x[0-9a-f]{40}$' AND signer_address <> '0x0000000000000000000000000000000000000000'),
  destination_address text NOT NULL CHECK (destination_address ~ '^0x[0-9a-f]{40}$' AND destination_address <> '0x0000000000000000000000000000000000000000'),
  token_address text NOT NULL CHECK (token_address = '0x5425890298aed601595a70ab815c96711a31bc65'),
  -- Canonical decimal text avoids any JS/JSON floating point or SQL rounding.
  amount_units text NOT NULL CHECK (
    amount_units ~ '^[1-9][0-9]{0,77}$'
    AND amount_units::numeric <= 115792089237316195423570985008687907853269984665640564039457584007913129639935
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (signer_address <> destination_address),
  UNIQUE (id, chain_id, signer_address, destination_address, token_address, amount_units)
);

CREATE TABLE blockchain_private.signer_nonces (
  chain_id integer NOT NULL CHECK (chain_id = 43113),
  signer_address text NOT NULL CHECK (signer_address ~ '^0x[0-9a-f]{40}$' AND signer_address <> '0x0000000000000000000000000000000000000000'),
  next_nonce bigint NOT NULL CHECK (next_nonce BETWEEN 0 AND 9007199254740991),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (chain_id, signer_address)
);

CREATE TABLE blockchain_private.settlement_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id uuid NOT NULL UNIQUE,
  attempt_number integer NOT NULL DEFAULT 1 CHECK (attempt_number = 1),
  chain_id integer NOT NULL,
  signer_address text NOT NULL,
  destination_address text NOT NULL,
  token_address text NOT NULL,
  amount_units text NOT NULL,
  nonce bigint NOT NULL CHECK (nonce BETWEEN 0 AND 9007199254740990),
  signed_transaction text CHECK (signed_transaction ~ '^0x02([0-9a-fA-F]{2})+$'),
  local_tx_hash text UNIQUE CHECK (local_tx_hash ~ '^0x[0-9a-f]{64}$'),
  network_tx_hash text CHECK (network_tx_hash = local_tx_hash),
  attempt_state text NOT NULL CHECK (attempt_state IN ('PREPARING', 'SIGNED', 'BROADCAST_REQUESTED', 'BROADCAST_SUBMITTED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  signed_at timestamptz,
  broadcast_requested_at timestamptz,
  broadcast_submitted_at timestamptz,
  FOREIGN KEY (settlement_id, chain_id, signer_address, destination_address, token_address, amount_units)
    REFERENCES blockchain_private.settlements (id, chain_id, signer_address, destination_address, token_address, amount_units),
  FOREIGN KEY (chain_id, signer_address) REFERENCES blockchain_private.signer_nonces (chain_id, signer_address),
  UNIQUE (chain_id, signer_address, nonce),
  CHECK (
    (attempt_state = 'PREPARING' AND signed_transaction IS NULL AND local_tx_hash IS NULL AND signed_at IS NULL
      AND broadcast_requested_at IS NULL AND broadcast_submitted_at IS NULL AND network_tx_hash IS NULL)
    OR
    (attempt_state = 'SIGNED' AND signed_transaction IS NOT NULL AND local_tx_hash IS NOT NULL AND signed_at IS NOT NULL
      AND broadcast_requested_at IS NULL AND broadcast_submitted_at IS NULL AND network_tx_hash IS NULL)
    OR
    (attempt_state = 'BROADCAST_REQUESTED' AND signed_transaction IS NOT NULL AND local_tx_hash IS NOT NULL AND signed_at IS NOT NULL
      AND broadcast_requested_at IS NOT NULL AND broadcast_submitted_at IS NULL AND network_tx_hash IS NULL)
    OR
    (attempt_state = 'BROADCAST_SUBMITTED' AND signed_transaction IS NOT NULL AND local_tx_hash IS NOT NULL AND signed_at IS NOT NULL
      AND broadcast_requested_at IS NOT NULL AND broadcast_submitted_at IS NOT NULL AND network_tx_hash IS NOT NULL)
  )
);
CREATE INDEX settlement_attempts_state_created_idx
  ON blockchain_private.settlement_attempts (attempt_state, created_at);

CREATE FUNCTION blockchain_private.guard_settlement_intent() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Settlement intent cannot be deleted';
  END IF;
  IF ROW(NEW.id, NEW.transfer_id, NEW.chain_id, NEW.signer_address, NEW.destination_address, NEW.token_address, NEW.amount_units, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.transfer_id, OLD.chain_id, OLD.signer_address, OLD.destination_address, OLD.token_address, OLD.amount_units, OLD.created_at) THEN
    RAISE EXCEPTION 'Settlement intent is immutable';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER guard_settlement_intent BEFORE UPDATE OR DELETE ON blockchain_private.settlements
FOR EACH ROW EXECUTE FUNCTION blockchain_private.guard_settlement_intent();

CREATE FUNCTION blockchain_private.guard_attempt() RETURNS trigger
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
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER guard_attempt BEFORE INSERT OR UPDATE OR DELETE ON blockchain_private.settlement_attempts
FOR EACH ROW EXECUTE FUNCTION blockchain_private.guard_attempt();

CREATE FUNCTION blockchain_private.guard_nonce() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Nonce reservations cannot be deleted';
  END IF;
  IF ROW(NEW.chain_id, NEW.signer_address) IS DISTINCT FROM ROW(OLD.chain_id, OLD.signer_address)
    OR NEW.next_nonce < OLD.next_nonce THEN
    RAISE EXCEPTION 'Nonce cursor must be monotonic';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER guard_nonce BEFORE UPDATE OR DELETE ON blockchain_private.signer_nonces
FOR EACH ROW EXECUTE FUNCTION blockchain_private.guard_nonce();

REVOKE ALL ON ALL TABLES IN SCHEMA blockchain_private FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA blockchain_private FROM PUBLIC;
GRANT USAGE ON SCHEMA blockchain_private TO fuji_settlement_service;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA blockchain_private TO fuji_settlement_service;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA blockchain_private TO fuji_settlement_service;

ALTER TABLE blockchain_private.settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE blockchain_private.settlement_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE blockchain_private.signer_nonces ENABLE ROW LEVEL SECURITY;
CREATE POLICY backend_only ON blockchain_private.settlements TO fuji_settlement_service USING (true) WITH CHECK (true);
CREATE POLICY backend_only ON blockchain_private.settlement_attempts TO fuji_settlement_service USING (true) WITH CHECK (true);
CREATE POLICY backend_only ON blockchain_private.signer_nonces TO fuji_settlement_service USING (true) WITH CHECK (true);
COMMIT;
