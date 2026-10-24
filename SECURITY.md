# Security policy

## Reporting a vulnerability

Please do not put the details of a security problem in a public issue. Open an issue that says only that you have a security report, without details, and a private way to share them will be arranged.

Include what you found, how to reproduce it, and what an attacker could do with it. Reports are acknowledged as soon as possible. Fixes are made on `main`; there are no other supported versions.

## Scope

In scope:
- the API (`apps/api`), the review desk (`apps/web`) and the review logic (`packages/*`)
- the access controls: sign-in, roles, the four-eyes rule on blocks and policy changes, rate limits
- the data path: the SQL guard, per-agent table and column limits, identifier masking
- the checks around the models: the safety guard, the tipping-off check, keeping free text out of cloud prompts
- the GitHub Actions workflows and the Docker images built from this repository

Out of scope:
- Zetaris, Meterless Nightshift and the models themselves (report those to their owners)
- findings that need the operator's own credentials or `.env` file
- the data: customers, accounts and payments are synthetic, and the sanctions lists are public

The desk is built to run locally. It recommends and a person decides: it never blocks an account, writes to a source system or contacts a customer.

## Checks that run on every push

The CI workflow runs `npm audit` (high severity and above), the typecheck, lint and all tests (including the access-control, SQL-guard and pentest tests), the official engine conformance suites, and the signed-evidence check of the exported runs. Other scans (Semgrep, Trivy, Gitleaks, a ZAP baseline) were run by hand and are described with their results in [docs/SECURITY.md](docs/SECURITY.md).

## Controls and test evidence

What is protected, how, and the tests and scans that check it are in [docs/SECURITY.md](docs/SECURITY.md).
