-- Fallback copy of the synthetic bank as files in the Zetaris file store. Use it with 06_activate_files_create.sql
-- when the bank database or the payments service cannot be reached.

-- @@ db_bank_files
CREATE LIGHTNING DATABASE sanctions_bank_files DESCRIBE BY "Synthetic bank, file copy"

-- @@ file_customer
CREATE LIGHTNING FILESTORE TABLE customer FROM sanctions_bank_files FORMAT JSON OPTIONS (path "dffs://sanctions/sanctions_bank_files/customer.json")

-- @@ file_customer_identifier
CREATE LIGHTNING FILESTORE TABLE customer_identifier FROM sanctions_bank_files FORMAT JSON OPTIONS (path "dffs://sanctions/sanctions_bank_files/customer_identifier.json")

-- @@ file_customer_alias
CREATE LIGHTNING FILESTORE TABLE customer_alias FROM sanctions_bank_files FORMAT JSON OPTIONS (path "dffs://sanctions/sanctions_bank_files/customer_alias.json")

-- @@ file_account
CREATE LIGHTNING FILESTORE TABLE account FROM sanctions_bank_files FORMAT JSON OPTIONS (path "dffs://sanctions/sanctions_bank_files/account.json")

-- @@ file_beneficial_owner
CREATE LIGHTNING FILESTORE TABLE beneficial_owner FROM sanctions_bank_files FORMAT JSON OPTIONS (path "dffs://sanctions/sanctions_bank_files/beneficial_owner.json")

-- @@ file_payment
CREATE LIGHTNING FILESTORE TABLE payment FROM sanctions_bank_files FORMAT JSON OPTIONS (path "dffs://sanctions/sanctions_bank_files/payment.json")

-- @@ file_alert
CREATE LIGHTNING FILESTORE TABLE alert FROM sanctions_bank_files FORMAT JSON OPTIONS (path "dffs://sanctions/sanctions_bank_files/alert.json")

-- @@ file_disposition
CREATE LIGHTNING FILESTORE TABLE disposition FROM sanctions_bank_files FORMAT JSON OPTIONS (path "dffs://sanctions/sanctions_bank_files/disposition.json")
