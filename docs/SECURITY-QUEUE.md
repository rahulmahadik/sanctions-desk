# Security queue

Problems the security checks found outside the API code (in the agents, shared and data packages, the configuration and policy files, the exam tool). Each entry says what was wrong, where, the proposed fix, the test that proves it, and what was done.

All six items are done. Items 1, 2 and 3 are fixed in commit `eed80ac`: the guard splits a statement into tokens, reads every table position, and refuses what it cannot read. Items 4 and 5 name their commits. See the SQL guard section of [SECURITY.md](SECURITY.md).

## 1. The SQL guard misses a comma join after a table alias (medium) — done, `eed80ac`

**Done.** The guard reads the whole FROM list: each table, an optional alias (with or without `AS`, with an optional column list), and then only a comma, a join keyword, `ON`, `USING (`, a clause keyword, `)` or the end. A comma inside a FROM list, at any bracket depth, starts another table. Anything else in a table position is refused with `unrecognised_table`. The block "comma join after an alias" in `apps/api/test/pentest-sql-guard.test.ts` is `it.each` and passes; the same statements and a `scopeViolation` case are in `packages/zetaris/test/guard.test.ts`.

**What.** `FROM customer c, other.users u` was accepted as a read of `customer` only. The check that found the tables after `FROM` and `JOIN` allowed a comma only straight after the table name, so an alias in between hid the second table. The second table was then checked neither against the model's list nor against the calling agent's own tables (`scopeViolation` uses the same list of tables).

**Reach.** No agent builds SQL from free text: the data tools generate fixed statements, so this was not reachable from the API. It matters because the guard is the second layer behind the data service's own grants, and that layer should hold on its own. In the live system the first layer still stops a table the role cannot read.

**Where.** `packages/zetaris/src/guard.ts`, `referencedTables`.

**Proposed fix.** Read the whole `FROM` list rather than the first word after it: after each table name allow an optional `AS`, an optional alias word, and then either a comma (and read the next table too), a join keyword, a clause keyword (`WHERE`, `GROUP`, `ORDER`, `LIMIT`, `HAVING`, `UNION`, `)`) or the end. Anything else, or a comma that is not followed by a table in the list, is refused with `table_not_allowed`.

**Test that proves it.** `apps/api/test/pentest-sql-guard.test.ts`, the block "comma join after an alias". Written first with `it.fails.each`, so that it passes while the problem exists and fails once it is fixed; with the fix it becomes `it.each`. Add the same three statements to `packages/zetaris/test/guard.test.ts` and one for `scopeViolation`.

## 2. The guard and the literal quoting disagree with the SQL engine about a backslash (low, not proven) — done, `eed80ac`

**Done.** The guard refuses any statement that contains a backslash (code `backslash`), so it never has to guess where the engine ends a string. `quoteLiteral` refuses a value with a backslash or `${`, and the identifier overlap query in `packages/agents/src/evidence.ts` uses `quoteLiteral` instead of its own copy. `blankLiterals` keeps a backslash and the next character inside the literal. Whether the live engine honours the backslash escape is still unconfirmed; with the refusal it does not matter to the guard.

**What.** The guard treated `''` as an escaped quote and nothing else. Spark-style engines also treat `\'` as an escaped quote. `quoteLiteral` doubled single quotes and refused control characters and semicolons, but left a backslash alone. A value ending in a backslash, written as `'abc\'`, would be read by such an engine as an unfinished string that swallows the text after it. With two values in one statement this could change what the second value means.

**Reach.** Values come from fixed alert, customer and list ids in the synthetic data, and the API accepts only `[A-Za-z0-9._-]` for the id it passes on. No such value was found. Not tested against the live data service, which these checks did not touch, so whether it honours the backslash escape is unconfirmed.

**Where.** `packages/zetaris/src/tools.ts` (`quoteLiteral`), `packages/agents/src/evidence.ts` (`overlapSql` has its own copy of the quoting), `packages/zetaris/src/guard.ts` (`blankLiterals`).

**Proposed fix.** One quoting function for all of them that refuses a value containing a backslash (or doubles it, once the engine's behaviour is confirmed), and `blankLiterals` that treats `\` plus the next character as part of the literal, which can only make the guard stricter.

**Test that proves it.** `quoteLiteral("a\\")` throws (or yields a literal the engine reads as complete); `guardSql` refuses `WHERE a = 'x\' OR 1 IN (SELECT 1 FROM other.users) OR b = \'y'` (already refused before the fix, because the guard sees the table; kept as a regression test).

## 3. The SQL guard accepts non-ASCII characters outside string values (low, hardening) — done, `eed80ac`

**Done.** Outside single-quoted values only printable ASCII, tab, carriage return and line feed are accepted (code `non_ascii`), including inside backquoted and double-quoted names. Only ASCII spacing is trimmed from the ends, so a byte order mark or a no-break space is refused rather than removed. The "disguises" block expects a refusal for every case except the doubled quote, which stays one harmless value.

**What.** A full-width semicolon, a no-break space or a zero-width space outside a string was not rejected by the character checks. Every disguise tried in `pentest-sql-guard.test.ts` was still refused or harmless, because the keyword and table checks caught what followed, but nothing stated the rule.

**Where.** `packages/zetaris/src/guard.ts`, `precheck`.

**Proposed fix.** After `blankLiterals`, refuse any character above U+007E (code `control_character`, or a separate `non_ascii`). Column and table names in the model are ASCII.

**Test.** The "disguises" block in `apps/api/test/pentest-sql-guard.test.ts`: tighten each case from "refused or harmless" to "refused".

## 4. The server listens on every network interface by default (low) — done, `f739654`, test `6aef947`

**Done.** `server.host` is `127.0.0.1` in `config/default.json` and `HOST=127.0.0.1` in `.env.example` (commit `f739654`); the image and the compose file set `HOST=0.0.0.0` inside the container. `packages/shared/test/config.test.ts` checks the default and `apps/api/test/compose.test.ts` checks that compose still sets `HOST` for the `api` service (commit `6aef947`).

**What.** `server.host` was `0.0.0.0` in `config/default.json` and `.env.example`. Outside a container, `npm run dev` or `npm start` was then reachable from the local network, and in sample mode anyone who reached it could pick the approver or policy-admin demo user with a header. The compose file published ports on `127.0.0.1` only; the default for a bare process was open.

**Where.** `config/default.json` (`server.host`), `.env.example` (`HOST`). The compose file sets `HOST: 0.0.0.0` for the container, so the default can change without affecting it.

**Proposed fix.** Default `127.0.0.1`; keep `HOST=0.0.0.0` in the compose file.

**Test.** `loadConfig({ env: {} }).server.host === "127.0.0.1"`, and the compose test still finds `HOST` set for the `api` service.

## 5. No limit on how often a person can start reviews or call the API (medium for a shared deployment) — done, `6aef947`

**Done.** `server.rateLimit` in the configuration (`RATE_LIMIT_*` in the environment): a fixed window per caller, 60 requests a minute to any route that is not a read and 10 a minute to `POST /run` and `POST /policy/whatif`, and at most 4 reviews running at once, refused rather than queued above that. The caller is the signed-in user when sign-in is on, otherwise the remote address (a demo user is only a header, so it does not count as a separate caller). Above a limit the answer is 429 with `Retry-After` and the usual error body with type `rate_limited`. Reads and `/health` are not limited. The limits are kept in memory per process. `apps/api/test/rate-limit.test.ts` covers the limit plus one, another caller, the window reset with an injected clock, per-user counting, the in-flight cap and its slot being freed when a review ends or fails.

**What.** `POST /run` starts a review that makes model calls and data queries. 120 parallel `POST /guard/outbound` calls were all answered; nothing slowed a caller down. A signed-in analyst, or in sample mode anyone, could run up cost and load. The body size limit (1 MiB) and the per-call timeouts existed; a per-person rate limit and a cap on reviews in flight did not.

**Where.** A `server.rateLimit` setting in `packages/shared/src/config.ts` and `config/default.json`, applied in `apps/api/src/app.ts` (a hook keyed by the signed-in id, or the address when there is none), with `429` and `Retry-After`.

**Proposed fix.** A fixed window per caller for write routes (for example 60 a minute), a lower one for `/run` and `/policy/whatif`, and a cap on runs in flight (queue or refuse above it). Keep it in the configuration so it is not hard-coded.

**Test.** Send the limit plus one request; the last gets 429 with `Retry-After`, a different caller is unaffected, and the window resets.

## 6. Rebuild the images (done)

Done: both images built from the fixed Dockerfile (`sanctions-desk-api:final`, `sanctions-desk-web:final`) were scanned with Trivy: 0 vulnerabilities in either.

Images built from the Dockerfile without that fix (scanned as `sanctions-desk-api:local` and `sanctions-desk-web:local`) contain the package manager, with 4 high and 9 other findings in its own dependencies (see [SECURITY.md](SECURITY.md)); the fixed Dockerfile removes it. To rebuild such images and scan them again:

```
docker compose build api web
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock:ro aquasec/trivy:latest image sanctions-desk-api:local
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock:ro aquasec/trivy:latest image sanctions-desk-web:local
```
