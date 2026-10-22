-- Fallback: binds the bank tables to the file copy instead of the database and the payments service.

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
    COALESCE(risk_rating, '') AS risk_rating,
    COALESCE(desk, '') AS desk,
    notes,
    COALESCE(data_origin, '') AS data_origin
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

-- @@ activate_customer_alias
ACTIVATE USL TABLE lightning.metastore.sanctions.screening_usl.customer_alias AS
SELECT
    COALESCE(alias_id, '') AS alias_id,
    COALESCE(customer_id, '') AS customer_id,
    COALESCE(alias_name, '') AS alias_name,
    COALESCE(alias_kind, '') AS alias_kind
FROM sanctions_bank_files.customer_alias

-- @@ activate_account
ACTIVATE USL TABLE lightning.metastore.sanctions.screening_usl.account AS
SELECT
    COALESCE(account_id, '') AS account_id,
    COALESCE(customer_id, '') AS customer_id,
    COALESCE(account_type, '') AS account_type,
    COALESCE(currency, '') AS currency,
    COALESCE(opened_on, '') AS opened_on,
    COALESCE(status, '') AS status
FROM sanctions_bank_files.account

-- @@ activate_beneficial_owner
ACTIVATE USL TABLE lightning.metastore.sanctions.screening_usl.beneficial_owner AS
SELECT
    COALESCE(ownership_id, '') AS ownership_id,
    COALESCE(owned_party_id, '') AS owned_party_id,
    COALESCE(owned_party_kind, '') AS owned_party_kind,
    COALESCE(owner_party_id, '') AS owner_party_id,
    COALESCE(owner_party_kind, '') AS owner_party_kind,
    COALESCE(owner_name, '') AS owner_name,
    CAST(ownership_pct AS DECIMAL(5,2)) AS ownership_pct,
    COALESCE(as_of, '') AS as_of
FROM sanctions_bank_files.beneficial_owner

-- @@ activate_payment
ACTIVATE USL TABLE lightning.metastore.sanctions.screening_usl.payment AS
SELECT
    COALESCE(payment_id, '') AS payment_id,
    COALESCE(customer_id, '') AS customer_id,
    COALESCE(account_id, '') AS account_id,
    COALESCE(direction, '') AS direction,
    COALESCE(CAST(amount AS DECIMAL(14,2)), 0) AS amount,
    COALESCE(currency, '') AS currency,
    COALESCE(counterparty_name, '') AS counterparty_name,
    COALESCE(counterparty_country, '') AS counterparty_country,
    counterparty_bank_bic,
    payment_reference,
    COALESCE(value_date, '') AS value_date,
    COALESCE(status, '') AS status
FROM sanctions_bank_files.payment

-- @@ activate_alert
ACTIVATE USL TABLE lightning.metastore.sanctions.screening_usl.alert AS
SELECT
    COALESCE(alert_id, '') AS alert_id,
    COALESCE(alert_type, '') AS alert_type,
    COALESCE(alert_source, '') AS alert_source,
    COALESCE(customer_id, '') AS customer_id,
    payment_id,
    COALESCE(list_id, '') AS list_id,
    COALESCE(entry_id, '') AS entry_id,
    COALESCE(matched_name, '') AS matched_name,
    CAST(match_score AS DECIMAL(4,3)) AS match_score,
    COALESCE(raised_at, '') AS raised_at,
    COALESCE(status, '') AS status
FROM sanctions_bank_files.alert

-- @@ activate_disposition
ACTIVATE USL TABLE lightning.metastore.sanctions.screening_usl.disposition AS
SELECT
    COALESCE(disposition_id, '') AS disposition_id,
    COALESCE(alert_id, '') AS alert_id,
    COALESCE(customer_id, '') AS customer_id,
    COALESCE(entry_id, '') AS entry_id,
    COALESCE(decision, '') AS decision,
    COALESCE(reason_codes, '') AS reason_codes,
    COALESCE(decided_at, '') AS decided_at,
    COALESCE(decided_by, '') AS decided_by,
    COALESCE(entry_content_hash, '') AS entry_content_hash,
    COALESCE(list_snapshot_id, '') AS list_snapshot_id
FROM sanctions_bank_files.disposition
