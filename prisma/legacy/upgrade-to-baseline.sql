-- Compatibility bridge for the recognized pre-AICDK-v2 / pre-OPAQUE schema.
-- Run through db:upgrade-legacy after backup, with Web and worker stopped.
BEGIN;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS flow_version integer NOT NULL DEFAULT 1;
ALTER TABLE quotes ALTER COLUMN flow_version SET DEFAULT 2;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS preflight_expires_at timestamptz;
UPDATE quotes SET preflight_expires_at=expires_at
  WHERE preflight_token IS NOT NULL AND preflight_expires_at IS NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_status text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS redemption_version integer NOT NULL DEFAULT 0;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
    AND table_name='orders' AND column_name='submission_attempted') THEN
    ALTER TABLE orders ADD COLUMN submission_attempted boolean NOT NULL DEFAULT false;
    UPDATE orders SET submission_attempted=true WHERE status IN ('processing','needs_session');
  END IF;
END $$;
ALTER TABLE orders ALTER COLUMN request_hash SET DEFAULT '';
ALTER TABLE exchange_rates DROP CONSTRAINT IF EXISTS exchange_rates_id_check;
ALTER TABLE exchange_rates ADD CONSTRAINT exchange_rates_id_check
  CHECK(id ~ '^([A-Z]{3}|USDT)_CNY$');
ALTER TABLE auth_account ADD COLUMN IF NOT EXISTS "registrationRecord" text;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND c.relname='auth_account'
      AND k.conname='auth_account_registrationRecord_key') THEN
    ALTER TABLE auth_account ADD CONSTRAINT "auth_account_registrationRecord_key" UNIQUE("registrationRecord");
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS auth_one_opaque_account
  ON auth_account("userId") WHERE "providerId"='opaque';
COMMIT;
