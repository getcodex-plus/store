ALTER TABLE inventory_replacements
  ADD COLUMN IF NOT EXISTS order_id text REFERENCES orders(id),
  ADD COLUMN IF NOT EXISTS order_round integer;
CREATE UNIQUE INDEX IF NOT EXISTS inventory_replacements_order_round_key ON inventory_replacements(order_id, order_round);
