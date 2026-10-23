-- Loads the synthetic rows. Empty cells are SQL NULL.
COPY customer (customer_id, customer_type, full_name, date_of_birth, nationality, residence_country, onboarding_date, risk_rating, desk, notes, data_origin) FROM '/seed/customer.csv' WITH (FORMAT csv, HEADER true, NULL '');
COPY customer_identifier (identifier_id, customer_id, id_type, id_number, issuing_country) FROM '/seed/customer_identifier.csv' WITH (FORMAT csv, HEADER true, NULL '');
COPY customer_alias (alias_id, customer_id, alias_name, alias_kind) FROM '/seed/customer_alias.csv' WITH (FORMAT csv, HEADER true, NULL '');
COPY account (account_id, customer_id, account_type, currency, opened_on, status) FROM '/seed/account.csv' WITH (FORMAT csv, HEADER true, NULL '');
COPY payment (payment_id, customer_id, account_id, direction, amount, currency, counterparty_name, counterparty_country, counterparty_bank_bic, beneficiary_bank_country, intermediary_bank_country, payment_reference, value_date, status) FROM '/seed/payment.csv' WITH (FORMAT csv, HEADER true, NULL '');
COPY beneficial_owner (ownership_id, owned_party_id, owned_party_kind, owner_party_id, owner_party_kind, owner_name, ownership_pct, as_of) FROM '/seed/beneficial_owner.csv' WITH (FORMAT csv, HEADER true, NULL '');
COPY alert (alert_id, alert_type, alert_source, customer_id, payment_id, list_id, entry_id, matched_name, match_score, raised_at, status) FROM '/seed/alert.csv' WITH (FORMAT csv, HEADER true, NULL '');
COPY disposition (disposition_id, alert_id, customer_id, entry_id, decision, reason_codes, decided_at, decided_by, entry_content_hash, list_snapshot_id) FROM '/seed/disposition.csv' WITH (FORMAT csv, HEADER true, NULL '');
