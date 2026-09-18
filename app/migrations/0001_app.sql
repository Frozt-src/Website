-- Monolith application database: clients, memberships, services, invoices, payments.
-- Timestamps are Unix seconds. Money is integer cents. IDs are UUID text.
CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  billing_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  stripe_customer_id TEXT UNIQUE,
  external_source TEXT,
  external_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX clients_external ON clients(external_source, external_id) WHERE external_source IS NOT NULL;

CREATE TABLE memberships (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  email TEXT NOT NULL,
  clerk_user_id TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'revoked')),
  bound_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX memberships_client_email ON memberships(client_id, email);
CREATE UNIQUE INDEX memberships_client_user ON memberships(client_id, clerk_user_id) WHERE clerk_user_id IS NOT NULL;
CREATE INDEX memberships_user ON memberships(clerk_user_id);

CREATE TABLE services (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  started_at INTEGER,
  ended_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX services_client ON services(client_id, status);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('draft', 'open', 'processing', 'paid', 'void')),
  currency TEXT NOT NULL DEFAULT 'usd',
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  description TEXT NOT NULL,
  issued_at INTEGER,
  due_at INTEGER,
  paid_at INTEGER,
  voided_at INTEGER,
  external_source TEXT,
  external_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX invoices_client_status ON invoices(client_id, status);
CREATE UNIQUE INDEX invoices_external ON invoices(external_source, external_id) WHERE external_source IS NOT NULL;

CREATE TABLE invoice_items (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  position INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_cents INTEGER NOT NULL CHECK (unit_cents >= 0),
  amount_cents INTEGER NOT NULL CHECK (amount_cents = quantity * unit_cents)
);
CREATE UNIQUE INDEX invoice_items_position ON invoice_items(invoice_id, position);

CREATE TABLE payment_links (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER
);
CREATE UNIQUE INDEX payment_links_one_active ON payment_links(invoice_id) WHERE status = 'active';

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  payment_link_id TEXT REFERENCES payment_links(id),
  source TEXT NOT NULL CHECK (source IN ('payment_link', 'portal')),
  stripe_checkout_session_id TEXT NOT NULL UNIQUE,
  stripe_payment_intent_id TEXT UNIQUE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'usd',
  method TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'canceled')),
  session_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  succeeded_at INTEGER,
  failed_at INTEGER
);
CREATE INDEX payments_invoice ON payments(invoice_id, status);

CREATE TABLE payment_events (
  id TEXT PRIMARY KEY,
  stripe_event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  livemode INTEGER NOT NULL,
  payment_id TEXT REFERENCES payments(id),
  invoice_id TEXT REFERENCES invoices(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'ignored', 'unmatched', 'mismatch')),
  payload_json TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX payment_events_payment ON payment_events(payment_id);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system', 'client_user', 'staff', 'stripe')),
  actor_id TEXT,
  client_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  details_json TEXT
);
CREATE INDEX audit_events_client_time ON audit_events(client_id, occurred_at);

-- Reserved for the future staff/admin API (MONOLITH internal app). No Phase 1 code uses it.
CREATE TABLE staff_api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER
);
