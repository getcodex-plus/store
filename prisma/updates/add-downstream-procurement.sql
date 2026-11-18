BEGIN;
CREATE TABLE IF NOT EXISTS stock_mappings (
    product_id text PRIMARY KEY REFERENCES products(id),
    integration_id text NOT NULL REFERENCES integrations(id),
    upstream_product_id integer NOT NULL CHECK (upstream_product_id > 0),
    sku_id integer NOT NULL CHECK (sku_id > 0),
    UNIQUE (integration_id, sku_id)
);
CREATE TABLE IF NOT EXISTS stock_purchases (
    id text PRIMARY KEY,
    product_id text NOT NULL REFERENCES products(id),
    integration_id text NOT NULL REFERENCES integrations(id),
    upstream_product_id integer NOT NULL CHECK (upstream_product_id > 0),
    sku_id integer NOT NULL CHECK (sku_id > 0),
    quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 500),
    actor text NOT NULL,
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','polling','received','rejected','review')),
    upstream_order_id integer,
    batch_id text UNIQUE REFERENCES inventory_batches(id),
    last_error text,
    attempts integer NOT NULL DEFAULT 0,
    next_run_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_purchases_state_next_run_at_idx ON stock_purchases(state, next_run_at);
UPDATE products SET enabled = false WHERE upgrade AND enabled;
UPDATE coupons SET enabled = false WHERE scope_mode = 'upgrade_only' AND enabled;
COMMIT;
