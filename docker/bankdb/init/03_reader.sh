#!/bin/sh
# Creates the read-only login that Zetaris uses. The password comes from the environment, never from a file.
set -eu
: "${BANKDB_READER_PASSWORD:?BANKDB_READER_PASSWORD must be set}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE zetaris_reader LOGIN PASSWORD '${BANKDB_READER_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE zetaris_reader SET default_transaction_read_only = on;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO zetaris_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO zetaris_reader;
SQL
