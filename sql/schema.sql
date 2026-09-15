-- Commerce Integration Core — PostgreSQL schema
-- Engine: PostgreSQL 16+. Internal PKs are UUIDs. External platform IDs are indexed text.
-- Sync columns: sync_status + error_log on every cross-platform automation table.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE sync_status AS ENUM ('pending', 'processing', 'completed', 'failed');
CREATE TYPE supplier_code AS ENUM ('zendrop', 'cj');
CREATE TYPE sales_channel AS ENUM ('shopify', 'tiktok_shop_us', 'walmart');
CREATE TYPE product_origin AS ENUM ('us_warehouse', 'overseas', 'unknown');
CREATE TYPE fulfillment_state AS ENUM (
  'received',
  'validated',
  'routed_to_supplier',
  'supplier_accepted',
  'awaiting_tracking',
  'tracking_uploaded',
  'in_transit',
  'delivered',
  'cancelled',
  'sla_breached',
  'failed'
);

-- ---------------------------------------------------------------------------
-- Suppliers
-- ---------------------------------------------------------------------------
CREATE TABLE suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code supplier_code NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  api_base_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO suppliers (code, display_name, api_base_url, notes) VALUES
  ('zendrop', 'Zendrop', 'https://app.zendrop.com/mcp/v1', 'MCP + native Shopify app. Filter Ships from US. Reject supplier name Zendrop Fulfillment (China).'),
  ('cj', 'CJ Dropshipping', 'https://developers.cjdropshipping.com', 'REST API v2. Filter countryCode=US and verified US warehouse stock only.');

-- ---------------------------------------------------------------------------
-- Canonical catalog
-- ---------------------------------------------------------------------------
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES suppliers (id),
  supplier_product_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  brand TEXT,
  category TEXT,
  origin product_origin NOT NULL DEFAULT 'unknown',
  ships_from_country CHAR(2) NOT NULL DEFAULT 'US',
  processing_days_min INTEGER NOT NULL DEFAULT 1,
  processing_days_max INTEGER NOT NULL DEFAULT 3,
  transit_days_min INTEGER NOT NULL DEFAULT 3,
  transit_days_max INTEGER NOT NULL DEFAULT 5,
  packaging_notes TEXT,
  competitor_branded_packaging BOOLEAN NOT NULL DEFAULT FALSE,
  gtin TEXT,
  images JSONB NOT NULL DEFAULT '[]'::JSONB,
  raw_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  is_listable BOOLEAN NOT NULL DEFAULT FALSE,
  listable_reason TEXT,
  tiktok_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  walmart_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  shopify_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  sync_status sync_status NOT NULL DEFAULT 'pending',
  error_log TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (supplier_id, supplier_product_id)
);

CREATE INDEX idx_products_supplier_ext ON products (supplier_product_id);
CREATE INDEX idx_products_origin_listable ON products (origin, is_listable);
CREATE INDEX idx_products_gtin ON products (gtin) WHERE gtin IS NOT NULL;
CREATE INDEX idx_products_sync_status ON products (sync_status);

CREATE TABLE product_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  supplier_variant_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  title TEXT,
  option_values JSONB NOT NULL DEFAULT '{}'::JSONB,
  cost_cents INTEGER NOT NULL,
  shipping_cents INTEGER NOT NULL DEFAULT 0,
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  weight_grams INTEGER,
  gtin TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, supplier_variant_id),
  UNIQUE (sku)
);

CREATE INDEX idx_product_variants_supplier_variant ON product_variants (supplier_variant_id);

-- Snapshot of supplier stock. Zendrop China catalog has no real counts; US SKUs may.
CREATE TABLE supplier_inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id UUID NOT NULL REFERENCES product_variants (id) ON DELETE CASCADE,
  warehouse_code TEXT NOT NULL,
  warehouse_country CHAR(2) NOT NULL,
  quantity_available INTEGER NOT NULL DEFAULT 0,
  quantity_reserved INTEGER NOT NULL DEFAULT 0,
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sync_status sync_status NOT NULL DEFAULT 'pending',
  error_log TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (variant_id, warehouse_code)
);

CREATE INDEX idx_supplier_inventory_warehouse ON supplier_inventory (warehouse_country, quantity_available);

-- Per-channel listing / offer (the "channel variant")
CREATE TABLE channel_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  variant_id UUID NOT NULL REFERENCES product_variants (id) ON DELETE CASCADE,
  channel sales_channel NOT NULL,
  external_product_id TEXT,
  external_variant_id TEXT,
  channel_sku TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  compare_at_cents INTEGER,
  listed_quantity INTEGER NOT NULL DEFAULT 0,
  listing_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  published_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ,
  sync_status sync_status NOT NULL DEFAULT 'pending',
  error_log TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (channel, channel_sku),
  UNIQUE (channel, variant_id)
);

CREATE INDEX idx_channel_listings_ext_product ON channel_listings (external_product_id);
CREATE INDEX idx_channel_listings_sync ON channel_listings (channel, sync_status);

-- ---------------------------------------------------------------------------
-- Orders and fulfillment
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel sales_channel NOT NULL,
  external_order_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  customer_name TEXT,
  customer_email TEXT,
  shipping_address JSONB NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  subtotal_cents INTEGER NOT NULL,
  shipping_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  fulfillment_state fulfillment_state NOT NULL DEFAULT 'received',
  supplier_id UUID REFERENCES suppliers (id),
  supplier_order_id TEXT,
  tracking_number TEXT,
  tracking_carrier TEXT,
  tracking_uploaded_at TIMESTAMPTZ,
  carrier_scan_at TIMESTAMPTZ,
  sla_deadline_at TIMESTAMPTZ,
  sla_breached_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  raw_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  sync_status sync_status NOT NULL DEFAULT 'pending',
  error_log TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (channel, external_order_id),
  UNIQUE (idempotency_key)
);

CREATE INDEX idx_orders_fulfillment_state ON orders (fulfillment_state);
CREATE INDEX idx_orders_sla_deadline ON orders (sla_deadline_at)
  WHERE fulfillment_state IN ('received', 'validated', 'routed_to_supplier', 'supplier_accepted', 'awaiting_tracking');
CREATE INDEX idx_orders_shopify ON orders (external_order_id) WHERE channel = 'shopify';
CREATE INDEX idx_orders_tiktok ON orders (external_order_id) WHERE channel = 'tiktok_shop_us';
CREATE INDEX idx_orders_walmart ON orders (external_order_id) WHERE channel = 'walmart';
CREATE INDEX idx_orders_supplier_order ON orders (supplier_order_id);

CREATE TABLE order_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  variant_id UUID REFERENCES product_variants (id),
  channel_listing_id UUID REFERENCES channel_listings (id),
  external_line_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  title TEXT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_id, external_line_id)
);

CREATE TABLE fulfillment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  from_state fulfillment_state,
  to_state fulfillment_state NOT NULL,
  source TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_fulfillment_events_order ON fulfillment_events (order_id, created_at);

-- Dedup inbound webhooks across restarts.
CREATE TABLE webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel TEXT NOT NULL,
  event_name TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  signature_valid BOOLEAN NOT NULL DEFAULT FALSE,
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  sync_status sync_status NOT NULL DEFAULT 'pending',
  error_log TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (channel, external_event_id)
);

CREATE TABLE sync_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  rows_seen INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  sync_status sync_status NOT NULL DEFAULT 'processing',
  error_log TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE sla_watches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  channel sales_channel NOT NULL,
  deadline_at TIMESTAMPTZ NOT NULL,
  escalate_at TIMESTAMPTZ NOT NULL,
  last_polled_at TIMESTAMPTZ,
  tracking_pushed_at TIMESTAMPTZ,
  alert_sent_at TIMESTAMPTZ,
  sync_status sync_status NOT NULL DEFAULT 'pending',
  error_log TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_id)
);

CREATE INDEX idx_sla_watches_open ON sla_watches (deadline_at)
  WHERE tracking_pushed_at IS NULL;

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'suppliers',
    'products',
    'product_variants',
    'supplier_inventory',
    'channel_listings',
    'orders',
    'order_line_items',
    'fulfillment_events',
    'webhook_events',
    'sync_jobs',
    'sla_watches'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      t, t
    );
  END LOOP;
END $$;
