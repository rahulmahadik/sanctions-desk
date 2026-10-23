# Results of the example queries

Written by `npm run zetaris:queries -- --write` from a live run. Synthetic data only.

## bankdb / bank_customers_by_type

how many customers of each type, and how many are individuals?

```sql
SELECT customer_type, COUNT(*) AS n FROM sanctions_bankdb.customer GROUP BY customer_type ORDER BY customer_type
```

Rows returned: 2. First rows:

```json
[["company", "71"], ["individual", "269"]]
```

## bankdb / bank_alerts_by_status

how many alerts are open for review and with what score range?

```sql
SELECT status, COUNT(*) AS n, MIN(CAST(match_score AS DOUBLE)) AS lowest, MAX(CAST(match_score AS DOUBLE)) AS highest FROM sanctions_bankdb.alert GROUP BY status ORDER BY status
```

Rows returned: 3. First rows:

```json
[["closed", "11", "1.0", "1.0"], ["escalated", "2", "1.0", "1.0"], ["open", "99", "0.426", "1.0"]]
```

## bankdb / bank_customers_without_dob

which individual customers have no date of birth (what the screening cannot confirm)?

```sql
SELECT customer_id, customer_type FROM sanctions_bankdb.customer WHERE customer_type = 'individual' AND (date_of_birth IS NULL OR date_of_birth = '') ORDER BY customer_id
```

Rows returned: 15. First rows:

```json
[
  ["CUST-0020", "individual"],
  ["CUST-0030", "individual"],
  ["CUST-0031", "individual"],
  ["CUST-H0007", "individual"],
  ["CUST-H0008", "individual"]
]
```

## lists / lists_entries_by_list

how much does the list source hold, and who is on it?

```sql
SELECT list_id, party_kind, COUNT(*) AS n FROM sanctions_lists.list_entry GROUP BY list_id, party_kind ORDER BY list_id, party_kind
```

Rows returned: 6. First rows:

```json
[
  ["OFAC", "aircraft", "2"],
  ["OFAC", "entity", "177"],
  ["OFAC", "individual", "125"],
  ["OFAC", "vessel", "9"],
  ["UN", "entity", "17"]
]
```

## lists / lists_most_aliases

how many aliases does the most-aliased listed party have (why name matching alone is weak)?

```sql
SELECT e.entry_id, e.primary_name, COUNT(*) AS aliases FROM sanctions_lists.list_entry e JOIN sanctions_lists.list_alias a ON a.entry_id = e.entry_id GROUP BY e.entry_id, e.primary_name ORDER BY aliases DESC LIMIT 3
```

Rows returned: 3. First rows:

```json
[
  ["OFAC-17013", "VTB BANK PUBLIC JOINT STOCK COMPANY", "124"],
  ["OFAC-17018", "PUBLIC JOINT STOCK COMPANY SBERBANK OF RUSSIA", "60"],
  ["OFAC-17015", "STATE CORPORATION BANK FOR DEVELOPMENT AND FOREIGN ECONOMIC AFFAIRS VNESHECONOMBANK", "52"]
]
```

## lists / lists_definitions

which approved definitions are in force, and in which version?

```sql
SELECT definition_id, version, status FROM sanctions_lists.business_definition ORDER BY definition_id, version
```

Rows returned: 6. First rows:

```json
[
  ["counterparty_match", "1", "approved"],
  ["effective_ownership_threshold", "1", "approved"],
  ["false_positive", "1", "approved"],
  ["false_positive", "2", "approved"],
  ["strong_identifier", "1", "approved"]
]
```

## payments / payments_by_status

how many payments, in which statuses?

```sql
SELECT status, COUNT(*) AS n FROM sanctions_payments.payments_raw GROUP BY status ORDER BY status
```

Rows returned: 1. First rows:

```json
[["pending", "366"]]
```

## payments / payments_by_country

which counterparty countries carry the most value (what to look at first)?

```sql
SELECT counterparty_country, COUNT(*) AS n, SUM(CAST(amount AS DOUBLE)) AS total FROM sanctions_payments.payments_raw GROUP BY counterparty_country ORDER BY total DESC LIMIT 3
```

Rows returned: 3. First rows:

```json
[["GB", "40", "5512916.170000001"], ["NL", "42", "4401594.97"], ["HK", "33", "3626139.9000000004"]]
```

## payments / payments_pending

which payments are pending (the ones a person could still hold)?

```sql
SELECT COUNT(*) AS pending, SUM(CAST(amount AS DOUBLE)) AS value FROM sanctions_payments.payments_raw WHERE status = 'pending'
```

Rows returned: 1. First rows:

```json
[["366", "4.1662112300000004E7"]]
```

## usl / usl_alert_customer_entry

for each open alert, which customer (bank) and which listed party (lists) is it about? (bank + lists)

```sql
SELECT a.alert_id, c.customer_id, c.customer_type, e.primary_name AS listed_name, e.list_id FROM lightning.metastore.sanctions.screening_usl.alert a JOIN lightning.metastore.sanctions.screening_usl.customer c ON c.customer_id = a.customer_id JOIN lightning.metastore.sanctions.screening_usl.list_entry e ON e.entry_id = a.entry_id ORDER BY a.alert_id LIMIT 3
```

Rows returned: 3. First rows:

```json
[
  ["ALR-0001", "CUST-0001", "individual", "RENEL DESTINA", "UN"],
  ["ALR-0002", "CUST-0002", "individual", "Yongan HU", "OFAC"],
  ["ALR-0003", "CUST-0003", "individual", "AHMED DEGHDEGH", "UN"]
]
```

## usl / usl_pending_payments_with_alerts

how much pending payment value sits behind customers who have an alert? (payments + bank)

```sql
SELECT COUNT(DISTINCT a.customer_id) AS customers, COUNT(*) AS pending_payments, SUM(CAST(p.amount AS DOUBLE)) AS value FROM lightning.metastore.sanctions.screening_usl.alert a JOIN lightning.metastore.sanctions.screening_usl.payment p ON p.customer_id = a.customer_id WHERE p.status = 'pending'
```

Rows returned: 1. First rows:

```json
[["27", "32", "1145678.7"]]
```

## usl / usl_three_source_join

which listed countries do alerted customers pay, i.e. all three sources in one join? (payments + bank + lists)

```sql
SELECT lc.country_iso2 AS country, COUNT(*) AS payments FROM lightning.metastore.sanctions.screening_usl.alert a JOIN lightning.metastore.sanctions.screening_usl.payment p ON p.customer_id = a.customer_id JOIN lightning.metastore.sanctions.screening_usl.list_country lc ON lc.entry_id = a.entry_id AND lc.country_iso2 = p.counterparty_country GROUP BY lc.country_iso2 ORDER BY payments DESC LIMIT 3
```

Rows returned: 3. First rows:

```json
[["RU", "5"], ["CN", "1"], ["IR", "1"]]
```

## usl / usl_dq_dob_rule

what do the data-quality rules find? (rules run inside Zetaris)

```sql
RUN DQ dob_present_for_individuals TABLE lightning.metastore.sanctions.screening_usl.customer
```

Rows returned: 1. First rows:

```json
[["dob_present_for_individuals", "customer", "Custom Data Quality", "340", "325", "15"]]
```

## usl / usl_dq_invalid_customers

what do the data-quality rules find? (rules run inside Zetaris)

```sql
SHOW DQ ALL INVALID TABLE lightning.metastore.sanctions.screening_usl.customer
```

Rows returned: 16. First rows:

```json
[["{\"customer_id\":\"CUST-H0027\",\"customer_type\":\"individual\",\"full_name\":\"AHMED DEGHDEGH\",\"date_of_birth\":null,\"nationality\":\"AE\",\"residence_country\":\"FR\",\"onboarding_date\":\"2020-01-13\",\"risk_rating\":\"low\",\"desk\":\"EMEA\",\"notes\":\"Identity card ID 45155396 checked at branch (KYC-231970) on 2026-09-26: date of birth 1991-04-12; mother's name Houria Benali, father's name Said.\",\"data_origin\":\"synthetic\"}"],["{\"customer_id\":\"CUST-H0008\",\"customer_type\":\"individual\",\"full_name\":\"Mateo Tanaka\",\"date_of_birth\":null,\"nationality\":\"FR\",\"residen
```
