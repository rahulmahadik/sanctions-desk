-- The Unified Semantic Layer: joins across the three sources in one statement.
-- Read only. Run: npm run zetaris:queries -- usl

-- Question: for each open alert, which customer (bank) and which listed party (lists) is it about? (bank + lists)
-- @@ usl_alert_customer_entry
SELECT a.alert_id, c.customer_id, c.customer_type, e.primary_name AS listed_name, e.list_id FROM lightning.metastore.sanctions.screening_usl.alert a JOIN lightning.metastore.sanctions.screening_usl.customer c ON c.customer_id = a.customer_id JOIN lightning.metastore.sanctions.screening_usl.list_entry e ON e.entry_id = a.entry_id ORDER BY a.alert_id LIMIT 3

-- Question: how much pending payment value sits behind customers who have an alert? (payments + bank)
-- @@ usl_pending_payments_with_alerts
SELECT COUNT(DISTINCT a.customer_id) AS customers, COUNT(*) AS pending_payments, SUM(CAST(p.amount AS DOUBLE)) AS value FROM lightning.metastore.sanctions.screening_usl.alert a JOIN lightning.metastore.sanctions.screening_usl.payment p ON p.customer_id = a.customer_id WHERE p.status = 'pending'

-- Question: which listed countries do alerted customers pay, i.e. all three sources in one join? (payments + bank + lists)
-- @@ usl_three_source_join
SELECT lc.country_iso2 AS country, COUNT(*) AS payments FROM lightning.metastore.sanctions.screening_usl.alert a JOIN lightning.metastore.sanctions.screening_usl.payment p ON p.customer_id = a.customer_id JOIN lightning.metastore.sanctions.screening_usl.list_country lc ON lc.entry_id = a.entry_id AND lc.country_iso2 = p.counterparty_country GROUP BY lc.country_iso2 ORDER BY payments DESC LIMIT 3

-- Question: what do the data-quality rules find? (rules run inside Zetaris)
-- @@ usl_dq_dob_rule
RUN DQ dob_present_for_individuals TABLE lightning.metastore.sanctions.screening_usl.customer

-- @@ usl_dq_invalid_customers
SHOW DQ ALL INVALID TABLE lightning.metastore.sanctions.screening_usl.customer
