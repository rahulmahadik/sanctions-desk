-- Semantic layer for the sanctions desk: namespace lightning.metastore.sanctions, model screening_usl.
-- Agents read only these tables. Foreign keys generate data-quality rules; more rules are registered below.
-- The multi-table COMPILE statement is one call.

-- @@ ns_metastore
CREATE NAMESPACE IF NOT EXISTS lightning.metastore

-- @@ ns_sanctions
CREATE NAMESPACE IF NOT EXISTS lightning.metastore.sanctions

-- @@ compile_model
COMPILE USL IF NOT EXISTS screening_usl DEPLOY NAMESPACE lightning.metastore.sanctions DDL
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
    snapshot_id varchar(64) NOT NULL,
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
    risk_rating varchar(8),
    desk varchar(8),
    data_origin varchar(16)
);
CREATE TABLE customer_identifier (
    identifier_id varchar(32) NOT NULL PRIMARY KEY,
    customer_id varchar(32) NOT NULL FOREIGN KEY REFERENCES customer(customer_id),
    id_type varchar(24) NOT NULL,
    id_number varchar(200) NOT NULL,
    issuing_country varchar(2)
);
CREATE TABLE alert (
    alert_id varchar(32) NOT NULL PRIMARY KEY,
    alert_type varchar(16) NOT NULL,
    customer_id varchar(32) NOT NULL FOREIGN KEY REFERENCES customer(customer_id),
    payment_id varchar(32),
    list_id varchar(8) NOT NULL,
    entry_id varchar(64) NOT NULL FOREIGN KEY REFERENCES list_entry(entry_id),
    matched_name varchar(500) NOT NULL,
    match_score decimal(4,3),
    raised_at varchar(32) NOT NULL,
    status varchar(16) NOT NULL
)

-- @@ describe_model
UPDATE USL lightning.metastore.sanctions.screening_usl SET DESCRIPTION Screening model: public sanctions lists, bank customers and screening alerts. Synthetic bank data only.

-- @@ describe_list_entry
UPDATE USL lightning.metastore.sanctions.screening_usl.list_entry SET TABLE DESCRIPTION One row per listed party (person, company, vessel or aircraft) from a public sanctions list snapshot.

-- @@ describe_list_entry_entry_id
UPDATE USL lightning.metastore.sanctions.screening_usl.list_entry.entry_id SET COLUMN DESCRIPTION Stable id of the listed party, prefixed with the list (OFAC- or UN-).

-- @@ describe_list_entry_list_id
UPDATE USL lightning.metastore.sanctions.screening_usl.list_entry.list_id SET COLUMN DESCRIPTION Which list the entry comes from: OFAC or UN.

-- @@ describe_list_entry_source_uid
UPDATE USL lightning.metastore.sanctions.screening_usl.list_entry.source_uid SET COLUMN DESCRIPTION The id used by the publisher of the list.

-- @@ describe_list_entry_party_kind
UPDATE USL lightning.metastore.sanctions.screening_usl.list_entry.party_kind SET COLUMN DESCRIPTION individual, entity, vessel, aircraft or other.

-- @@ describe_list_entry_primary_name
UPDATE USL lightning.metastore.sanctions.screening_usl.list_entry.primary_name SET COLUMN DESCRIPTION The primary name as published.

-- @@ describe_list_entry_primary_name_script
UPDATE USL lightning.metastore.sanctions.screening_usl.list_entry.primary_name_script SET COLUMN DESCRIPTION Writing system of the primary name, for example Latin or Cyrillic.

-- @@ describe_list_entry_name_normalised
UPDATE USL lightning.metastore.sanctions.screening_usl.list_entry.name_normalised SET COLUMN DESCRIPTION Lower-case, accent-free form of the primary name used for matching.

-- @@ describe_list_entry_listed_on
UPDATE USL lightning.metastore.sanctions.screening_usl.list_entry.listed_on SET COLUMN DESCRIPTION Date the party was listed (YYYY-MM-DD), when published.

-- @@ describe_list_entry_sanctions_list
UPDATE USL lightning.metastore.sanctions.screening_usl.list_entry.sanctions_list SET COLUMN DESCRIPTION Name of the list or programme group, for example SDN List.

-- @@ describe_list_entry_remarks
UPDATE USL lightning.metastore.sanctions.screening_usl.list_entry.remarks SET COLUMN DESCRIPTION Free-text remarks published with the entry.

-- @@ describe_list_entry_snapshot_id
UPDATE USL lightning.metastore.sanctions.screening_usl.list_entry.snapshot_id SET COLUMN DESCRIPTION Snapshot of the list this row was read from.

-- @@ describe_list_entry_content_hash
UPDATE USL lightning.metastore.sanctions.screening_usl.list_entry.content_hash SET COLUMN DESCRIPTION SHA-256 of the entry content. A change means the entry changed.

-- @@ describe_list_alias
UPDATE USL lightning.metastore.sanctions.screening_usl.list_alias SET TABLE DESCRIPTION Alternative names of a listed party, including other spellings and scripts.

-- @@ describe_list_alias_alias_id
UPDATE USL lightning.metastore.sanctions.screening_usl.list_alias.alias_id SET COLUMN DESCRIPTION Stable id of the alias.

-- @@ describe_list_alias_entry_id
UPDATE USL lightning.metastore.sanctions.screening_usl.list_alias.entry_id SET COLUMN DESCRIPTION The listed party the alias belongs to.

-- @@ describe_list_alias_alias_name
UPDATE USL lightning.metastore.sanctions.screening_usl.list_alias.alias_name SET COLUMN DESCRIPTION The alias as published.

-- @@ describe_list_alias_alias_type
UPDATE USL lightning.metastore.sanctions.screening_usl.list_alias.alias_type SET COLUMN DESCRIPTION primary, aka, fka, nka or low_quality.

-- @@ describe_list_alias_script
UPDATE USL lightning.metastore.sanctions.screening_usl.list_alias.script SET COLUMN DESCRIPTION Writing system of the alias.

-- @@ describe_list_alias_name_normalised
UPDATE USL lightning.metastore.sanctions.screening_usl.list_alias.name_normalised SET COLUMN DESCRIPTION Lower-case, accent-free form used for matching.

-- @@ describe_list_alias_is_primary
UPDATE USL lightning.metastore.sanctions.screening_usl.list_alias.is_primary SET COLUMN DESCRIPTION True for the primary name.

-- @@ describe_list_alias_is_strong
UPDATE USL lightning.metastore.sanctions.screening_usl.list_alias.is_strong SET COLUMN DESCRIPTION False for low-quality aliases, which are weak evidence.

-- @@ describe_list_dob
UPDATE USL lightning.metastore.sanctions.screening_usl.list_dob SET TABLE DESCRIPTION Dates of birth of a listed individual. Many are partial (year or month) or a range.

-- @@ describe_list_dob_dob_id
UPDATE USL lightning.metastore.sanctions.screening_usl.list_dob.dob_id SET COLUMN DESCRIPTION Stable id of the date-of-birth row.

-- @@ describe_list_dob_entry_id
UPDATE USL lightning.metastore.sanctions.screening_usl.list_dob.entry_id SET COLUMN DESCRIPTION The listed party.

-- @@ describe_list_dob_dob_value
UPDATE USL lightning.metastore.sanctions.screening_usl.list_dob.dob_value SET COLUMN DESCRIPTION YYYY, YYYY-MM or YYYY-MM-DD; empty for a range.

-- @@ describe_list_dob_dob_precision
UPDATE USL lightning.metastore.sanctions.screening_usl.list_dob.dob_precision SET COLUMN DESCRIPTION day, month, year or range.

-- @@ describe_list_dob_range_from
UPDATE USL lightning.metastore.sanctions.screening_usl.list_dob.range_from SET COLUMN DESCRIPTION First possible day when the date is a range.

-- @@ describe_list_dob_range_to
UPDATE USL lightning.metastore.sanctions.screening_usl.list_dob.range_to SET COLUMN DESCRIPTION Last possible day when the date is a range.

-- @@ describe_list_dob_is_approximate
UPDATE USL lightning.metastore.sanctions.screening_usl.list_dob.is_approximate SET COLUMN DESCRIPTION True when the list marks the date as approximate.

-- @@ describe_list_country
UPDATE USL lightning.metastore.sanctions.screening_usl.list_country SET TABLE DESCRIPTION Countries linked to a listed party, with the role of the link.

-- @@ describe_list_country_country_link_id
UPDATE USL lightning.metastore.sanctions.screening_usl.list_country.country_link_id SET COLUMN DESCRIPTION Stable id of the link.

-- @@ describe_list_country_entry_id
UPDATE USL lightning.metastore.sanctions.screening_usl.list_country.entry_id SET COLUMN DESCRIPTION The listed party.

-- @@ describe_list_country_country_iso2
UPDATE USL lightning.metastore.sanctions.screening_usl.list_country.country_iso2 SET COLUMN DESCRIPTION ISO 3166-1 alpha-2 code, when known.

-- @@ describe_list_country_country_name
UPDATE USL lightning.metastore.sanctions.screening_usl.list_country.country_name SET COLUMN DESCRIPTION Country name as published.

-- @@ describe_list_country_role
UPDATE USL lightning.metastore.sanctions.screening_usl.list_country.role SET COLUMN DESCRIPTION nationality, citizenship, registered_in, address, place_of_birth or other.

-- @@ describe_list_country_place
UPDATE USL lightning.metastore.sanctions.screening_usl.list_country.place SET COLUMN DESCRIPTION City or place text, when published.

-- @@ describe_list_identifier
UPDATE USL lightning.metastore.sanctions.screening_usl.list_identifier SET TABLE DESCRIPTION Identity documents and registration numbers published for a listed party.

-- @@ describe_list_identifier_identifier_id
UPDATE USL lightning.metastore.sanctions.screening_usl.list_identifier.identifier_id SET COLUMN DESCRIPTION Stable id of the identifier.

-- @@ describe_list_identifier_entry_id
UPDATE USL lightning.metastore.sanctions.screening_usl.list_identifier.entry_id SET COLUMN DESCRIPTION The listed party.

-- @@ describe_list_identifier_id_type
UPDATE USL lightning.metastore.sanctions.screening_usl.list_identifier.id_type SET COLUMN DESCRIPTION passport, national_id, tax_id, registration and similar.

-- @@ describe_list_identifier_id_number
UPDATE USL lightning.metastore.sanctions.screening_usl.list_identifier.id_number SET COLUMN DESCRIPTION The document or registration number as published.

-- @@ describe_list_identifier_issuing_country
UPDATE USL lightning.metastore.sanctions.screening_usl.list_identifier.issuing_country SET COLUMN DESCRIPTION ISO 3166-1 alpha-2 code of the issuing country, when known.

-- @@ describe_list_identifier_note
UPDATE USL lightning.metastore.sanctions.screening_usl.list_identifier.note SET COLUMN DESCRIPTION Note published with the identifier.

-- @@ describe_customer
UPDATE USL lightning.metastore.sanctions.screening_usl.customer SET TABLE DESCRIPTION Synthetic bank customers (people and companies). Not real customers.

-- @@ describe_customer_customer_id
UPDATE USL lightning.metastore.sanctions.screening_usl.customer.customer_id SET COLUMN DESCRIPTION Customer id.

-- @@ describe_customer_customer_type
UPDATE USL lightning.metastore.sanctions.screening_usl.customer.customer_type SET COLUMN DESCRIPTION individual or company.

-- @@ describe_customer_full_name
UPDATE USL lightning.metastore.sanctions.screening_usl.customer.full_name SET COLUMN DESCRIPTION Name on file.

-- @@ describe_customer_date_of_birth
UPDATE USL lightning.metastore.sanctions.screening_usl.customer.date_of_birth SET COLUMN DESCRIPTION YYYY, YYYY-MM or YYYY-MM-DD; empty when not on file. Individuals only.

-- @@ describe_customer_nationality
UPDATE USL lightning.metastore.sanctions.screening_usl.customer.nationality SET COLUMN DESCRIPTION ISO 3166-1 alpha-2 nationality or country of registration.

-- @@ describe_customer_residence_country
UPDATE USL lightning.metastore.sanctions.screening_usl.customer.residence_country SET COLUMN DESCRIPTION ISO 3166-1 alpha-2 country of residence or operation.

-- @@ describe_customer_onboarding_date
UPDATE USL lightning.metastore.sanctions.screening_usl.customer.onboarding_date SET COLUMN DESCRIPTION Date the customer was onboarded (YYYY-MM-DD).

-- @@ describe_customer_risk_rating
UPDATE USL lightning.metastore.sanctions.screening_usl.customer.risk_rating SET COLUMN DESCRIPTION low, medium or high.

-- @@ describe_customer_desk
UPDATE USL lightning.metastore.sanctions.screening_usl.customer.desk SET COLUMN DESCRIPTION Operations desk: EMEA, APAC or AMER.

-- @@ describe_customer_data_origin
UPDATE USL lightning.metastore.sanctions.screening_usl.customer.data_origin SET COLUMN DESCRIPTION Always synthetic.

-- @@ describe_customer_identifier
UPDATE USL lightning.metastore.sanctions.screening_usl.customer_identifier SET TABLE DESCRIPTION Identity documents on file for a synthetic customer. Masked for the evidence agent.

-- @@ describe_customer_identifier_identifier_id
UPDATE USL lightning.metastore.sanctions.screening_usl.customer_identifier.identifier_id SET COLUMN DESCRIPTION Identifier id.

-- @@ describe_customer_identifier_customer_id
UPDATE USL lightning.metastore.sanctions.screening_usl.customer_identifier.customer_id SET COLUMN DESCRIPTION The customer.

-- @@ describe_customer_identifier_id_type
UPDATE USL lightning.metastore.sanctions.screening_usl.customer_identifier.id_type SET COLUMN DESCRIPTION passport, national_id, tax_id or registration.

-- @@ describe_customer_identifier_id_number
UPDATE USL lightning.metastore.sanctions.screening_usl.customer_identifier.id_number SET COLUMN DESCRIPTION The number on the document (sensitive).

-- @@ describe_customer_identifier_issuing_country
UPDATE USL lightning.metastore.sanctions.screening_usl.customer_identifier.issuing_country SET COLUMN DESCRIPTION ISO 3166-1 alpha-2 issuing country.

-- @@ describe_alert
UPDATE USL lightning.metastore.sanctions.screening_usl.alert SET TABLE DESCRIPTION Screening alerts: a customer matched a listed party by name. Each needs a human-reviewed decision.

-- @@ describe_alert_alert_id
UPDATE USL lightning.metastore.sanctions.screening_usl.alert.alert_id SET COLUMN DESCRIPTION Alert id.

-- @@ describe_alert_alert_type
UPDATE USL lightning.metastore.sanctions.screening_usl.alert.alert_type SET COLUMN DESCRIPTION customer or payment.

-- @@ describe_alert_customer_id
UPDATE USL lightning.metastore.sanctions.screening_usl.alert.customer_id SET COLUMN DESCRIPTION The customer the alert is about.

-- @@ describe_alert_payment_id
UPDATE USL lightning.metastore.sanctions.screening_usl.alert.payment_id SET COLUMN DESCRIPTION The payment, for payment alerts.

-- @@ describe_alert_list_id
UPDATE USL lightning.metastore.sanctions.screening_usl.alert.list_id SET COLUMN DESCRIPTION The list that matched.

-- @@ describe_alert_entry_id
UPDATE USL lightning.metastore.sanctions.screening_usl.alert.entry_id SET COLUMN DESCRIPTION The listed party that matched.

-- @@ describe_alert_matched_name
UPDATE USL lightning.metastore.sanctions.screening_usl.alert.matched_name SET COLUMN DESCRIPTION The listed name that matched.

-- @@ describe_alert_match_score
UPDATE USL lightning.metastore.sanctions.screening_usl.alert.match_score SET COLUMN DESCRIPTION Name similarity from the screening engine, 0 to 1.

-- @@ describe_alert_raised_at
UPDATE USL lightning.metastore.sanctions.screening_usl.alert.raised_at SET COLUMN DESCRIPTION When the alert was raised (UTC).

-- @@ describe_alert_status
UPDATE USL lightning.metastore.sanctions.screening_usl.alert.status SET COLUMN DESCRIPTION open, closed or escalated.

-- @@ describe_business_definition
UPDATE USL lightning.metastore.sanctions.screening_usl.business_definition SET TABLE DESCRIPTION Approved, versioned wording of the terms the desk applies. Each decision cites the definitions it used by id and version.

-- @@ describe_business_definition_definition_key
UPDATE USL lightning.metastore.sanctions.screening_usl.business_definition.definition_key SET COLUMN DESCRIPTION Stable key of the definition, id@version.

-- @@ describe_business_definition_definition_id
UPDATE USL lightning.metastore.sanctions.screening_usl.business_definition.definition_id SET COLUMN DESCRIPTION Name of the term, for example true_match.

-- @@ describe_business_definition_version
UPDATE USL lightning.metastore.sanctions.screening_usl.business_definition.version SET COLUMN DESCRIPTION Version number of the wording. A change of wording is a new version.

-- @@ describe_business_definition_name
UPDATE USL lightning.metastore.sanctions.screening_usl.business_definition.name SET COLUMN DESCRIPTION Display name of the term.

-- @@ describe_business_definition_statement
UPDATE USL lightning.metastore.sanctions.screening_usl.business_definition.statement SET COLUMN DESCRIPTION The approved wording of the definition.

-- @@ describe_business_definition_status
UPDATE USL lightning.metastore.sanctions.screening_usl.business_definition.status SET COLUMN DESCRIPTION draft, approved or retired.

-- @@ describe_business_definition_owner
UPDATE USL lightning.metastore.sanctions.screening_usl.business_definition.owner SET COLUMN DESCRIPTION Who owns and approves the definition.

-- @@ describe_business_definition_effective_from
UPDATE USL lightning.metastore.sanctions.screening_usl.business_definition.effective_from SET COLUMN DESCRIPTION Date the version applies from (YYYY-MM-DD).

-- @@ activate_business_definition
ACTIVATE USL TABLE lightning.metastore.sanctions.screening_usl.business_definition AS
SELECT
    COALESCE(definition_key, '') AS definition_key,
    COALESCE(definition_id, '') AS definition_id,
    COALESCE(version, '') AS version,
    COALESCE(name, '') AS name,
    COALESCE(statement, '') AS statement,
    COALESCE(status, '') AS status,
    owner,
    effective_from
FROM sanctions_lists.business_definition

-- @@ activate_list_entry
ACTIVATE USL TABLE lightning.metastore.sanctions.screening_usl.list_entry AS
SELECT
    COALESCE(entry_id, '') AS entry_id,
    COALESCE(list_id, '') AS list_id,
    COALESCE(source_uid, '') AS source_uid,
    COALESCE(party_kind, '') AS party_kind,
    COALESCE(primary_name, '') AS primary_name,
    primary_name_script,
    name_normalised,
    listed_on,
    sanctions_list,
    remarks,
    COALESCE(snapshot_id, '') AS snapshot_id,
    COALESCE(content_hash, '') AS content_hash
FROM sanctions_lists.list_entry

-- @@ activate_list_alias
ACTIVATE USL TABLE lightning.metastore.sanctions.screening_usl.list_alias AS
SELECT
    COALESCE(alias_id, '') AS alias_id,
    COALESCE(entry_id, '') AS entry_id,
    COALESCE(alias_name, '') AS alias_name,
    COALESCE(alias_type, '') AS alias_type,
    script,
    name_normalised,
    CAST(is_primary AS BOOLEAN) AS is_primary,
    CAST(is_strong AS BOOLEAN) AS is_strong
FROM sanctions_lists.list_alias

-- @@ activate_list_dob
ACTIVATE USL TABLE lightning.metastore.sanctions.screening_usl.list_dob AS
SELECT
    COALESCE(dob_id, '') AS dob_id,
    COALESCE(entry_id, '') AS entry_id,
    dob_value,
    COALESCE(dob_precision, '') AS dob_precision,
    range_from,
    range_to,
    CAST(is_approximate AS BOOLEAN) AS is_approximate
FROM sanctions_lists.list_dob

-- @@ activate_list_country
ACTIVATE USL TABLE lightning.metastore.sanctions.screening_usl.list_country AS
SELECT
    COALESCE(country_link_id, '') AS country_link_id,
    COALESCE(entry_id, '') AS entry_id,
    country_iso2,
    country_name,
    COALESCE(role, '') AS role,
    place
FROM sanctions_lists.list_country

-- @@ activate_list_identifier
ACTIVATE USL TABLE lightning.metastore.sanctions.screening_usl.list_identifier AS
SELECT
    COALESCE(identifier_id, '') AS identifier_id,
    COALESCE(entry_id, '') AS entry_id,
    COALESCE(id_type, '') AS id_type,
    COALESCE(id_number, '') AS id_number,
    issuing_country,
    note
FROM sanctions_lists.list_identifier

-- @@ activate_customer
ACTIVATE USL TABLE lightning.metastore.sanctions.screening_usl.customer AS
SELECT
    COALESCE(customer_id, '') AS customer_id,
    COALESCE(customer_type, '') AS customer_type,
    COALESCE(full_name, '') AS full_name,
    date_of_birth,
    nationality,
    COALESCE(residence_country, '') AS residence_country,
    COALESCE(onboarding_date, '') AS onboarding_date,
    risk_rating,
    desk,
    data_origin
FROM sanctions_bank_files.customer

-- @@ activate_customer_identifier
ACTIVATE USL TABLE lightning.metastore.sanctions.screening_usl.customer_identifier AS
SELECT
    COALESCE(identifier_id, '') AS identifier_id,
    COALESCE(customer_id, '') AS customer_id,
    COALESCE(id_type, '') AS id_type,
    COALESCE(id_number, '') AS id_number,
    issuing_country
FROM sanctions_bank_files.customer_identifier

-- @@ activate_alert
ACTIVATE USL TABLE lightning.metastore.sanctions.screening_usl.alert AS
SELECT
    COALESCE(alert_id, '') AS alert_id,
    COALESCE(alert_type, '') AS alert_type,
    COALESCE(customer_id, '') AS customer_id,
    payment_id,
    COALESCE(list_id, '') AS list_id,
    COALESCE(entry_id, '') AS entry_id,
    COALESCE(matched_name, '') AS matched_name,
    CAST(match_score AS DECIMAL(4,3)) AS match_score,
    COALESCE(raised_at, '') AS raised_at,
    COALESCE(status, '') AS status
FROM sanctions_bank_files.alert

-- @@ dq_dob_for_individuals
REGISTER DQ dob_present_for_individuals TABLE lightning.metastore.sanctions.screening_usl.customer AS
customer_type <> 'individual' OR (date_of_birth IS NOT NULL AND date_of_birth <> '')

-- @@ dq_nationality_iso2
REGISTER DQ nationality_is_iso2 TABLE lightning.metastore.sanctions.screening_usl.customer AS
nationality IS NULL OR nationality RLIKE '^[A-Z]{2}$'

-- @@ dq_match_score_range
REGISTER DQ match_score_in_range TABLE lightning.metastore.sanctions.screening_usl.alert AS
match_score >= 0 AND match_score <= 1
