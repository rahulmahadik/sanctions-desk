-- Source: synthetic payments service (REST table, cached).
-- Read only. Run: npm run zetaris:queries -- payments

-- Question: how many payments, in which statuses?
-- @@ payments_by_status
SELECT status, COUNT(*) AS n FROM sanctions_payments.payments_raw GROUP BY status ORDER BY status

-- Question: which counterparty countries carry the most value (what to look at first)?
-- @@ payments_by_country
SELECT counterparty_country, COUNT(*) AS n, SUM(CAST(amount AS DOUBLE)) AS total FROM sanctions_payments.payments_raw GROUP BY counterparty_country ORDER BY total DESC LIMIT 3

-- Question: which payments are pending (the ones a person could still hold)?
-- @@ payments_pending
SELECT COUNT(*) AS pending, SUM(CAST(amount AS DOUBLE)) AS value FROM sanctions_payments.payments_raw WHERE status = 'pending'
