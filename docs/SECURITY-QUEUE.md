# Security queue

Problems found by the security checks that sit in files this pass did not change (the agents, shared and data packages, the configuration and policy files, the exam tool). Each entry says what is wrong, where, the proposed fix and the test that proves it.

Items 1, 2 and 3 are done (24 Oct 2026, commit `b2dae21`): the guard now splits a statement into tokens and reads every table position, and refuses what it cannot read. See the SQL guard section of [SECURITY.md](SECURITY.md).

## 1. The SQL guard misses a comma join after a table alias (medium) — done 24 Oct 2026, `b2dae21`

**Done.** The guard reads the whole FROM list: each table, an optional alias (with or without `AS`, with an optional column list), and then only a comma, a join keyword, `ON`, `USING (`, a clause keyword, `)` or the end. A comma inside a FROM list, at any bracket depth, starts another table. Anything else in a table position is refused with `unrecognised_table`. The block "comma join after an alias" in `apps/api/test/pentest-sql-guard.test.ts` is now `it.each` and passes; the same statements and a `scopeViolation` case are in `packages/zetaris/test/guard.test.ts`.

**What.** `FROM customer c, other.users u` is accepted as a read of `customer` only. The check that finds the tables after `FROM` and `JOIN` allows a comma only straight after the table name, so an alias in between hides the second table. The second table is then checked neither against the model's list nor against the calling agent's own tables (`scopeViolation` uses the same list of tables).

**Reach.** No agent builds SQL from free text: the data tools generate fixed statements, so this is not reachable today from the API. It matters because the guard is the second layer behind the data service's own grants, and that layer should hold on its own. In the live system the first layer still stops a table the role cannot read.

**Where.** `packages/zetaris/src/guard.ts`, `referencedTables`.

**Proposed fix.** Read the whole `FROM` list rather than the first word after it: after each table name allow an optional `AS`, an optional alias word, and then either a comma (and read the next table too), a join keyword, a clause keyword (`WHERE`, `GROUP`, `ORDER`, `LIMIT`, `HAVING`, `UNION`, `)`) or the end. Anything else, or a comma that is not followed by a table in the list, is refused with `table_not_allowed`.

**Test that proves it.** `apps/api/test/pentest-sql-guard.test.ts`, the block "comma join after an alias". It passes today because it is written with `it.fails.each`; after the fix it fails, and `it.fails.each` should become `it.each`. Add the same three statements to `packages/zetaris/test/guard.test.ts` and one for `scopeViolation`.

## 2. The guard and the literal quoting disagree with the SQL engine about a backslash (low, not proven) — done 24 Oct 2026, `b2dae21`

**Done.** The guard refuses any statement that contains a backslash (code `backslash`), so it never has to guess where the engine ends a string. `quoteLiteral` refuses a value with a backslash or `${`, and the identifier overlap query in `packages/agents/src/evidence.ts` now uses `quoteLiteral` instead of its own copy. `blankLiterals` keeps a backslash and the next character inside the literal. Whether the live engine honours the backslash escape is still unconfirmed; with the refusal it no longer matters to the guard.

**What.** The guard treats `''` as an escaped quote and nothing else. Spark-style engines also treat `\'` as an escaped quote. `quoteLiteral` doubles single quotes and refuses control characters and semicolons, but leaves a backslash alone. A value ending in a backslash, written as `'abc\'`, would be read by such an engine as an unfinished string that swallows the text after it. With two values in one statement this could change what the second value means.

**Reach.** Values come from fixed alert, customer and list ids in the synthetic data, and the API accepts only `[A-Za-z0-9._-]` for the id it passes on. No such value was found. Not tested against the live data service, which this pass did not touch, so whether it honours the backslash escape is unconfirmed.

**Where.** `packages/zetaris/src/tools.ts` (`quoteLiteral`), `packages/agents/src/evidence.ts` (`overlapSql` has its own copy of the quoting), `packages/zetaris/src/guard.ts` (`blankLiterals`).

**Proposed fix.** One quoting function for all of them that refuses a value containing a backslash (or doubles it, once the engine's behaviour is confirmed), and `blankLiterals` that treats `\` plus the next character as part of the literal, which can only make the guard stricter.

**Test that proves it.** `quoteLiteral("a\\")` throws (or yields a literal the engine reads as complete); `guardSql` refuses `WHERE a = 'x\' OR 1 IN (SELECT 1 FROM other.users) OR b = \'y'` (already refused today, because the guard sees the table; keep it as a regression test).

## 3. The SQL guard accepts non-ASCII characters outside string values (low, hardening) — done 24 Oct 2026, `b2dae21`

**Done.** Outside single-quoted values only printable ASCII, tab, carriage return and line feed are accepted (code `non_ascii`), including inside backquoted and double-quoted names. Only ASCII spacing is trimmed from the ends, so a byte order mark or a no-break space is refused rather than removed. The "disguises" block now expects a refusal for every case except the doubled quote, which stays one harmless value.

**What.** A full-width semicolon, a no-break space or a zero-width space outside a string is not rejected by the character checks. Every disguise tried in `pentest-sql-guard.test.ts` was still refused or harmless, because the keyword and table checks caught what followed, but nothing states the rule.

**Where.** `packages/zetaris/src/guard.ts`, `precheck`.

**Proposed fix.** After `blankLiterals`, refuse any character above U+007E (code `control_character`, or a new `non_ascii`). Column and table names in the model are ASCII.

**Test.** The "disguises" block in `apps/api/test/pentest-sql-guard.test.ts`: tighten each case from "refused or harmless" to "refused".

## 4. The server listens on every network interface by default (low)

**What.** `server.host` is `0.0.0.0` in `config/default.json` and `.env.example`. Outside a container, `npm run dev` or `npm start` is then reachable from the local network, and in sample mode anyone who reaches it can pick the approver or policy-admin demo user with a header. The compose file now publishes ports on `127.0.0.1` only; the default for a bare process is still open.

**Where.** `config/default.json` (`server.host`), `.env.example` (`HOST`). The compose file already sets `HOST: 0.0.0.0` for the container, so the default can change without affecting it.

**Proposed fix.** Default `127.0.0.1`; keep `HOST=0.0.0.0` in the compose file.

**Test.** `loadConfig({ env: {} }).server.host === "127.0.0.1"`, and the compose test still finds `HOST` set for the `api` service.

## 5. No limit on how often a person can start reviews or call the API (medium for a shared deployment)

**What.** `POST /run` starts a review that makes model calls and data queries. 120 parallel `POST /guard/outbound` calls were all answered; nothing slows a caller down. A signed-in analyst, or in sample mode anyone, can run up cost and load. The body size limit (1 MiB) and the per-call timeouts exist; a per-person rate limit and a cap on reviews in flight do not.

**Where.** A new `server.rateLimit` setting in `packages/shared/src/config.ts` and `config/default.json`, applied in `apps/api/src/app.ts` (a hook keyed by the signed-in id, or the address when there is none), with `429` and `Retry-After`.

**Proposed fix.** A fixed window per caller for write routes (for example 60 a minute), a lower one for `/run` and `/policy/whatif`, and a cap on runs in flight (queue or refuse above it). Keep it in the configuration so it is not hard-coded.

**Test.** Send the limit plus one request; the last gets 429 with `Retry-After`, a different caller is unaffected, and the window resets.

## 6. Rebuild the images (done, 24 Oct 2026)

Done: both images rebuilt from the fixed Dockerfile (`sanctions-desk-api:final`, `sanctions-desk-web:final`) and scanned with Trivy: 0 vulnerabilities in either. The older `:local` tags are still used by running containers and are left alone.


The images `sanctions-desk-api:local` and `sanctions-desk-web:local` were scanned before the Dockerfile change and still contain the package manager with 4 high and 9 other findings in its own dependencies (see [SECURITY.md](SECURITY.md)); the fixed Dockerfile removes it, and an API image built from it scanned clean. Rebuild both once nothing is using them, then scan again:

```
docker compose build api web
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock:ro aquasec/trivy:latest image sanctions-desk-api:local
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock:ro aquasec/trivy:latest image sanctions-desk-web:local
```
