CREATE TABLE risk_events (
  id text PRIMARY KEY,
  scene text NOT NULL,
  action text NOT NULL CHECK (action IN ('allow', 'deny', 'challenge', 'review')),
  effective_action text NOT NULL CHECK (effective_action IN ('allow', 'deny', 'challenge', 'review')),
  mode text NOT NULL CHECK (mode IN ('enforce', 'observe')),
  rule_version text NOT NULL,
  reason_codes jsonb NOT NULL,
  subjects jsonb NOT NULL,
  facts jsonb NOT NULL,
  reference_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX risk_events_created ON risk_events(created_at DESC);
CREATE INDEX risk_events_reference ON risk_events(reference_id);
ALTER TABLE withdrawals ADD COLUMN payout_fingerprint text;
CREATE INDEX withdrawals_payout_identity ON withdrawals(payout_fingerprint, user_id);
