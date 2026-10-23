-- What the data-quality rules find.

-- @@ run_dob_present_for_individuals
RUN DQ dob_present_for_individuals TABLE lightning.metastore.sanctions.screening_usl.customer

-- @@ run_nationality_is_iso2
RUN DQ nationality_is_iso2 TABLE lightning.metastore.sanctions.screening_usl.customer

-- @@ run_ownership_pct_in_range
RUN DQ ownership_pct_in_range TABLE lightning.metastore.sanctions.screening_usl.beneficial_owner

-- @@ run_ownership_pct_present
RUN DQ ownership_pct_present TABLE lightning.metastore.sanctions.screening_usl.beneficial_owner

-- @@ run_payment_amount_positive
RUN DQ payment_amount_positive TABLE lightning.metastore.sanctions.screening_usl.payment

-- @@ run_counterparty_country_valid
RUN DQ counterparty_country_valid TABLE lightning.metastore.sanctions.screening_usl.payment

-- @@ run_payment_bank_countries_valid
RUN DQ payment_bank_countries_valid TABLE lightning.metastore.sanctions.screening_usl.payment

-- @@ run_match_score_in_range
RUN DQ match_score_in_range TABLE lightning.metastore.sanctions.screening_usl.alert

-- @@ invalid_customers
SHOW DQ ALL INVALID TABLE lightning.metastore.sanctions.screening_usl.customer
