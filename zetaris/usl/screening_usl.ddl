-- Unified Semantic Layer lightning.metastore.sanctions.screening_usl: 14 tables over three sources.
-- Generated from packages/zetaris/src/usl-spec.ts (npm run zetaris:generate). Deployed with
-- COMPILE USL IF NOT EXISTS screening_usl DEPLOY NAMESPACE lightning.metastore.sanctions DDL <the CREATE TABLE statements below>.
CREATE TABLE business_definition (
    definition_key varchar(64) NOT NULL PRIMARY KEY,
    definition_id varchar(64) NOT NULL,
    version varchar(8) NOT NULL,
    name varchar(200) NOT NULL,
    statement varchar(2000) NOT NULL,
    status varchar(16) NOT NULL,
    owner varchar(200),
    effective_from varchar(10)
);
CREATE TABLE list_entry (
    entry_id varchar(64) NOT NULL PRIMARY KEY,
    list_id varchar(8) NOT NULL,
    source_uid varchar(64) NOT NULL,
    party_kind varchar(16) NOT NULL,
    primary_name varchar(500) NOT NULL,
    primary_name_script varchar(16),
    name_normalised varchar(500),
    listed_on varchar(10),
    sanctions_list varchar(100),
    remarks varchar(4000),
    snapshot_id varchar(96) NOT NULL,
    content_hash varchar(64) NOT NULL
);
CREATE TABLE list_alias (
    alias_id varchar(64) NOT NULL PRIMARY KEY,
    entry_id varchar(64) NOT NULL FOREIGN KEY REFERENCES list_entry(entry_id),
    alias_name varchar(500) NOT NULL,
    alias_type varchar(16) NOT NULL,
    script varchar(16),
    name_normalised varchar(500),
    is_primary boolean,
    is_strong boolean
);
CREATE TABLE list_dob (
    dob_id varchar(64) NOT NULL PRIMARY KEY,
    entry_id varchar(64) NOT NULL FOREIGN KEY REFERENCES list_entry(entry_id),
    dob_value varchar(10),
    dob_precision varchar(8) NOT NULL,
    range_from varchar(10),
    range_to varchar(10),
    is_approximate boolean
);
CREATE TABLE list_country (
    country_link_id varchar(64) NOT NULL PRIMARY KEY,
    entry_id varchar(64) NOT NULL FOREIGN KEY REFERENCES list_entry(entry_id),
    country_iso2 varchar(2),
    country_name varchar(200),
    role varchar(24) NOT NULL,
    place varchar(300)
);
CREATE TABLE list_identifier (
    identifier_id varchar(64) NOT NULL PRIMARY KEY,
    entry_id varchar(64) NOT NULL FOREIGN KEY REFERENCES list_entry(entry_id),
    id_type varchar(24) NOT NULL,
    id_number varchar(200) NOT NULL,
    issuing_country varchar(2),
    note varchar(500)
);
CREATE TABLE customer (
    customer_id varchar(32) NOT NULL PRIMARY KEY,
    customer_type varchar(16) NOT NULL,
    full_name varchar(300) NOT NULL,
    date_of_birth varchar(10),
    nationality varchar(2),
    residence_country varchar(2) NOT NULL,
    onboarding_date varchar(10) NOT NULL,
    risk_rating varchar(8) NOT NULL,
    desk varchar(8) NOT NULL,
    notes varchar(500),
    data_origin varchar(16) NOT NULL
);
CREATE TABLE customer_identifier (
    identifier_id varchar(32) NOT NULL PRIMARY KEY,
    customer_id varchar(32) NOT NULL FOREIGN KEY REFERENCES customer(customer_id),
    id_type varchar(24) NOT NULL,
    id_number varchar(200) NOT NULL,
    issuing_country varchar(2)
);
CREATE TABLE customer_alias (
    alias_id varchar(32) NOT NULL PRIMARY KEY,
    customer_id varchar(32) NOT NULL FOREIGN KEY REFERENCES customer(customer_id),
    alias_name varchar(300) NOT NULL,
    alias_kind varchar(16) NOT NULL
);
CREATE TABLE account (
    account_id varchar(32) NOT NULL PRIMARY KEY,
    customer_id varchar(32) NOT NULL FOREIGN KEY REFERENCES customer(customer_id),
    account_type varchar(16) NOT NULL,
    currency varchar(3) NOT NULL,
    opened_on varchar(10) NOT NULL,
    status varchar(16) NOT NULL
);
CREATE TABLE beneficial_owner (
    ownership_id varchar(32) NOT NULL PRIMARY KEY,
    owned_party_id varchar(64) NOT NULL,
    owned_party_kind varchar(16) NOT NULL,
    owner_party_id varchar(64) NOT NULL,
    owner_party_kind varchar(16) NOT NULL,
    owner_name varchar(300) NOT NULL,
    ownership_pct decimal(5,2),
    as_of varchar(10) NOT NULL
);
CREATE TABLE payment (
    payment_id varchar(32) NOT NULL PRIMARY KEY,
    customer_id varchar(32) NOT NULL FOREIGN KEY REFERENCES customer(customer_id),
    account_id varchar(32) NOT NULL FOREIGN KEY REFERENCES account(account_id),
    direction varchar(8) NOT NULL,
    amount decimal(14,2) NOT NULL,
    currency varchar(3) NOT NULL,
    counterparty_name varchar(300) NOT NULL,
    counterparty_country varchar(2) NOT NULL,
    counterparty_bank_bic varchar(11),
    beneficiary_bank_country varchar(2),
    intermediary_bank_country varchar(2),
    payment_reference varchar(500),
    value_date varchar(10) NOT NULL,
    status varchar(16) NOT NULL
);
CREATE TABLE alert (
    alert_id varchar(32) NOT NULL PRIMARY KEY,
    alert_type varchar(16) NOT NULL,
    alert_source varchar(16) NOT NULL,
    customer_id varchar(32) NOT NULL FOREIGN KEY REFERENCES customer(customer_id),
    payment_id varchar(32) FOREIGN KEY REFERENCES payment(payment_id),
    list_id varchar(8) NOT NULL,
    entry_id varchar(64) NOT NULL FOREIGN KEY REFERENCES list_entry(entry_id),
    matched_name varchar(500) NOT NULL,
    match_score decimal(4,3),
    raised_at varchar(32) NOT NULL,
    status varchar(16) NOT NULL
);
CREATE TABLE disposition (
    disposition_id varchar(32) NOT NULL PRIMARY KEY,
    alert_id varchar(32) NOT NULL FOREIGN KEY REFERENCES alert(alert_id),
    customer_id varchar(32) NOT NULL FOREIGN KEY REFERENCES customer(customer_id),
    entry_id varchar(64) NOT NULL FOREIGN KEY REFERENCES list_entry(entry_id),
    decision varchar(24) NOT NULL,
    reason_codes varchar(200) NOT NULL,
    decided_at varchar(32) NOT NULL,
    decided_by varchar(100) NOT NULL,
    entry_content_hash varchar(64) NOT NULL,
    list_snapshot_id varchar(96) NOT NULL
)
