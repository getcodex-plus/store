ALTER TABLE stock_mappings
  ADD COLUMN IF NOT EXISTS purchase_after_payment boolean NOT NULL DEFAULT false;

ALTER TABLE stock_purchases
  ADD COLUMN IF NOT EXISTS order_id text UNIQUE REFERENCES orders(id);

ALTER TABLE stock_purchases DROP CONSTRAINT IF EXISTS stock_purchases_order_quantity_check;
ALTER TABLE stock_purchases ADD CONSTRAINT stock_purchases_order_quantity_check
  CHECK (order_id IS NULL OR quantity = 1);
