-- Public list tables and the approved business definitions, read from the Zetaris file store.
-- Files are written there by `npm run zetaris:load-files` (folder: sanctions) before this script runs.

-- @@ db_lists
CREATE LIGHTNING DATABASE sanctions_lists DESCRIBE BY "Public sanctions list tables, sample subset"

-- @@ file_business_definition
CREATE LIGHTNING FILESTORE TABLE business_definition FROM sanctions_lists FORMAT JSON OPTIONS (path "dffs://sanctions/sanctions_lists/business_definition.json")

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
