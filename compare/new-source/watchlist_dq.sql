-- The one data-quality rule for the new source (the rule is hand-written; the table, grants and activation are generated).
-- @@ dq_watchlist_country_valid
REGISTER DQ watchlist_country_valid TABLE lightning.metastore.sanctions.screening_usl.internal_watchlist AS
country_iso2 IN (<ISO 3166-1 alpha-2 codes>)
