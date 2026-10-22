# Query plans

The plans below were produced by Zetaris (`EXPLAIN QUERY AS ...`) on this machine for the key queries a review sends. They show that the semantic-layer tables are read through the sources they were activated from, with the filter pushed to the source where the source supports it. Regenerate with `npm run explain`.

## Read one alert by its key

The first read of every review.

```sql
SELECT `alert_id`, `customer_id`, `entry_id`, `match_score` FROM lightning.metastore.sanctions.screening_usl.alert WHERE `alert_id` = 'ALR-0001' ORDER BY `alert_id` LIMIT 200
```

```text
== Parsed Logical Plan ==
'GlobalLimit 200
+- 'LocalLimit 200
   +- 'Sort ['alert_id ASC NULLS FIRST], true
      +- 'Project ['alert_id, 'customer_id, 'entry_id, 'match_score]
         +- 'Filter ('alert_id = ALR-0001)
            +- 'UnresolvedRelation [lightning, metastore, sanctions, screening_usl, alert], [], false

== Analyzed Logical Plan ==
alert_id: string, customer_id: string, entry_id: string, match_score: decimal(4,3)
GlobalLimit 200
+- LocalLimit 200
   +- Sort [alert_id#2480213 ASC NULLS FIRST], true
      +- Project [alert_id#2480213, customer_id#2480216, entry_id#2480219, match_score#2480221]
         +- Filter (alert_id#2480213 = ALR-0001)
            +- SubqueryAlias lightning.metastore.sanctions.screening_usl.alert
               +- RelationV2[alert_id#2480213, alert_type#2480214, alert_source#2480215, customer_id#2480216, payment_id#2480217, list_id#2480218, entry_id#2480219, matched_name#2480220, match_score#2480221, raised_at#2480222, status#2480223] lightning.metastore.sanctions.screening_usl.alert metastore.sanctions.screening_usl.alert

== Optimized Logical Plan ==
GlobalLimit 200
+- LocalLimit 200
   +- Sort [alert_id#2480213 ASC NULLS FIRST], true
      +- RelationV2[alert_id#2480213, customer_id#2480216, entry_id#2480219, match_score#2480221] metastore.sanctions.screening_usl.alert

== Physical Plan ==
TakeOrderedAndProject(limit=200, orderBy=[alert_id#2480213 ASC NULLS FIRST], output=[alert_id#2480213,customer_id#2480216,entry_id#2480219,match_score#2480221])
+- *(1) Scan USLTableScan[alert](LIVE) [alert_id#2480213,customer_id#2480216,entry_id#2480219,match_score#2480221] PushedFilters: [EqualTo(alert_id,ALR-0001)], ReadSchema: struct<alert_id:string,customer_id:string,entry_id:string,match_score:decimal(4,3)>
```

## Which customer identifiers equal a listed party's identifiers

Done inside Zetaris so that identifier numbers never leave it; only the types that match come back.

```sql
SELECT ci.id_type AS id_type, COUNT(*) AS n FROM lightning.metastore.sanctions.screening_usl.customer_identifier ci JOIN lightning.metastore.sanctions.screening_usl.list_identifier li ON regexp_replace(upper(ci.id_number), '[^A-Z0-9]', '') = regexp_replace(upper(li.id_number), '[^A-Z0-9]', '') WHERE ci.customer_id = 'CUST-0001' AND li.entry_id = 'OFAC-1' GROUP BY ci.id_type
```

```text
== Parsed Logical Plan ==
'Aggregate ['ci.id_type], ['ci.id_type AS id_type#2480290, 'COUNT(1) AS n#2480291]
+- 'Filter (('ci.customer_id = CUST-0001) AND ('li.entry_id = OFAC-1))
   +- 'Join Inner, ('regexp_replace('upper('ci.id_number), [^A-Z0-9], ) = 'regexp_replace('upper('li.id_number), [^A-Z0-9], ))
      :- 'SubqueryAlias ci
      :  +- 'UnresolvedRelation [lightning, metastore, sanctions, screening_usl, customer_identifier], [], false
      +- 'SubqueryAlias li
         +- 'UnresolvedRelation [lightning, metastore, sanctions, screening_usl, list_identifier], [], false

== Analyzed Logical Plan ==
id_type: string, n: bigint
Aggregate [id_type#2480336], [id_type#2480336 AS id_type#2480290, count(1) AS n#2480291L]
+- Filter ((customer_id#2480335 = CUST-0001) AND (entry_id#2480382 = OFAC-1))
   +- Join Inner, (regexp_replace(upper(id_number#2480337), [^A-Z0-9], , 1) = regexp_replace(upper(id_number#2480384), [^A-Z0-9], , 1))
      :- SubqueryAlias ci
      :  +- SubqueryAlias lightning.metastore.sanctions.screening_usl.customer_identifier
      :     +- RelationV2[identifier_id#2480334, customer_id#2480335, id_type#2480336, id_number#2480337, issuing_country#2480338] lightning.metastore.sanctions.screening_usl.customer_identifier metastore.sanctions.screening_usl.customer_identifier
      +- SubqueryAlias li
         +- SubqueryAlias lightning.metastore.sanctions.screening_usl.list_identifier
            +- RelationV2[identifier_id#2480381, entry_id#2480382, id_type#2480383, id_number#2480384, issuing_country#2480385, note#2480386] lightning.metastore.sanctions.screening_usl.list_identifier metastore.sanctions.screening_usl.list_identifier

== Optimized Logical Plan ==
Aggregate [id_type#2480336], [id_type#2480336, count(1) AS n#2480291L]
+- Project [id_type#2480336]
   +- Join Inner, (regexp_replace(upper(id_number#2480337), [^A-Z0-9], , 1) = regexp_replace(upper(id_number#2480384), [^A-Z0-9], , 1))
      :- RelationV2[id_type#2480336, id_number#2480337] metastore.sanctions.screening_usl.customer_identifier
      +- RelationV2[id_number#2480384] metastore.sanctions.screening_usl.list_identifier

== Physical Plan ==
AdaptiveSparkPlan isFinalPlan=false
+- HashAggregate(keys=[id_type#2480336], functions=[count(1)], output=[id_type#2480336, n#2480291L])
   +- Exchange hashpartitioning(id_type#2480336, 200), ENSURE_REQUIREMENTS, [plan_id=462168]
      +- HashAggregate(keys=[id_type#2480336], functions=[partial_count(1)], output=[id_type#2480336, count#2480394L])
         +- Project [id_type#2480336]
            +- SortMergeJoin [regexp_replace(upper(id_number#2480337), [^A-Z0-9], , 1)], [regexp_replace(upper(id_number#2480384), [^A-Z0-9], , 1)], Inner
               :- Sort [regexp_replace(upper(id_number#2480337), [^A-Z0-9], , 1) ASC NULLS FIRST], false, 0
               :  +- Exchange hashpartitioning(regexp_replace(upper(id_number#2480337), [^A-Z0-9], , 1), 200), ENSURE_REQUIREMENTS, [plan_id=462160]
               :     +- Scan USLTableScan[customer_identifier](LIVE) [id_type#2480336,id_number#2480337] PushedFilters: [EqualTo(customer_id,CUST-0001)], ReadSchema: struct<id_type:string,id_number:string>
               +- Sort [regexp_replace(upper(id_number#2480384), [^A-Z0-9], , 1) ASC NULLS FIRST], false, 0
                  +- Exchange hashpartitioning(regexp_replace(upper(id_number#2480384), [^A-Z0-9], , 1), 200), ENSURE_REQUIREMENTS, [plan_id=462161]
                     +- Scan USLTableScan[list_identifier](LIVE) [id_number#2480384] PushedFilters: [EqualTo(entry_id,OFAC-1)], ReadSchema: struct<id_number:string>
```

## Read the ownership register one level up

The ownership step reads the register level by level from the customer upwards.

```sql
SELECT `ownership_id`, `owned_party_id`, `owner_party_id`, `ownership_pct` FROM lightning.metastore.sanctions.screening_usl.beneficial_owner WHERE `owned_party_id` IN ('CUST-0035') ORDER BY `ownership_id`
```

```text
== Parsed Logical Plan ==
'Sort ['ownership_id ASC NULLS FIRST], true
+- 'Project ['ownership_id, 'owned_party_id, 'owner_party_id, 'ownership_pct]
   +- 'Filter 'owned_party_id IN (CUST-0035)
      +- 'UnresolvedRelation [lightning, metastore, sanctions, screening_usl, beneficial_owner], [], false

== Analyzed Logical Plan ==
ownership_id: string, owned_party_id: string, owner_party_id: string, ownership_pct: decimal(5,2)
Sort [ownership_id#2480494 ASC NULLS FIRST], true
+- Project [ownership_id#2480494, owned_party_id#2480495, owner_party_id#2480497, ownership_pct#2480500]
   +- Filter owned_party_id#2480495 IN (CUST-0035)
      +- SubqueryAlias lightning.metastore.sanctions.screening_usl.beneficial_owner
         +- RelationV2[ownership_id#2480494, owned_party_id#2480495, owned_party_kind#2480496, owner_party_id#2480497, owner_party_kind#2480498, owner_name#2480499, ownership_pct#2480500, as_of#2480501] lightning.metastore.sanctions.screening_usl.beneficial_owner metastore.sanctions.screening_usl.beneficial_owner

== Optimized Logical Plan ==
Sort [ownership_id#2480494 ASC NULLS FIRST], true
+- RelationV2[ownership_id#2480494, owned_party_id#2480495, owner_party_id#2480497, ownership_pct#2480500] metastore.sanctions.screening_usl.beneficial_owner

== Physical Plan ==
AdaptiveSparkPlan isFinalPlan=false
+- Sort [ownership_id#2480494 ASC NULLS FIRST], true, 0
   +- Exchange rangepartitioning(ownership_id#2480494 ASC NULLS FIRST, 200), ENSURE_REQUIREMENTS, [plan_id=462200]
      +- Scan USLTableScan[beneficial_owner](LIVE) [ownership_id#2480494,owned_party_id#2480495,owner_party_id#2480497,ownership_pct#2480500] PushedFilters: [EqualTo(owned_party_id,CUST-0035)], ReadSchema: struct<ownership_id:string,owned_party_id:string,owner_party_id:string,ownership_pct:decimal(5,2)>
```

## List-change replay: current state of the decided entries

Compares the content hash recorded with each earlier decision with the entry as it is now.

```sql
SELECT `entry_id`, `primary_name`, `content_hash`, `snapshot_id` FROM lightning.metastore.sanctions.screening_usl.list_entry WHERE `entry_id` IN ('OFAC-1', 'OFAC-2', 'UN-1')
```

```text
== Parsed Logical Plan ==
'Project ['entry_id, 'primary_name, 'content_hash, 'snapshot_id]
+- 'Filter 'entry_id IN (OFAC-1,OFAC-2,UN-1)
   +- 'UnresolvedRelation [lightning, metastore, sanctions, screening_usl, list_entry], [], false

== Analyzed Logical Plan ==
entry_id: string, primary_name: string, content_hash: string, snapshot_id: string
Project [entry_id#2480600, primary_name#2480604, content_hash#2480611, snapshot_id#2480610]
+- Filter entry_id#2480600 IN (OFAC-1,OFAC-2,UN-1)
   +- SubqueryAlias lightning.metastore.sanctions.screening_usl.list_entry
      +- RelationV2[entry_id#2480600, list_id#2480601, source_uid#2480602, party_kind#2480603, primary_name#2480604, primary_name_script#2480605, name_normalised#2480606, listed_on#2480607, sanctions_list#2480608, remarks#2480609, snapshot_id#2480610, content_hash#2480611] lightning.metastore.sanctions.screening_usl.list_entry metastore.sanctions.screening_usl.list_entry

== Optimized Logical Plan ==
Project [entry_id#2480600, primary_name#2480604, content_hash#2480611, snapshot_id#2480610]
+- RelationV2[entry_id#2480600, primary_name#2480604, snapshot_id#2480610, content_hash#2480611] metastore.sanctions.screening_usl.list_entry

== Physical Plan ==
*(1) Project [entry_id#2480600, primary_name#2480604, content_hash#2480611, snapshot_id#2480610]
+- *(1) Scan USLTableScan[list_entry](LIVE) [entry_id#2480600,primary_name#2480604,snapshot_id#2480610,content_hash#2480611] PushedFilters: [In(entry_id, [OFAC-1,OFAC-2,UN-1])], ReadSchema: struct<entry_id:string,primary_name:string,snapshot_id:string,content_hash:string>
```

## List-change replay: open alerts and pending payments of affected customers

Gives the portfolio impact of a list update.

```sql
SELECT p.customer_id, COUNT(*) AS pending_payments, SUM(p.amount) AS pending_amount FROM lightning.metastore.sanctions.screening_usl.payment p WHERE p.status = 'pending' AND p.customer_id IN ('CUST-0051', 'CUST-0052') GROUP BY p.customer_id
```

```text
== Parsed Logical Plan ==
'Aggregate ['p.customer_id], ['p.customer_id, 'COUNT(1) AS pending_payments#2480680, 'SUM('p.amount) AS pending_amount#2480681]
+- 'Filter (('p.status = pending) AND 'p.customer_id IN (CUST-0051,CUST-0052))
   +- 'SubqueryAlias p
      +- 'UnresolvedRelation [lightning, metastore, sanctions, screening_usl, payment], [], false

== Analyzed Logical Plan ==
customer_id: string, pending_payments: bigint, pending_amount: decimal(24,2)
Aggregate [customer_id#2480725], [customer_id#2480725, count(1) AS pending_payments#2480680L, sum(amount#2480728) AS pending_amount#2480681]
+- Filter ((status#2480735 = pending) AND customer_id#2480725 IN (CUST-0051,CUST-0052))
   +- SubqueryAlias p
      +- SubqueryAlias lightning.metastore.sanctions.screening_usl.payment
         +- RelationV2[payment_id#2480724, customer_id#2480725, account_id#2480726, direction#2480727, amount#2480728, currency#2480729, counterparty_name#2480730, counterparty_country#2480731, counterparty_bank_bic#2480732, payment_reference#2480733, value_date#2480734, status#2480735] lightning.metastore.sanctions.screening_usl.payment metastore.sanctions.screening_usl.payment

== Optimized Logical Plan ==
Aggregate [customer_id#2480725], [customer_id#2480725, count(1) AS pending_payments#2480680L, sum(amount#2480728) AS pending_amount#2480681]
+- RelationV2[customer_id#2480725, amount#2480728] metastore.sanctions.screening_usl.payment

== Physical Plan ==
AdaptiveSparkPlan isFinalPlan=false
+- HashAggregate(keys=[customer_id#2480725], functions=[count(1), sum(amount#2480728)], output=[customer_id#2480725, pending_payments#2480680L, pending_amount#2480681])
   +- Exchange hashpartitioning(customer_id#2480725, 200), ENSURE_REQUIREMENTS, [plan_id=462278]
      +- HashAggregate(keys=[customer_id#2480725], functions=[partial_count(1), partial_sum(amount#2480728)], output=[customer_id#2480725, count#2480746L, sum#2480747, isEmpty#2480748])
         +- Scan USLTableScan[payment](LIVE) [customer_id#2480725,amount#2480728] PushedFilters: [EqualTo(status,pending), In(customer_id, [CUST-0051,CUST-0052])], ReadSchema: struct<customer_id:string,amount:decimal(14,2)>
```
