-- Row counts through the semantic layer.

-- @@ count_business_definition
SELECT COUNT(*) AS n FROM lightning.metastore.sanctions.screening_usl.business_definition

-- @@ count_list_entry
SELECT COUNT(*) AS n FROM lightning.metastore.sanctions.screening_usl.list_entry

-- @@ count_list_alias
SELECT COUNT(*) AS n FROM lightning.metastore.sanctions.screening_usl.list_alias

-- @@ count_list_dob
SELECT COUNT(*) AS n FROM lightning.metastore.sanctions.screening_usl.list_dob

-- @@ count_list_country
SELECT COUNT(*) AS n FROM lightning.metastore.sanctions.screening_usl.list_country

-- @@ count_list_identifier
SELECT COUNT(*) AS n FROM lightning.metastore.sanctions.screening_usl.list_identifier

-- @@ count_customer
SELECT COUNT(*) AS n FROM lightning.metastore.sanctions.screening_usl.customer

-- @@ count_customer_identifier
SELECT COUNT(*) AS n FROM lightning.metastore.sanctions.screening_usl.customer_identifier

-- @@ count_customer_alias
SELECT COUNT(*) AS n FROM lightning.metastore.sanctions.screening_usl.customer_alias

-- @@ count_account
SELECT COUNT(*) AS n FROM lightning.metastore.sanctions.screening_usl.account

-- @@ count_beneficial_owner
SELECT COUNT(*) AS n FROM lightning.metastore.sanctions.screening_usl.beneficial_owner

-- @@ count_payment
SELECT COUNT(*) AS n FROM lightning.metastore.sanctions.screening_usl.payment

-- @@ count_alert
SELECT COUNT(*) AS n FROM lightning.metastore.sanctions.screening_usl.alert

-- @@ count_disposition
SELECT COUNT(*) AS n FROM lightning.metastore.sanctions.screening_usl.disposition
