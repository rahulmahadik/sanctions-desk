-- The payments service, read as a REST table over the Zetaris network.
-- The key is filled from PAYMENTS_API_KEY when the script runs; it is not stored here.
-- A REST table calls the service for every query, so the result is cached after it is created.

-- @@ db_payments
CREATE LIGHTNING DATABASE sanctions_payments DESCRIBE BY "Payments service, read only"

-- @@ rest_payments
CREATE LIGHTNING REST TABLE payments_raw FROM sanctions_payments REQUEST (
  endpoint "http://payments-api:8100/payments",
  method "GET",
  http_encoding "URLENCODED",
  response_type "JSON",
  insecure_ssl "false"
) HEADER (x-api-key "${PAYMENTS_API_KEY}") BODY ()

-- @@ cache_payments
CACHE TABLE sanctions_payments.payments_raw
