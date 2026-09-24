# Load test

A crowd on a throwaway database, to see where the API gives out before real players find it. Nothing here touches Neon.

1. **A private Postgres** (PostgreSQL 18 is installed on the dev machine). Pick a scratch folder and a free port:
   ```
   initdb -D <scratch>/pgdata -U postgres --auth=trust -E UTF8 --no-locale
   pg_ctl -D <scratch>/pgdata -o "-p 55432" -l <scratch>/pg.log start
   psql -h 127.0.0.1 -p 55432 -U postgres -c "create database arcade_load"
   ```
2. **The schema, then one boot to stamp it.** With `DATABASE_URL=postgres://postgres@127.0.0.1:55432/arcade_load` and `NEON_BRANCH=loadtest` exported, run `npx tsx src/db/migrate-cli.ts`. Then start the API once and stop it. The first boot on a fresh database wipes the boards (`applySeedRevision`), so the crowd has to go in after it.
3. **The crowd**: `psql ... -d arcade_load -f scripts/loadtest/seed.sql` loads 20,000 players and 300,000 scores, 40% of them from the last day.
4. **The API under test**, with the same exports plus `PORT=8796`: `npx tsx src/index.ts`. `NEON_BRANCH=loadtest` lets `/auth/magic-link` make the saving players' accounts.
5. **The crowd at work**: `node scripts/loadtest/load.mjs --users 200 --writers 100 --seconds 60` prints latency percentiles per request, failures, and the server's memory. Windows only: memory is read with `tasklist`.
6. **Same answers as before?** Run the committed code from a worktree on port 8797, then `node scripts/loadtest/compare.mjs --count 250` sends both the same requests and compares every answer. `writes.mjs` saves a batch through one server. Restart the other afterwards, so it reads fresh, and compare again.

Stop with `pg_ctl -D <scratch>/pgdata stop -m fast` and delete the folder.

**Measured 2026-09-24 (2941038) on that crowd:**
- 50 browsing on the old code: every request timed out.
- 200 browsing + 100 saving: reads a few ms (95% under 0.2 s), saves under 1.1 s, no failures.
- 500 + 200: no failures; reads 95% under 0.2 s; the slowest saves took about 5 s.
- The caches hold about 134 MB of heap at that size.
