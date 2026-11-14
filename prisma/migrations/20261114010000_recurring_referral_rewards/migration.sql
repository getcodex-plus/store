-- Apply recurring rewards to new orders. Existing order policy snapshots and
-- commissions remain unchanged.
UPDATE settings
SET body = jsonb_set(body, '{firstOrderOnly}', 'false'::jsonb)
WHERE id = 1;
