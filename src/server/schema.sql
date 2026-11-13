CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY, email text UNIQUE NOT NULL, role text NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
  referral_code text UNIQUE NOT NULL, invited_by text REFERENCES users(id), disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rate_limits (
  key text PRIMARY KEY, count integer NOT NULL DEFAULT 1, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id text PRIMARY KEY, name text NOT NULL, subtitle text NOT NULL, description text NOT NULL,
  price integer NOT NULL CHECK(price > 0 AND price <= 100000000), features jsonb NOT NULL,
  plan text NOT NULL CHECK(plan IN ('plus','pro5','pro20','promax')), enabled boolean NOT NULL DEFAULT true,
  featured boolean NOT NULL DEFAULT false, upgrade boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS settings (id integer PRIMARY KEY CHECK(id=1), body jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS integrations (
  id text PRIMARY KEY, provider text NOT NULL, public jsonb NOT NULL, secret text NOT NULL,
  enabled boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS integrations_active ON integrations(provider) WHERE active=true;
CREATE TABLE IF NOT EXISTS inventory (
  id text PRIMARY KEY, product_id text NOT NULL REFERENCES products(id), code text NOT NULL, fingerprint text UNIQUE NOT NULL,
  status text NOT NULL DEFAULT 'available' CHECK(status IN ('available','reserved','consumed')),
  reserved_until timestamptz
);
CREATE TABLE IF NOT EXISTS quotes (
  id text PRIMARY KEY, browser_digest text NOT NULL, product_id text NOT NULL REFERENCES products(id),
  email text NOT NULL, amount integer NOT NULL CHECK(amount>0), inventory_id text REFERENCES inventory(id),
  preflight_token text, status text NOT NULL DEFAULT 'ready', expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), quote_id text UNIQUE REFERENCES quotes(id),
  kind text NOT NULL DEFAULT 'purchase' CHECK(kind IN ('purchase','topup')), request_hash text NOT NULL,
  product_id text REFERENCES products(id), product_name text NOT NULL, email text NOT NULL,
  amount integer NOT NULL CHECK(amount>0), status text NOT NULL CHECK(status IN ('unpaid','processing','completed','needs_session','failed','refunded')),
  channel text NOT NULL CHECK(channel IN ('alipay','wechat','crypto','balance')), created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz, rate_bps integer NOT NULL, settlement_days integer NOT NULL, first_order_only boolean NOT NULL,
  provider text NOT NULL, integration_id text REFERENCES integrations(id),
  payment_id text, payment_url text, payment_attempted boolean NOT NULL DEFAULT false,
  redemption_id text, fulfillment_attempt integer NOT NULL DEFAULT 0,
  failure_reason text
);
CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS commissions (
  id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), order_id text UNIQUE NOT NULL REFERENCES orders(id),
  amount integer NOT NULL CHECK(amount>0), status text NOT NULL CHECK(status IN ('pending','available','reversed')),
  available_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commissions_user ON commissions(user_id);
CREATE TABLE IF NOT EXISTS withdrawals (
  id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), amount integer NOT NULL CHECK(amount>0),
  method text NOT NULL, account text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','rejected')),
  note text NOT NULL DEFAULT '', request_key text UNIQUE NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit (
  id text PRIMARY KEY, actor text NOT NULL, action text NOT NULL, target text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE withdrawals DROP CONSTRAINT IF EXISTS withdrawals_status_check;
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_status_check
  CHECK(status IN ('pending','processing','paid','rejected'));
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS recipient_name text NOT NULL DEFAULT '';
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS network text;
ALTER TABLE withdrawals DROP CONSTRAINT IF EXISTS withdrawals_network_check;
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_network_check
  CHECK(network IN ('TRC20','ERC20','BSC','Polygon'));
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS request_hash text NOT NULL DEFAULT '';
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS fee_amount integer NOT NULL DEFAULT 0 CHECK(fee_amount>=0 AND fee_amount<amount);
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS fee_rate_bps integer NOT NULL DEFAULT 0 CHECK(fee_rate_bps>=0 AND fee_rate_bps<10000);
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS fixed_fee integer NOT NULL DEFAULT 0 CHECK(fixed_fee>=0);
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS payout_reference text NOT NULL DEFAULT '';
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS payout_amount numeric(20,6) CHECK(payout_amount>0);
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS reviewer_id text REFERENCES users(id);
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
CREATE INDEX IF NOT EXISTS withdrawals_user ON withdrawals(user_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS withdrawals_payout_reference
  ON withdrawals(method,COALESCE(network,''),payout_reference) WHERE payout_reference<>'';
CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY, order_id text UNIQUE NOT NULL REFERENCES orders(id),
  attempts integer NOT NULL DEFAULT 0, run_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz, lease text, last_error text, done boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(run_at) WHERE done=false;
CREATE TABLE IF NOT EXISTS payment_events (
  provider text NOT NULL, transaction_id text NOT NULL, order_id text NOT NULL REFERENCES orders(id),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(provider, transaction_id)
);
CREATE TABLE IF NOT EXISTS wallets (
  user_id text PRIMARY KEY REFERENCES users(id), balance integer NOT NULL DEFAULT 0 CHECK(balance>=0)
);
CREATE TABLE IF NOT EXISTS wallet_ledger (
  id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), amount integer NOT NULL CHECK(amount<>0),
  balance_after integer NOT NULL CHECK(balance_after>=0), kind text NOT NULL CHECK(kind IN ('topup','purchase','refund')),
  order_id text NOT NULL REFERENCES orders(id), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(order_id,kind)
);
CREATE INDEX IF NOT EXISTS wallet_ledger_user ON wallet_ledger(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS roles (
  id text PRIMARY KEY, name text NOT NULL, permissions jsonb NOT NULL, protected boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS user_roles (
  user_id text NOT NULL REFERENCES users(id), role_id text NOT NULL REFERENCES roles(id), PRIMARY KEY(user_id,role_id)
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS request_hash text NOT NULL DEFAULT '';

-- Backfill the existing business identity before Better Auth adds its indexes and plugin tables.
ALTER TABLE users ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS demo_mailbox (
  browser_digest text NOT NULL, email text NOT NULL, code text NOT NULL, expires_at timestamptz NOT NULL,
  PRIMARY KEY(browser_digest,email)
);

ALTER TABLE orders ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS contact_email text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS guest_browser_digest text;
UPDATE orders SET contact_email=u.email FROM users u WHERE orders.user_id=u.id AND contact_email IS NULL;
CREATE INDEX IF NOT EXISTS orders_unclaimed_email ON orders(contact_email) WHERE user_id IS NULL;
CREATE TABLE IF NOT EXISTS email_outbox (
  id text PRIMARY KEY, order_id text NOT NULL REFERENCES orders(id), status text NOT NULL,
  attempts integer NOT NULL DEFAULT 0, run_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz, UNIQUE(order_id,status)
);
CREATE OR REPLACE FUNCTION enqueue_order_email() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.contact_email IS NOT NULL AND (TG_OP='INSERT' OR NEW.status IS DISTINCT FROM OLD.status) THEN
    INSERT INTO email_outbox(id,order_id,status) VALUES(NEW.id||':'||NEW.status,NEW.id,NEW.status) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS order_email_outbox ON orders;
CREATE TRIGGER order_email_outbox AFTER INSERT OR UPDATE OF status ON orders
FOR EACH ROW EXECUTE FUNCTION enqueue_order_email();

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS aicdk_integration_id text REFERENCES integrations(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS aicdk_integration_id text REFERENCES integrations(id);

-- Immutable payment split; legacy balance orders are backfilled once.
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_plan_check;
ALTER TABLE products ADD CONSTRAINT products_plan_check CHECK(plan IN ('go','plus','pro5','pro20','promax'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS balance_amount integer;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS external_amount integer;
UPDATE orders SET balance_amount=CASE WHEN channel='balance' THEN amount ELSE 0 END,
 external_amount=CASE WHEN channel='balance' THEN 0 ELSE amount END WHERE balance_amount IS NULL;
ALTER TABLE orders ALTER COLUMN balance_amount SET NOT NULL;
ALTER TABLE orders ALTER COLUMN balance_amount SET DEFAULT 0;
ALTER TABLE orders ALTER COLUMN external_amount SET NOT NULL;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_split_check;
ALTER TABLE orders ADD CONSTRAINT orders_split_check CHECK(balance_amount>=0 AND external_amount>=0 AND balance_amount+external_amount=amount AND (balance_amount=0 OR user_id IS NOT NULL));
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK(status IN ('unpaid','processing','completed','needs_session','failed','refunded','cancelled'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS inviter_id text REFERENCES users(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS buyer_key text;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS pricing_snapshot jsonb;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS current_plan text;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS target_plan text;
CREATE INDEX IF NOT EXISTS orders_buyer ON orders(buyer_key) WHERE kind='purchase';

ALTER TABLE products ADD COLUMN IF NOT EXISTS pricing_mode text;
UPDATE products SET pricing_mode=CASE WHEN upgrade THEN 'markup' ELSE 'fixed' END WHERE pricing_mode IS NULL;
ALTER TABLE products ALTER COLUMN pricing_mode SET DEFAULT 'fixed';
ALTER TABLE products ALTER COLUMN pricing_mode SET NOT NULL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS pricing jsonb;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_pricing_mode_check;
ALTER TABLE products ADD CONSTRAINT products_pricing_mode_check CHECK(pricing_mode IN ('fixed','markup') AND (NOT upgrade OR pricing_mode='markup'));

-- Retire ordinary dynamic pricing. Previously dynamic listings require review
-- of their saved fixed amount before the administrator enables them again.
UPDATE products SET enabled=false,pricing_mode='fixed' WHERE upgrade=false AND pricing_mode='markup';
UPDATE products SET pricing=null WHERE pricing IS NOT NULL;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_pricing_mode_check;
ALTER TABLE products ADD CONSTRAINT products_pricing_mode_check
 CHECK((upgrade AND pricing_mode='markup') OR (NOT upgrade AND pricing_mode='fixed'));
DROP TABLE IF EXISTS product_price_cache;

ALTER TABLE products ADD COLUMN IF NOT EXISTS price_currency text NOT NULL DEFAULT 'CNY'
 CHECK(price_currency IN ('CNY','USD'));
ALTER TABLE products ADD COLUMN IF NOT EXISTS rounding_step integer NOT NULL DEFAULT 100
 CHECK(rounding_step IN (1,10,100,1000));
ALTER TABLE products ALTER COLUMN rounding_step SET DEFAULT 100;
CREATE TABLE IF NOT EXISTS exchange_rates (
 id text PRIMARY KEY CHECK(id='USD_CNY'),
 rate_e8 bigint CHECK(rate_e8>0 AND rate_e8<=10000000000),
 source_date text,
 fetched_at timestamptz,
 expires_at timestamptz,
 refresh_after timestamptz NOT NULL DEFAULT now(),
 locked_until timestamptz,
 lease text,
 last_error text
);
INSERT INTO exchange_rates(id) VALUES('USD_CNY') ON CONFLICT DO NOTHING;
ALTER TABLE exchange_rates DROP CONSTRAINT IF EXISTS exchange_rates_id_check;
ALTER TABLE exchange_rates ADD CONSTRAINT exchange_rates_id_check CHECK(id ~ '^([A-Z]{3}|USDT)_CNY$');
ALTER TABLE exchange_rates ADD COLUMN IF NOT EXISTS source text;
INSERT INTO exchange_rates(id) VALUES('USDT_CNY') ON CONFLICT DO NOTHING;

-- UI presents EPay as one service; historical order provider IDs stay unchanged.
UPDATE settings SET body=body || jsonb_build_object('epayVersion',
 CASE WHEN body->>'fiatProvider' IN ('epay_v1','epay_v2') THEN body->>'fiatProvider'
 ELSE COALESCE((SELECT provider FROM integrations WHERE active=true AND provider IN ('epay_v1','epay_v2')
   ORDER BY created_at DESC LIMIT 1),'epay_v1') END)
 WHERE NOT body ? 'epayVersion';

-- Preserve the service description accepted with a quote, then with its order.
ALTER TABLE products ADD COLUMN IF NOT EXISTS service_terms text NOT NULL DEFAULT '';
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS service_terms text NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS service_terms text NOT NULL DEFAULT '';
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS analytics_visitor text;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS attribution_source text NOT NULL DEFAULT 'direct';
-- Existing quotes keep their already-bound authorization. New quotes are CDK-free checks.
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS flow_version integer NOT NULL DEFAULT 1;
ALTER TABLE quotes ALTER COLUMN flow_version SET DEFAULT 2;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS preflight_expires_at timestamptz;
UPDATE quotes SET preflight_expires_at=expires_at WHERE preflight_token IS NOT NULL AND preflight_expires_at IS NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_status text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS redemption_version integer NOT NULL DEFAULT 0;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
    AND table_name='orders' AND column_name='submission_attempted') THEN
    ALTER TABLE orders ADD COLUMN submission_attempted boolean NOT NULL DEFAULT false;
    -- Conservatively preserve legacy requests whose upstream result may be unknown.
    UPDATE orders SET submission_attempted=true WHERE status IN ('processing','needs_session');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS funnel_events (
  id text PRIMARY KEY,
  event text NOT NULL CHECK(event IN ('plan_view','checkout_view','verify_started','quote_ready','order_created','payment_succeeded','delivery_completed','order_refunded')),
  visitor_key text NOT NULL,
  product_id text NOT NULL,
  source text NOT NULL CHECK(source IN ('direct','google','bing','baidu','referral','other')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS funnel_events_date ON funnel_events(created_at);

-- Financial events come exclusively from database transitions. Stable IDs prevent
-- retries, balance-only payments and repeated status updates from double counting.
CREATE OR REPLACE FUNCTION record_funnel_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q record;
BEGIN
  IF NEW.kind <> 'purchase' THEN RETURN NEW; END IF;
  SELECT analytics_visitor, attribution_source INTO q FROM quotes WHERE id=NEW.quote_id;
  IF q.analytics_visitor IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN
    INSERT INTO funnel_events(id,event,visitor_key,product_id,source)
    VALUES(NEW.id||':created','order_created',q.analytics_visitor,NEW.product_id,q.attribution_source)
    ON CONFLICT DO NOTHING;
  END IF;
  IF NEW.status IN ('processing','completed') THEN
    INSERT INTO funnel_events(id,event,visitor_key,product_id,source)
    VALUES(NEW.id||':paid','payment_succeeded',q.analytics_visitor,NEW.product_id,q.attribution_source)
    ON CONFLICT DO NOTHING;
  END IF;
  IF NEW.status IN ('completed','refunded') THEN
    INSERT INTO funnel_events(id,event,visitor_key,product_id,source)
    VALUES(NEW.id||':'||NEW.status,CASE NEW.status WHEN 'completed' THEN 'delivery_completed' ELSE 'order_refunded' END,
      q.analytics_visitor,NEW.product_id,q.attribution_source)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS order_funnel ON orders;
CREATE TRIGGER order_funnel AFTER INSERT OR UPDATE OF status ON orders
FOR EACH ROW EXECUTE FUNCTION record_funnel_order();
