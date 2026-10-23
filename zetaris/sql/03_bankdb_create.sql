-- The synthetic bank database, read through a read-only login over the Zetaris network.
-- The address and the password are filled from BANKDB_JDBC_URL and BANKDB_READER_PASSWORD when the script runs;
-- neither is stored here.

-- @@ datasource_bankdb
CREATE DATASOURCE sanctions_bankdb DESCRIBE BY "Synthetic bank database, read only" OPTIONS (
  jdbcdriver "org.postgresql.Driver",
  jdbcurl "${BANKDB_JDBC_URL}",
  username "zetaris_reader",
  password "${BANKDB_READER_PASSWORD}",
  fetchsize "1000"
)

-- @@ register_bankdb_tables
REGISTER DATASOURCE TABLES FROM sanctions_bankdb
