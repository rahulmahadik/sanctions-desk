#!/bin/sh
# Run the hand-coded equivalent on the same Docker network as the sources, with the application image as the Node runtime.
# Needs: docker, the bank and payments containers running, and `npm install` done once in this folder.
set -e
cd "$(dirname "$0")/../.."
exec docker run --rm --network zetaris_default --env-file .env.data \
  -e BANKDB_HOST=sanctions-bankdb -e PAYMENTS_URL=http://sanctions-payments-api:8100 -e LISTS_DIR=/lists \
  -v "$PWD/compare/hand-coded:/hand-coded:ro" -v "$PWD/data/sample:/lists:ro" \
  -w /hand-coded --entrypoint node sanctions-desk-api:local run.mjs
