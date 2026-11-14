ALTER TABLE inventory ADD COLUMN discount_country text;
ALTER TABLE inventory_batches ADD COLUMN discount_country text;

ALTER TABLE inventory ADD CONSTRAINT inventory_discount_country_check
  CHECK (discount_country IS NULL OR discount_country ~ '^[a-z]{2}$');
ALTER TABLE inventory_batches ADD CONSTRAINT inventory_batches_discount_country_check
  CHECK (discount_country IS NULL OR discount_country ~ '^[a-z]{2}$');

CREATE INDEX inventory_discount_availability
  ON inventory(product_id, discount_country, enabled, status);
