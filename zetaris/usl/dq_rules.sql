-- Data-quality rules registered on the model (full country lists shortened here; the executable script is zetaris/sql/07_dq_create.sql).
-- Data-quality rules, registered after the tables are active. Foreign keys already generate their own rules.

-- @@ dq_dob_present_for_individuals
REGISTER DQ dob_present_for_individuals TABLE lightning.metastore.sanctions.screening_usl.customer AS
customer_type <> 'individual' OR (date_of_birth IS NOT NULL AND date_of_birth <> '')

-- @@ dq_nationality_is_iso2
REGISTER DQ nationality_is_iso2 TABLE lightning.metastore.sanctions.screening_usl.customer AS
nationality IS NULL OR nationality IN (<ISO 3166-1 alpha-2 codes>)

-- @@ dq_ownership_pct_in_range
REGISTER DQ ownership_pct_in_range TABLE lightning.metastore.sanctions.screening_usl.beneficial_owner AS
ownership_pct IS NULL OR (ownership_pct >= 0 AND ownership_pct <= 100)

-- @@ dq_ownership_pct_present
REGISTER DQ ownership_pct_present TABLE lightning.metastore.sanctions.screening_usl.beneficial_owner AS
ownership_pct IS NOT NULL

-- @@ dq_payment_amount_positive
REGISTER DQ payment_amount_positive TABLE lightning.metastore.sanctions.screening_usl.payment AS
amount > 0

-- @@ dq_counterparty_country_valid
REGISTER DQ counterparty_country_valid TABLE lightning.metastore.sanctions.screening_usl.payment AS
counterparty_country IN (<ISO 3166-1 alpha-2 codes>)

-- @@ dq_payment_bank_countries_valid
REGISTER DQ payment_bank_countries_valid TABLE lightning.metastore.sanctions.screening_usl.payment AS
(beneficiary_bank_country IS NULL OR beneficiary_bank_country IN (<ISO 3166-1 alpha-2 codes>)) AND (intermediary_bank_country IS NULL OR intermediary_bank_country IN (<ISO 3166-1 alpha-2 codes>))

-- @@ dq_match_score_in_range
REGISTER DQ match_score_in_range TABLE lightning.metastore.sanctions.screening_usl.alert AS
match_score >= 0 AND match_score <= 1
