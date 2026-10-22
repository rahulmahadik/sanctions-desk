-- Row counts of the file-store tables. Run after 01_sources_create.sql.

-- @@ count_list_entry
SELECT COUNT(*) AS n FROM sanctions_lists.list_entry

-- @@ count_list_alias
SELECT COUNT(*) AS n FROM sanctions_lists.list_alias

-- @@ count_list_dob
SELECT COUNT(*) AS n FROM sanctions_lists.list_dob

-- @@ count_list_country
SELECT COUNT(*) AS n FROM sanctions_lists.list_country

-- @@ count_list_identifier
SELECT COUNT(*) AS n FROM sanctions_lists.list_identifier

-- @@ count_customer
SELECT COUNT(*) AS n FROM sanctions_bank_files.customer

-- @@ count_customer_identifier
SELECT COUNT(*) AS n FROM sanctions_bank_files.customer_identifier

-- @@ count_alert
SELECT COUNT(*) AS n FROM sanctions_bank_files.alert
