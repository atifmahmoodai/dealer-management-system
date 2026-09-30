-- Dealer management system schema. Money is integer cents; times are timestamptz.

CREATE TABLE branches (
  id      text PRIMARY KEY,
  name    text NOT NULL,
  address text NOT NULL DEFAULT '',
  phone   text NOT NULL DEFAULT ''
);

CREATE TABLE users (
  id            text PRIMARY KEY,
  email         text NOT NULL,
  name          text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin', 'manager', 'sales', 'service')),
  branch_id     text REFERENCES branches(id),
  password_hash text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  failed_logins integer NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE sessions (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip           text,
  user_agent   text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Gapless document numbers (deal invoices, service orders, service invoices), taken inside the
-- transaction that uses them, so a rolled-back transaction never burns a number.
CREATE TABLE counters (
  name  text PRIMARY KEY,
  value bigint NOT NULL
);

CREATE TABLE customers (
  id         text PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('person', 'company')),
  name       text NOT NULL,
  email      text,
  phone      text NOT NULL DEFAULT '',
  address    text NOT NULL DEFAULT '',
  notes      text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR phone <> '')
);
CREATE INDEX customers_name_idx ON customers (lower(name));
CREATE INDEX customers_email_idx ON customers (lower(email));

CREATE TABLE vehicles (
  id                  text PRIMARY KEY,
  stock_no            text NOT NULL,
  vin                 text NOT NULL DEFAULT '',
  year                integer NOT NULL,
  make                text NOT NULL,
  model               text NOT NULL,
  trim                text NOT NULL DEFAULT '',
  color               text NOT NULL DEFAULT '',
  mileage             integer NOT NULL CHECK (mileage >= 0),
  body                text NOT NULL,
  fuel                text NOT NULL,
  transmission        text NOT NULL,
  condition           text NOT NULL CHECK (condition IN ('New', 'Used')),
  branch_id           text NOT NULL REFERENCES branches(id),
  source              text NOT NULL,
  acquired_on         date NOT NULL,
  purchase_cost_cents bigint NOT NULL CHECK (purchase_cost_cents >= 0),
  list_price_cents    bigint NOT NULL CHECK (list_price_cents > 0),
  status              text NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock', 'reserved', 'sold')),
  sold_at             timestamptz,
  notes               text NOT NULL DEFAULT '',
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vehicles_stock_no_key ON vehicles (upper(stock_no));
-- The same car can come back later (bought, sold, traded in again), but never be in stock twice.
CREATE UNIQUE INDEX vehicles_vin_in_stock ON vehicles (vin) WHERE vin <> '' AND status <> 'sold';
CREATE INDEX vehicles_status_idx ON vehicles (status, branch_id);

-- Reconditioning, transport and other costs added to a stock vehicle after purchase.
CREATE TABLE vehicle_costs (
  id           text PRIMARY KEY,
  vehicle_id   text NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  description  text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  service_order_id text,
  at           timestamptz NOT NULL DEFAULT now(),
  user_id      text REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX vehicle_costs_vehicle_idx ON vehicle_costs (vehicle_id);

CREATE TABLE leads (
  id                text PRIMARY KEY,
  customer_id       text NOT NULL REFERENCES customers(id),
  vehicle_id        text REFERENCES vehicles(id) ON DELETE SET NULL,
  source            text NOT NULL,
  status            text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'appointment', 'negotiation', 'won', 'lost')),
  interest          text NOT NULL DEFAULT '',
  assigned_to       text REFERENCES users(id) ON DELETE SET NULL,
  next_follow_up_at timestamptz,
  lost_reason       text NOT NULL DEFAULT '',
  branch_id         text NOT NULL REFERENCES branches(id),
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  closed_at         timestamptz
);
CREATE INDEX leads_status_idx ON leads (status, next_follow_up_at);
CREATE INDEX leads_customer_idx ON leads (customer_id);

CREATE TABLE activities (
  id          text PRIMARY KEY,
  lead_id     text REFERENCES leads(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  user_id     text REFERENCES users(id) ON DELETE SET NULL,
  type        text NOT NULL,
  body        text NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activities_lead_idx ON activities (lead_id, at DESC);

CREATE TABLE deals (
  id             text PRIMARY KEY,
  number         text UNIQUE,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved', 'closed', 'cancelled')),
  customer_id    text NOT NULL REFERENCES customers(id),
  vehicle_id     text NOT NULL REFERENCES vehicles(id),
  lead_id        text REFERENCES leads(id) ON DELETE SET NULL,
  salesperson_id text REFERENCES users(id) ON DELETE SET NULL,
  branch_id      text NOT NULL REFERENCES branches(id),
  worksheet      jsonb NOT NULL,
  -- Frozen when the deal closes: what was sold, for how much, at what cost.
  totals         jsonb,
  vehicle_cost_cents bigint,
  gross          jsonb,
  trade_vehicle_id text REFERENCES vehicles(id),
  notes          text NOT NULL DEFAULT '',
  approved_by    text REFERENCES users(id) ON DELETE SET NULL,
  approved_at    timestamptz,
  version        integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  closed_at      timestamptz
);
-- A car can be sold once, and held for at most one deal in progress.
CREATE UNIQUE INDEX deals_one_live_per_vehicle ON deals (vehicle_id) WHERE status IN ('pending_approval', 'approved', 'closed');
CREATE INDEX deals_status_idx ON deals (status, closed_at DESC);

CREATE TABLE service_orders (
  id               text PRIMARY KEY,
  number           text NOT NULL UNIQUE,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'waiting_parts', 'done', 'closed', 'cancelled')),
  customer_id      text REFERENCES customers(id),
  stock_vehicle_id text REFERENCES vehicles(id),
  vehicle_desc     text NOT NULL DEFAULT '',
  plate            text NOT NULL DEFAULT '',
  mileage          integer,
  complaint        text NOT NULL,
  technician       text NOT NULL DEFAULT '',
  notes            text NOT NULL DEFAULT '',
  lines            jsonb NOT NULL DEFAULT '[]',
  subtotal_cents   bigint NOT NULL DEFAULT 0,
  tax_cents        bigint NOT NULL DEFAULT 0,
  total_cents      bigint NOT NULL DEFAULT 0,
  invoice_no       text UNIQUE,
  promised_at      timestamptz,
  branch_id        text NOT NULL REFERENCES branches(id),
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz,
  CHECK ((customer_id IS NULL) <> (stock_vehicle_id IS NULL))
);
CREATE INDEX service_orders_status_idx ON service_orders (status, created_at DESC);

CREATE TABLE documents (
  id          text PRIMARY KEY,
  entity      text NOT NULL CHECK (entity IN ('customer', 'vehicle', 'deal')),
  entity_id   text NOT NULL,
  filename    text NOT NULL,
  mime        text NOT NULL,
  size        integer NOT NULL,
  data        bytea NOT NULL,
  uploaded_by text REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_entity_idx ON documents (entity, entity_id);

CREATE TABLE audit_log (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  user_id   text REFERENCES users(id) ON DELETE SET NULL,
  action    text NOT NULL,
  entity    text NOT NULL,
  entity_id text,
  details   jsonb NOT NULL DEFAULT '{}',
  ip        text
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
