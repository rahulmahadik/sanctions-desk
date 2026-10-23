-- Source: synthetic bank database (Postgres over JDBC, read-only login).
-- Read only. Run: npm run zetaris:queries -- bankdb

-- Question: how many customers of each type, and how many are individuals?
-- @@ bank_customers_by_type
SELECT customer_type, COUNT(*) AS n FROM sanctions_bankdb.customer GROUP BY customer_type ORDER BY customer_type

-- Question: how many alerts are open for review and with what score range?
-- @@ bank_alerts_by_status
SELECT status, COUNT(*) AS n, MIN(CAST(match_score AS DOUBLE)) AS lowest, MAX(CAST(match_score AS DOUBLE)) AS highest FROM sanctions_bankdb.alert GROUP BY status ORDER BY status

-- Question: which individual customers have no date of birth (what the screening cannot confirm)?
-- @@ bank_customers_without_dob
SELECT customer_id, customer_type FROM sanctions_bankdb.customer WHERE customer_type = 'individual' AND (date_of_birth IS NULL OR date_of_birth = '') ORDER BY customer_id
