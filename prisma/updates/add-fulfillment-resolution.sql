-- Existing databases only. Run in the application's schema before deploying the
-- updated web and worker. Existing orders and manual decisions are preserved.
BEGIN;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_resolution jsonb;
COMMIT;
