# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for a security problem.

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

## Controls and test evidence

What is protected, how, and the tests and scans that check it are in [docs/SECURITY.md](docs/SECURITY.md).
