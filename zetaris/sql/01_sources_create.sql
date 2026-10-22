-- Lightning databases and file-store tables for the sanctions desk.
-- Files are written to the Zetaris file store by `npm run zetaris:load-files`
-- (folder: sanctions) before these statements are run.
-- Each statement is one call; statements are separated by "-- @@ name" lines.

-- @@ db_lists
CREATE LIGHTNING DATABASE sanctions_lists DESCRIBE BY "Public sanctions list tables, sample subset"

-- @@ db_bank
CREATE LIGHTNING DATABASE sanctions_bank_files DESCRIBE BY "Synthetic bank sample, file copy"

-- @@ file_list_entry
CREATE LIGHTNING FILESTORE TABLE list_entry FROM sanctions_lists FORMAT JSON OPTIONS (path "dffs://sanctions/sanctions_lists/list_entry.json")

-- @@ file_list_alias
CREATE LIGHTNING FILESTORE TABLE list_alias FROM sanctions_lists FORMAT JSON OPTIONS (path "dffs://sanctions/sanctions_lists/list_alias.json")

-- @@ file_list_dob
CREATE LIGHTNING FILESTORE TABLE list_dob FROM sanctions_lists FORMAT JSON OPTIONS (path "dffs://sanctions/sanctions_lists/list_dob.json")

-- @@ file_list_country
CREATE LIGHTNING FILESTORE TABLE list_country FROM sanctions_lists FORMAT JSON OPTIONS (path "dffs://sanctions/sanctions_lists/list_country.json")

-- @@ file_list_identifier
CREATE LIGHTNING FILESTORE TABLE list_identifier FROM sanctions_lists FORMAT JSON OPTIONS (path "dffs://sanctions/sanctions_lists/list_identifier.json")

-- @@ file_customer
CREATE LIGHTNING FILESTORE TABLE customer FROM sanctions_bank_files FORMAT JSON OPTIONS (path "dffs://sanctions/sanctions_bank_files/customer.json")

-- @@ file_customer_identifier
CREATE LIGHTNING FILESTORE TABLE customer_identifier FROM sanctions_bank_files FORMAT JSON OPTIONS (path "dffs://sanctions/sanctions_bank_files/customer_identifier.json")

-- @@ file_alert
CREATE LIGHTNING FILESTORE TABLE alert FROM sanctions_bank_files FORMAT JSON OPTIONS (path "dffs://sanctions/sanctions_bank_files/alert.json")

-- @@ file_business_definition
CREATE LIGHTNING FILESTORE TABLE business_definition FROM sanctions_lists FORMAT JSON OPTIONS (path "dffs://sanctions/sanctions_lists/business_definition.json")
