-- Batches supply independently; keep each batch's existing enabled state.
ALTER TABLE products DROP COLUMN active_inventory_batch_id;
ALTER TABLE inventory_batches
  DROP COLUMN upstream_product,
  DROP COLUMN country;
