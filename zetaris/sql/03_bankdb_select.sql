-- Row counts read from the bank database.

-- @@ count_customer
SELECT COUNT(*) AS n FROM sanctions_bankdb.customer

-- @@ count_customer_identifier
SELECT COUNT(*) AS n FROM sanctions_bankdb.customer_identifier

-- @@ count_customer_alias
SELECT COUNT(*) AS n FROM sanctions_bankdb.customer_alias

-- @@ count_account
SELECT COUNT(*) AS n FROM sanctions_bankdb.account

-- @@ count_beneficial_owner
SELECT COUNT(*) AS n FROM sanctions_bankdb.beneficial_owner

-- @@ count_alert
SELECT COUNT(*) AS n FROM sanctions_bankdb.alert

-- @@ count_disposition
SELECT COUNT(*) AS n FROM sanctions_bankdb.disposition
