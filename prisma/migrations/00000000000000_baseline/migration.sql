-- Final schema of the existing application, including PostgreSQL constraints and triggers.
-- Existing databases must pass db:baseline validation before this migration is marked applied.
BEGIN;
--
-- PostgreSQL database dump
--


-- Dumped from database version 18.6 (Homebrew)
-- Dumped by pg_dump version 18.6 (Homebrew)


--
-- Name: auth_last_passkey_removed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION auth_last_passkey_removed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM auth_passkey WHERE "userId"=OLD."userId") THEN
    DELETE FROM auth_verification WHERE value=OLD."userId" AND identifier LIKE '2fa-%';
    DELETE FROM auth_session WHERE "userId"=OLD."userId";
  END IF;
  RETURN OLD;
END $$;


--
-- Name: auth_passkey_enable_mfa(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION auth_passkey_enable_mfa() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE users SET two_factor_enabled=true WHERE id=NEW."userId";
  RETURN NEW;
END $$;


--
-- Name: auth_passkey_owner_lock(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION auth_passkey_owner_lock() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM id FROM users WHERE id=COALESCE(NEW."userId",OLD."userId") FOR UPDATE;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_passkey_requires_mfa(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION auth_passkey_requires_mfa() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM auth_passkey WHERE "userId"=NEW.id) THEN
    NEW.two_factor_enabled=true;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: enqueue_order_email(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION enqueue_order_email() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.contact_email IS NOT NULL AND (TG_OP='INSERT' OR NEW.status IS DISTINCT FROM OLD.status) THEN
    INSERT INTO email_outbox(id,order_id,status) VALUES(NEW.id||':'||NEW.status,NEW.id,NEW.status) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: record_funnel_order(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION record_funnel_order() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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




--
-- Name: audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE audit (
    id text NOT NULL,
    actor text NOT NULL,
    action text NOT NULL,
    target text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_account; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE auth_account (
    id text NOT NULL,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" text NOT NULL,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamp with time zone,
    "refreshTokenExpiresAt" timestamp with time zone,
    scope text,
    password text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "registrationRecord" text
);


--
-- Name: auth_passkey; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE auth_passkey (
    id text NOT NULL,
    name text,
    "publicKey" text NOT NULL,
    "userId" text NOT NULL,
    "credentialID" text NOT NULL,
    counter integer NOT NULL,
    "deviceType" text NOT NULL,
    "backedUp" boolean NOT NULL,
    transports text,
    "createdAt" timestamp with time zone,
    aaguid text
);


--
-- Name: auth_rate_limit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE auth_rate_limit (
    id text NOT NULL,
    key text NOT NULL,
    count integer NOT NULL,
    "lastRequest" bigint NOT NULL
);


--
-- Name: auth_session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE auth_session (
    id text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    token text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" text NOT NULL,
    method text
);


--
-- Name: auth_verification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE auth_verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: commissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE commissions (
    id text NOT NULL,
    user_id text NOT NULL,
    order_id text NOT NULL,
    amount integer NOT NULL,
    status text NOT NULL,
    available_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT commissions_amount_check CHECK ((amount > 0)),
    CONSTRAINT commissions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'available'::text, 'reversed'::text])))
);


--
-- Name: demo_mailbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE demo_mailbox (
    browser_digest text NOT NULL,
    email text NOT NULL,
    code text NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: email_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE email_outbox (
    id text NOT NULL,
    order_id text NOT NULL,
    status text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    run_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone
);


--
-- Name: exchange_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE exchange_rates (
    id text NOT NULL,
    rate_e8 bigint,
    source_date text,
    fetched_at timestamp with time zone,
    expires_at timestamp with time zone,
    refresh_after timestamp with time zone DEFAULT now() NOT NULL,
    locked_until timestamp with time zone,
    lease text,
    last_error text,
    source text,
    CONSTRAINT exchange_rates_id_check CHECK ((id ~ '^([A-Z]{3}|USDT)_CNY$'::text)),
    CONSTRAINT exchange_rates_rate_e8_check CHECK (((rate_e8 > 0) AND (rate_e8 <= '10000000000'::bigint)))
);


--
-- Name: funnel_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE funnel_events (
    id text NOT NULL,
    event text NOT NULL,
    visitor_key text NOT NULL,
    product_id text NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT funnel_events_event_check CHECK ((event = ANY (ARRAY['plan_view'::text, 'checkout_view'::text, 'verify_started'::text, 'quote_ready'::text, 'order_created'::text, 'payment_succeeded'::text, 'delivery_completed'::text, 'order_refunded'::text]))),
    CONSTRAINT funnel_events_source_check CHECK ((source = ANY (ARRAY['direct'::text, 'google'::text, 'bing'::text, 'baidu'::text, 'referral'::text, 'other'::text])))
);


--
-- Name: integrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE integrations (
    id text NOT NULL,
    provider text NOT NULL,
    public jsonb NOT NULL,
    secret text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: inventory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE inventory (
    id text NOT NULL,
    product_id text NOT NULL,
    code text NOT NULL,
    fingerprint text NOT NULL,
    status text DEFAULT 'available'::text NOT NULL,
    reserved_until timestamp with time zone,
    CONSTRAINT inventory_status_check CHECK ((status = ANY (ARRAY['available'::text, 'reserved'::text, 'consumed'::text])))
);


--
-- Name: jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE jobs (
    id text NOT NULL,
    order_id text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    run_at timestamp with time zone DEFAULT now() NOT NULL,
    locked_until timestamp with time zone,
    lease text,
    last_error text,
    done boolean DEFAULT false NOT NULL
);


--
-- Name: orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE orders (
    id text NOT NULL,
    user_id text,
    quote_id text,
    kind text DEFAULT 'purchase'::text NOT NULL,
    request_hash text DEFAULT ''::text NOT NULL,
    product_id text,
    product_name text NOT NULL,
    email text NOT NULL,
    amount integer NOT NULL,
    status text NOT NULL,
    channel text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    rate_bps integer NOT NULL,
    settlement_days integer NOT NULL,
    first_order_only boolean NOT NULL,
    provider text NOT NULL,
    integration_id text,
    payment_id text,
    payment_url text,
    payment_attempted boolean DEFAULT false NOT NULL,
    redemption_id text,
    fulfillment_attempt integer DEFAULT 0 NOT NULL,
    failure_reason text,
    contact_email text,
    guest_browser_digest text,
    aicdk_integration_id text,
    balance_amount integer DEFAULT 0 NOT NULL,
    external_amount integer NOT NULL,
    inviter_id text,
    buyer_key text,
    service_terms text DEFAULT ''::text NOT NULL,
    fulfillment_status text,
    redemption_version integer DEFAULT 0 NOT NULL,
    submission_attempted boolean DEFAULT false NOT NULL,
    CONSTRAINT orders_amount_check CHECK ((amount > 0)),
    CONSTRAINT orders_channel_check CHECK ((channel = ANY (ARRAY['alipay'::text, 'wechat'::text, 'crypto'::text, 'balance'::text]))),
    CONSTRAINT orders_kind_check CHECK ((kind = ANY (ARRAY['purchase'::text, 'topup'::text]))),
    CONSTRAINT orders_split_check CHECK (((balance_amount >= 0) AND (external_amount >= 0) AND ((balance_amount + external_amount) = amount) AND ((balance_amount = 0) OR (user_id IS NOT NULL)))),
    CONSTRAINT orders_status_check CHECK ((status = ANY (ARRAY['unpaid'::text, 'processing'::text, 'completed'::text, 'needs_session'::text, 'failed'::text, 'refunded'::text, 'cancelled'::text])))
);


--
-- Name: payment_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE payment_events (
    provider text NOT NULL,
    transaction_id text NOT NULL,
    order_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE products (
    id text NOT NULL,
    name text NOT NULL,
    subtitle text NOT NULL,
    description text NOT NULL,
    price integer NOT NULL,
    features jsonb NOT NULL,
    plan text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    featured boolean DEFAULT false NOT NULL,
    upgrade boolean DEFAULT false NOT NULL,
    pricing_mode text DEFAULT 'fixed'::text NOT NULL,
    pricing jsonb,
    price_currency text DEFAULT 'CNY'::text NOT NULL,
    rounding_step integer DEFAULT 100 NOT NULL,
    service_terms text DEFAULT ''::text NOT NULL,
    CONSTRAINT products_plan_check CHECK ((plan = ANY (ARRAY['go'::text, 'plus'::text, 'pro5'::text, 'pro20'::text, 'promax'::text]))),
    CONSTRAINT products_price_check CHECK (((price > 0) AND (price <= 100000000))),
    CONSTRAINT products_price_currency_check CHECK ((price_currency = ANY (ARRAY['CNY'::text, 'USD'::text]))),
    CONSTRAINT products_pricing_mode_check CHECK (((upgrade AND (pricing_mode = 'markup'::text)) OR ((NOT upgrade) AND (pricing_mode = 'fixed'::text)))),
    CONSTRAINT products_rounding_step_check CHECK ((rounding_step = ANY (ARRAY[1, 10, 100, 1000])))
);


--
-- Name: quotes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE quotes (
    id text NOT NULL,
    browser_digest text NOT NULL,
    product_id text NOT NULL,
    email text NOT NULL,
    amount integer NOT NULL,
    inventory_id text,
    preflight_token text,
    status text DEFAULT 'ready'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    aicdk_integration_id text,
    pricing_snapshot jsonb,
    current_plan text,
    target_plan text,
    service_terms text DEFAULT ''::text NOT NULL,
    analytics_visitor text,
    attribution_source text DEFAULT 'direct'::text NOT NULL,
    flow_version integer DEFAULT 2 NOT NULL,
    preflight_expires_at timestamp with time zone,
    CONSTRAINT quotes_amount_check CHECK ((amount > 0))
);


--
-- Name: rate_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE rate_limits (
    key text NOT NULL,
    count integer DEFAULT 1 NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE roles (
    id text NOT NULL,
    name text NOT NULL,
    permissions jsonb NOT NULL,
    protected boolean DEFAULT false NOT NULL
);


--
-- Name: settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE settings (
    id integer NOT NULL,
    body jsonb NOT NULL,
    CONSTRAINT settings_id_check CHECK ((id = 1))
);


--
-- Name: twoFactor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "twoFactor" (
    id text NOT NULL,
    secret text NOT NULL,
    "backupCodes" text NOT NULL,
    "userId" text NOT NULL,
    verified boolean,
    "failedVerificationCount" integer,
    "lockedUntil" timestamp with time zone
);


--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE user_roles (
    user_id text NOT NULL,
    role_id text NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE users (
    id text NOT NULL,
    email text NOT NULL,
    role text DEFAULT 'user'::text NOT NULL,
    referral_code text NOT NULL,
    invited_by text,
    disabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    image text,
    two_factor_enabled boolean DEFAULT false,
    CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['user'::text, 'admin'::text])))
);


--
-- Name: wallet_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE wallet_ledger (
    id text NOT NULL,
    user_id text NOT NULL,
    amount integer NOT NULL,
    balance_after integer NOT NULL,
    kind text NOT NULL,
    order_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT wallet_ledger_amount_check CHECK ((amount <> 0)),
    CONSTRAINT wallet_ledger_balance_after_check CHECK ((balance_after >= 0)),
    CONSTRAINT wallet_ledger_kind_check CHECK ((kind = ANY (ARRAY['topup'::text, 'purchase'::text, 'refund'::text])))
);


--
-- Name: wallets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE wallets (
    user_id text NOT NULL,
    balance integer DEFAULT 0 NOT NULL,
    CONSTRAINT wallets_balance_check CHECK ((balance >= 0))
);


--
-- Name: withdrawals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE withdrawals (
    id text NOT NULL,
    user_id text NOT NULL,
    amount integer NOT NULL,
    method text NOT NULL,
    account text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    request_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    recipient_name text DEFAULT ''::text NOT NULL,
    network text,
    request_hash text DEFAULT ''::text NOT NULL,
    fee_amount integer DEFAULT 0 NOT NULL,
    fee_rate_bps integer DEFAULT 0 NOT NULL,
    fixed_fee integer DEFAULT 0 NOT NULL,
    payout_reference text DEFAULT ''::text NOT NULL,
    payout_amount numeric(20,6),
    reviewer_id text,
    reviewed_at timestamp with time zone,
    CONSTRAINT withdrawals_amount_check CHECK ((amount > 0)),
    CONSTRAINT withdrawals_check CHECK (((fee_amount >= 0) AND (fee_amount < amount))),
    CONSTRAINT withdrawals_fee_rate_bps_check CHECK (((fee_rate_bps >= 0) AND (fee_rate_bps < 10000))),
    CONSTRAINT withdrawals_fixed_fee_check CHECK ((fixed_fee >= 0)),
    CONSTRAINT withdrawals_network_check CHECK ((network = ANY (ARRAY['TRC20'::text, 'ERC20'::text, 'BSC'::text, 'Polygon'::text]))),
    CONSTRAINT withdrawals_payout_amount_check CHECK ((payout_amount > (0)::numeric)),
    CONSTRAINT withdrawals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'paid'::text, 'rejected'::text])))
);


--
-- Name: audit audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY audit
    ADD CONSTRAINT audit_pkey PRIMARY KEY (id);


--
-- Name: auth_account auth_account_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY auth_account
    ADD CONSTRAINT auth_account_pkey PRIMARY KEY (id);


--
-- Name: auth_account auth_account_registrationRecord_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY auth_account
    ADD CONSTRAINT "auth_account_registrationRecord_key" UNIQUE ("registrationRecord");


--
-- Name: auth_passkey auth_passkey_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY auth_passkey
    ADD CONSTRAINT auth_passkey_pkey PRIMARY KEY (id);


--
-- Name: auth_rate_limit auth_rate_limit_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY auth_rate_limit
    ADD CONSTRAINT auth_rate_limit_key_key UNIQUE (key);


--
-- Name: auth_rate_limit auth_rate_limit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY auth_rate_limit
    ADD CONSTRAINT auth_rate_limit_pkey PRIMARY KEY (id);


--
-- Name: auth_session auth_session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY auth_session
    ADD CONSTRAINT auth_session_pkey PRIMARY KEY (id);


--
-- Name: auth_session auth_session_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY auth_session
    ADD CONSTRAINT auth_session_token_key UNIQUE (token);


--
-- Name: auth_verification auth_verification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY auth_verification
    ADD CONSTRAINT auth_verification_pkey PRIMARY KEY (id);


--
-- Name: commissions commissions_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY commissions
    ADD CONSTRAINT commissions_order_id_key UNIQUE (order_id);


--
-- Name: commissions commissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY commissions
    ADD CONSTRAINT commissions_pkey PRIMARY KEY (id);


--
-- Name: demo_mailbox demo_mailbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY demo_mailbox
    ADD CONSTRAINT demo_mailbox_pkey PRIMARY KEY (browser_digest, email);


--
-- Name: email_outbox email_outbox_order_id_status_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY email_outbox
    ADD CONSTRAINT email_outbox_order_id_status_key UNIQUE (order_id, status);


--
-- Name: email_outbox email_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY email_outbox
    ADD CONSTRAINT email_outbox_pkey PRIMARY KEY (id);


--
-- Name: exchange_rates exchange_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY exchange_rates
    ADD CONSTRAINT exchange_rates_pkey PRIMARY KEY (id);


--
-- Name: funnel_events funnel_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY funnel_events
    ADD CONSTRAINT funnel_events_pkey PRIMARY KEY (id);


--
-- Name: integrations integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY integrations
    ADD CONSTRAINT integrations_pkey PRIMARY KEY (id);


--
-- Name: inventory inventory_fingerprint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY inventory
    ADD CONSTRAINT inventory_fingerprint_key UNIQUE (fingerprint);


--
-- Name: inventory inventory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY inventory
    ADD CONSTRAINT inventory_pkey PRIMARY KEY (id);


--
-- Name: jobs jobs_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY jobs
    ADD CONSTRAINT jobs_order_id_key UNIQUE (order_id);


--
-- Name: jobs jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);


--
-- Name: orders orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);


--
-- Name: orders orders_quote_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY orders
    ADD CONSTRAINT orders_quote_id_key UNIQUE (quote_id);


--
-- Name: payment_events payment_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY payment_events
    ADD CONSTRAINT payment_events_pkey PRIMARY KEY (provider, transaction_id);


--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);


--
-- Name: quotes quotes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY quotes
    ADD CONSTRAINT quotes_pkey PRIMARY KEY (id);


--
-- Name: rate_limits rate_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY rate_limits
    ADD CONSTRAINT rate_limits_pkey PRIMARY KEY (key);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: settings settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (id);


--
-- Name: twoFactor twoFactor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "twoFactor"
    ADD CONSTRAINT "twoFactor_pkey" PRIMARY KEY (id);


--
-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (user_id, role_id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_referral_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY users
    ADD CONSTRAINT users_referral_code_key UNIQUE (referral_code);


--
-- Name: wallet_ledger wallet_ledger_order_id_kind_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY wallet_ledger
    ADD CONSTRAINT wallet_ledger_order_id_kind_key UNIQUE (order_id, kind);


--
-- Name: wallet_ledger wallet_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY wallet_ledger
    ADD CONSTRAINT wallet_ledger_pkey PRIMARY KEY (id);


--
-- Name: wallets wallets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY wallets
    ADD CONSTRAINT wallets_pkey PRIMARY KEY (user_id);


--
-- Name: withdrawals withdrawals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY withdrawals
    ADD CONSTRAINT withdrawals_pkey PRIMARY KEY (id);


--
-- Name: withdrawals withdrawals_request_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY withdrawals
    ADD CONSTRAINT withdrawals_request_key_key UNIQUE (request_key);


--
-- Name: auth_account_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "auth_account_userId_idx" ON auth_account USING btree ("userId");


--
-- Name: auth_one_opaque_account; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX auth_one_opaque_account ON auth_account USING btree ("userId") WHERE ("providerId" = 'opaque'::text);


--
-- Name: auth_passkey_credentialID_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "auth_passkey_credentialID_idx" ON auth_passkey USING btree ("credentialID");


--
-- Name: auth_passkey_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "auth_passkey_userId_idx" ON auth_passkey USING btree ("userId");


--
-- Name: auth_session_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "auth_session_userId_idx" ON auth_session USING btree ("userId");


--
-- Name: auth_verification_identifier_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_verification_identifier_idx ON auth_verification USING btree (identifier);


--
-- Name: commissions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX commissions_user ON commissions USING btree (user_id);


--
-- Name: funnel_events_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX funnel_events_date ON funnel_events USING btree (created_at);


--
-- Name: integrations_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX integrations_active ON integrations USING btree (provider) WHERE (active = true);


--
-- Name: jobs_ready; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_ready ON jobs USING btree (run_at) WHERE (done = false);


--
-- Name: orders_buyer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_buyer ON orders USING btree (buyer_key) WHERE (kind = 'purchase'::text);


--
-- Name: orders_unclaimed_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_unclaimed_email ON orders USING btree (contact_email) WHERE (user_id IS NULL);


--
-- Name: orders_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_user ON orders USING btree (user_id, created_at DESC);


--
-- Name: twoFactor_secret_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "twoFactor_secret_idx" ON "twoFactor" USING btree (secret);


--
-- Name: twoFactor_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "twoFactor_userId_idx" ON "twoFactor" USING btree ("userId");


--
-- Name: wallet_ledger_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_ledger_user ON wallet_ledger USING btree (user_id, created_at DESC);


--
-- Name: withdrawals_payout_reference; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX withdrawals_payout_reference ON withdrawals USING btree (method, COALESCE(network, ''::text), payout_reference) WHERE (payout_reference <> ''::text);


--
-- Name: withdrawals_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX withdrawals_user ON withdrawals USING btree (user_id, created_at DESC);


--
-- Name: auth_passkey auth_last_passkey_removed; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_last_passkey_removed AFTER DELETE ON auth_passkey FOR EACH ROW EXECUTE FUNCTION auth_last_passkey_removed();


--
-- Name: auth_passkey auth_passkey_enable_mfa; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_passkey_enable_mfa AFTER INSERT ON auth_passkey FOR EACH ROW EXECUTE FUNCTION auth_passkey_enable_mfa();


--
-- Name: auth_passkey auth_passkey_owner_lock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_passkey_owner_lock BEFORE INSERT OR DELETE ON auth_passkey FOR EACH ROW EXECUTE FUNCTION auth_passkey_owner_lock();


--
-- Name: users auth_passkey_requires_mfa; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_passkey_requires_mfa BEFORE UPDATE OF two_factor_enabled ON users FOR EACH ROW EXECUTE FUNCTION auth_passkey_requires_mfa();


--
-- Name: orders order_email_outbox; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER order_email_outbox AFTER INSERT OR UPDATE OF status ON orders FOR EACH ROW EXECUTE FUNCTION enqueue_order_email();


--
-- Name: orders order_funnel; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER order_funnel AFTER INSERT OR UPDATE OF status ON orders FOR EACH ROW EXECUTE FUNCTION record_funnel_order();


--
-- Name: auth_account auth_account_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY auth_account
    ADD CONSTRAINT "auth_account_userId_fkey" FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE;


--
-- Name: auth_passkey auth_passkey_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY auth_passkey
    ADD CONSTRAINT "auth_passkey_userId_fkey" FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE;


--
-- Name: auth_session auth_session_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY auth_session
    ADD CONSTRAINT "auth_session_userId_fkey" FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE;


--
-- Name: commissions commissions_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY commissions
    ADD CONSTRAINT commissions_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id);


--
-- Name: commissions commissions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY commissions
    ADD CONSTRAINT commissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);


--
-- Name: email_outbox email_outbox_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY email_outbox
    ADD CONSTRAINT email_outbox_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id);


--
-- Name: inventory inventory_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY inventory
    ADD CONSTRAINT inventory_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id);


--
-- Name: jobs jobs_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY jobs
    ADD CONSTRAINT jobs_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id);


--
-- Name: orders orders_aicdk_integration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY orders
    ADD CONSTRAINT orders_aicdk_integration_id_fkey FOREIGN KEY (aicdk_integration_id) REFERENCES integrations(id);


--
-- Name: orders orders_integration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY orders
    ADD CONSTRAINT orders_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES integrations(id);


--
-- Name: orders orders_inviter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY orders
    ADD CONSTRAINT orders_inviter_id_fkey FOREIGN KEY (inviter_id) REFERENCES users(id);


--
-- Name: orders orders_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY orders
    ADD CONSTRAINT orders_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id);


--
-- Name: orders orders_quote_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY orders
    ADD CONSTRAINT orders_quote_id_fkey FOREIGN KEY (quote_id) REFERENCES quotes(id);


--
-- Name: orders orders_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY orders
    ADD CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);


--
-- Name: payment_events payment_events_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY payment_events
    ADD CONSTRAINT payment_events_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id);


--
-- Name: quotes quotes_aicdk_integration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY quotes
    ADD CONSTRAINT quotes_aicdk_integration_id_fkey FOREIGN KEY (aicdk_integration_id) REFERENCES integrations(id);


--
-- Name: quotes quotes_inventory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY quotes
    ADD CONSTRAINT quotes_inventory_id_fkey FOREIGN KEY (inventory_id) REFERENCES inventory(id);


--
-- Name: quotes quotes_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY quotes
    ADD CONSTRAINT quotes_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id);


--
-- Name: twoFactor twoFactor_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "twoFactor"
    ADD CONSTRAINT "twoFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE;


--
-- Name: user_roles user_roles_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY user_roles
    ADD CONSTRAINT user_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES roles(id);


--
-- Name: user_roles user_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY user_roles
    ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);


--
-- Name: users users_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY users
    ADD CONSTRAINT users_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES users(id);


--
-- Name: wallet_ledger wallet_ledger_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY wallet_ledger
    ADD CONSTRAINT wallet_ledger_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id);


--
-- Name: wallet_ledger wallet_ledger_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY wallet_ledger
    ADD CONSTRAINT wallet_ledger_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);


--
-- Name: wallets wallets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY wallets
    ADD CONSTRAINT wallets_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);


--
-- Name: withdrawals withdrawals_reviewer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY withdrawals
    ADD CONSTRAINT withdrawals_reviewer_id_fkey FOREIGN KEY (reviewer_id) REFERENCES users(id);


--
-- Name: withdrawals withdrawals_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY withdrawals
    ADD CONSTRAINT withdrawals_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);


--
-- PostgreSQL database dump complete
--
COMMIT;
