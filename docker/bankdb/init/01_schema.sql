-- Schema of the synthetic bank database. Generated from the row definitions; do not edit by hand.
-- Every row is synthetic. Run `npm run bankdb:schema` after changing a row definition.

CREATE TABLE customer (
  customer_id text PRIMARY KEY,
  customer_type text NOT NULL,
  full_name text NOT NULL,
  date_of_birth text,
  nationality text,
  residence_country text NOT NULL,
  onboarding_date text NOT NULL,
  risk_rating text NOT NULL,
  desk text NOT NULL,
  notes text,
  data_origin text NOT NULL
);

CREATE TABLE customer_identifier (
  identifier_id text PRIMARY KEY,
  customer_id text NOT NULL REFERENCES customer(customer_id),
  id_type text NOT NULL,
  id_number text NOT NULL,
  issuing_country text
);

CREATE TABLE customer_alias (
  alias_id text PRIMARY KEY,
  customer_id text NOT NULL REFERENCES customer(customer_id),
  alias_name text NOT NULL,
  alias_kind text NOT NULL
);

CREATE TABLE account (
  account_id text PRIMARY KEY,
  customer_id text NOT NULL REFERENCES customer(customer_id),
  account_type text NOT NULL,
  currency text NOT NULL,
  opened_on text NOT NULL,
  status text NOT NULL
);

CREATE TABLE payment (
  payment_id text PRIMARY KEY,
  customer_id text NOT NULL REFERENCES customer(customer_id),
  account_id text NOT NULL REFERENCES account(account_id),
  direction text NOT NULL,
  amount numeric(14,2) NOT NULL,
  currency text NOT NULL,
  counterparty_name text NOT NULL,
  counterparty_country text NOT NULL,
  counterparty_bank_bic text,
  payment_reference text,
  value_date text NOT NULL,
  status text NOT NULL
);

CREATE TABLE beneficial_owner (
  ownership_id text PRIMARY KEY,
  owned_party_id text NOT NULL,
  owned_party_kind text NOT NULL,
  owner_party_id text NOT NULL,
  owner_party_kind text NOT NULL,
  owner_name text NOT NULL,
  ownership_pct numeric(5,2),
  as_of text NOT NULL
);

CREATE TABLE alert (
  alert_id text PRIMARY KEY,
  alert_type text NOT NULL,
  alert_source text NOT NULL,
  customer_id text NOT NULL REFERENCES customer(customer_id),
  payment_id text REFERENCES payment(payment_id),
  list_id text NOT NULL,
  entry_id text NOT NULL,
  matched_name text NOT NULL,
  match_score numeric(4,3) NOT NULL,
  raised_at text NOT NULL,
  status text NOT NULL
);

CREATE TABLE disposition (
  disposition_id text PRIMARY KEY,
  alert_id text NOT NULL REFERENCES alert(alert_id),
  customer_id text NOT NULL REFERENCES customer(customer_id),
  entry_id text NOT NULL,
  decision text NOT NULL,
  reason_codes text NOT NULL,
  decided_at text NOT NULL,
  decided_by text NOT NULL,
  entry_content_hash text NOT NULL,
  list_snapshot_id text NOT NULL
);
