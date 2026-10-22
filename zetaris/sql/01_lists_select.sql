-- Row counts of the list tables in the file store.

-- @@ count_business_definition
SELECT COUNT(*) AS n FROM sanctions_lists.business_definition

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
