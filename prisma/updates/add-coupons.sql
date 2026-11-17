-- Existing databases only. Run in the application's schema before deploying the
-- updated web and worker. Existing orders, quotes, commissions and settings are preserved.
BEGIN;

CREATE TABLE IF NOT EXISTS coupons (
    id text NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    discount_kind text NOT NULL,
    discount_value integer NOT NULL,
    max_discount_amount integer,
    min_amount integer DEFAULT 0 NOT NULL,
    scope_mode text DEFAULT 'all'::text NOT NULL,
    product_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    upgrade_protection text DEFAULT 'cost'::text NOT NULL,
    first_order_only boolean DEFAULT false NOT NULL,
    require_login boolean DEFAULT false NOT NULL,
    max_redemptions integer,
    per_buyer_limit integer DEFAULT 1,
    starts_at timestamp with time zone,
    expires_at timestamp with time zone,
    allow_referral boolean DEFAULT true NOT NULL,
    affiliate_user_id text,
    affiliate_rate_bps integer,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT coupons_affiliate_rate_check CHECK (((affiliate_rate_bps IS NULL) OR ((affiliate_user_id IS NOT NULL) AND (affiliate_rate_bps >= 0) AND (affiliate_rate_bps <= 900)))),
    CONSTRAINT coupons_code_check CHECK ((code ~ '^[A-Z0-9_-]{3,32}$'::text)),
    CONSTRAINT coupons_discount_check CHECK ((((discount_kind = 'fixed'::text) AND (discount_value > 0) AND (discount_value <= 100000000) AND (max_discount_amount IS NULL)) OR ((discount_kind = 'percent'::text) AND (discount_value >= 1) AND (discount_value <= 9900) AND ((max_discount_amount IS NULL) OR ((max_discount_amount > 0) AND (max_discount_amount <= 100000000)))))),
    CONSTRAINT coupons_limits_check CHECK (((min_amount >= 0) AND (min_amount <= 100000000) AND ((max_redemptions IS NULL) OR (max_redemptions > 0)) AND ((per_buyer_limit IS NULL) OR (per_buyer_limit > 0)))),
    CONSTRAINT coupons_scope_mode_check CHECK ((scope_mode = ANY (ARRAY['all'::text, 'recharge_only'::text, 'upgrade_only'::text, 'products'::text]))),
    CONSTRAINT coupons_upgrade_protection_check CHECK ((upgrade_protection = ANY (ARRAY['cost'::text, 'min_profit'::text, 'none'::text]))),
    CONSTRAINT coupons_window_check CHECK (((starts_at IS NULL) OR (expires_at IS NULL) OR (starts_at < expires_at))),
    CONSTRAINT coupons_pkey PRIMARY KEY (id),
    CONSTRAINT coupons_code_key UNIQUE (code),
    CONSTRAINT coupons_affiliate_user_id_fkey FOREIGN KEY (affiliate_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS coupons_affiliate_idx ON coupons USING btree (affiliate_user_id) WHERE (affiliate_user_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS coupons_created_idx ON coupons USING btree (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
    id text NOT NULL,
    coupon_id text NOT NULL,
    order_id text NOT NULL,
    status text DEFAULT 'reserved'::text NOT NULL,
    user_id text,
    buyer_key text NOT NULL,
    contact_key text NOT NULL,
    discount_amount integer NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT coupon_redemptions_discount_amount_check CHECK ((discount_amount > 0)),
    CONSTRAINT coupon_redemptions_expires_check CHECK (((status = 'reserved'::text) OR (expires_at IS NULL))),
    CONSTRAINT coupon_redemptions_status_check CHECK ((status = ANY (ARRAY['reserved'::text, 'redeemed'::text, 'released'::text]))),
    CONSTRAINT coupon_redemptions_pkey PRIMARY KEY (id),
    CONSTRAINT coupon_redemptions_order_id_key UNIQUE (order_id),
    CONSTRAINT coupon_redemptions_coupon_id_fkey FOREIGN KEY (coupon_id) REFERENCES coupons(id),
    CONSTRAINT coupon_redemptions_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id),
    CONSTRAINT coupon_redemptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS coupon_redemptions_coupon_status_idx ON coupon_redemptions USING btree (coupon_id, status);
CREATE INDEX IF NOT EXISTS coupon_redemptions_buyer_idx ON coupon_redemptions USING btree (coupon_id, buyer_key) WHERE (status <> 'released'::text);
CREATE INDEX IF NOT EXISTS coupon_redemptions_contact_idx ON coupon_redemptions USING btree (coupon_id, contact_key) WHERE (status <> 'released'::text);
CREATE INDEX IF NOT EXISTS coupon_redemptions_user_idx ON coupon_redemptions USING btree (coupon_id, user_id) WHERE ((user_id IS NOT NULL) AND (status <> 'released'::text));
CREATE INDEX IF NOT EXISTS coupon_redemptions_expiring_idx ON coupon_redemptions USING btree (expires_at) WHERE ((status = 'reserved'::text) AND (expires_at IS NOT NULL));

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS list_amount integer,
  ADD COLUMN IF NOT EXISTS discount_amount integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS coupon_id text,
  ADD COLUMN IF NOT EXISTS coupon_code text,
  ADD COLUMN IF NOT EXISTS coupon_snapshot jsonb;

UPDATE orders SET list_amount = amount WHERE list_amount IS NULL;
ALTER TABLE orders ALTER COLUMN list_amount SET NOT NULL;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_discount_check;
ALTER TABLE orders ADD CONSTRAINT orders_discount_check CHECK (((list_amount > 0) AND (discount_amount >= 0) AND ((list_amount - discount_amount) = amount) AND (((discount_amount = 0) AND (coupon_id IS NULL) AND (coupon_code IS NULL) AND (coupon_snapshot IS NULL)) OR ((kind = 'purchase'::text) AND (discount_amount > 0) AND (coupon_id IS NOT NULL) AND (coupon_code IS NOT NULL) AND (coupon_snapshot IS NOT NULL)))));

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_coupon_id_fkey;
ALTER TABLE orders ADD CONSTRAINT orders_coupon_id_fkey FOREIGN KEY (coupon_id) REFERENCES coupons(id);
CREATE INDEX IF NOT EXISTS orders_coupon_idx ON orders USING btree (coupon_id) WHERE (coupon_id IS NOT NULL);

ALTER TABLE funnel_events DROP CONSTRAINT IF EXISTS funnel_events_source_check;
ALTER TABLE funnel_events ADD CONSTRAINT funnel_events_source_check CHECK ((source = ANY (ARRAY['direct'::text, 'google'::text, 'bing'::text, 'baidu'::text, 'referral'::text, 'coupon'::text, 'other'::text])));

COMMIT;
