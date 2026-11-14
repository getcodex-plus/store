CREATE TABLE inventory_batches (
  id text PRIMARY KEY,
  name text NOT NULL,
  product_id text NOT NULL REFERENCES products(id),
  imported_by text NOT NULL,
  imported integer NOT NULL CHECK (imported >= 0),
  duplicates integer NOT NULL DEFAULT 0 CHECK (duplicates >= 0),
  upstream_product text NOT NULL DEFAULT '',
  country text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_batches_created ON inventory_batches (created_at, id);
ALTER TABLE products ADD COLUMN active_inventory_batch_id text REFERENCES inventory_batches(id);

ALTER TABLE inventory
  ADD COLUMN enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN batch_id text REFERENCES inventory_batches(id),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX inventory_product_availability ON inventory (product_id, enabled, status);
CREATE INDEX inventory_batch ON inventory (batch_id);
