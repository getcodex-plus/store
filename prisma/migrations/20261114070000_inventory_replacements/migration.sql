CREATE TABLE inventory_replacements (
  id text PRIMARY KEY,
  inventory_id text NOT NULL UNIQUE REFERENCES inventory(id),
  integration_id text NOT NULL REFERENCES integrations(id),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'review', 'completed')),
  preview jsonb NOT NULL,
  restore_enabled boolean NOT NULL,
  replacement_inventory_id text REFERENCES inventory(id),
  upstream_replacement_id text,
  upstream_code_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
