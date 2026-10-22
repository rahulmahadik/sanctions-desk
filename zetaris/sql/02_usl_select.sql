-- Checks for the semantic layer. Run after 02_usl_create.sql.

-- @@ list_model
SHOW NAMESPACES OR TABLES IN lightning.metastore.sanctions

-- @@ load_model
LOAD USL screening_usl NAMESPACE lightning.metastore.sanctions

-- @@ list_dq
LIST DQ USL lightning.metastore.sanctions.screening_usl

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

-- @@ count_alert
SELECT COUNT(*) AS n FROM lightning.metastore.sanctions.screening_usl.alert

-- @@ dq_customer
RUN DQ dob_present_for_individuals TABLE lightning.metastore.sanctions.screening_usl.customer

-- @@ dq_invalid_customer
SHOW DQ ALL INVALID TABLE lightning.metastore.sanctions.screening_usl.customer

-- @@ count_business_definition
SELECT COUNT(*) AS n FROM lightning.metastore.sanctions.screening_usl.business_definition
