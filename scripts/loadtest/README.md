# Load test

A crowd on a throwaway database, to see where the API gives out before real players find it. Nothing here touches Neon.

1. **A private Postgres** (PostgreSQL 18 is installed on the dev machine). Pick a scratch folder and a free port:
   ```
   initdb -D <scratch>/pgdata -U postgres --auth=trust -E UTF8 --no-locale
   pg_ctl -D <scratch>/pgdata -o "-p 55432" -l <scratch>/pg.log start
   psql -h 127.0.0.1 -p 55432 -U postgres -c "create database arcade_load"
   ```
2. **The schema, then one boot to stamp it.** With `DATABASE_URL=postgres://postgres@127.0.0.1:55432/arcade_load` and `NEON_BRANCH=loadtest` exported, run `npx tsx src/db/migrate-cli.ts`. Then start the API once and stop it. The first boot on a fresh database wipes the boards (`applySeedRevision`), so the crowd has to go in after it.
3. **The crowd**: `psql ... -d arcade_load -f scripts/loadtest/seed.sql` loads 20,000 players and 300,000 scores, 40% of them from the last day. `seed-records.sql` adds 150,000 record-book runs across every book.
4. **The API under test**, with the same exports plus `PORT=8796`: `npx tsx src/index.ts`. `NEON_BRANCH=loadtest` lets `/auth/magic-link` make the saving players' accounts.
5. **The crowd at work**: `node scripts/loadtest/load.mjs --users 200 --writers 100 --seconds 60` prints latency percentiles per request, failures, and the server's memory. Browsers visit the home page (site records) and game pages (record books); savers post two records, then the score. Windows only: memory is read with `tasklist`.
6. **Same answers as before?** Run the committed code from a worktree on port 8797, then `node scripts/loadtest/compare.mjs --count 250` sends both the same requests and compares every answer; `--records only` or `--records mixed` takes in the record books. `writes.mjs` saves a batch through one server. Restart the other afterwards, so it reads fresh, and compare again.
7. **The standings, patched as saves land, against a count from scratch**: `npx tsx scripts/loadtest/standings-check.ts 40` saves 40 runs (new players, new bests, runs that aren't, new tops) and compares every period's standings after each one.

Stop with `pg_ctl -D <scratch>/pgdata stop -m fast` and delete the folder.

## Where the time goes

An "error" in `load.mjs` is a connection dropped, not a status: the server stalled long enough for idle sockets to close under the client. To find the stall, start the API with `NODE_OPTIONS="--import file:///<repo>/scripts/loadtest/profile-hook.mjs"` (next to the memory flag). It logs `[stall]` and `[lag]` lines when the event loop runs late, and records a CPU profile between `touch scripts/loadtest/profile.start` and `touch scripts/loadtest/profile.stop`. Then:

- `node scripts/loadtest/profile-summary.mjs <profile>` — time per function, own and inclusive.
- `node scripts/loadtest/long-tasks.mjs <profile> 300` — every stretch of 300 ms or more without a break, and what filled it.

**Measured 2026-09-24 (2941038) on that crowd:**
- 50 browsing on the old code: every request timed out.
- 200 browsing + 100 saving: reads a few ms (95% under 0.2 s), saves under 1.1 s, no failures.
- 500 + 200: no failures; reads 95% under 0.2 s; the slowest saves took about 5 s.
- The caches hold about 134 MB of heap at that size.

**With home visits and record books in the mix (same day):**
- Before: the crowd collapsed into thousands of failures, 1.4 GB of memory.
- Record books and site records kept in memory: 540 dropped connections, reads 0.3 s at the median, stalls of up to 3.6 s. Profiled: re-counting and re-sorting the standings after every save.
- Standings patched instead of recounted, the trophy rollover no longer re-reading every score every five minutes, site records folded in slices: 200 + 100 ran with no failures, reads 4–5 ms at the median and 99% under 0.4 s, saves 46 ms at the median. 500 + 200: no failures, reads 12 ms at the median; saves wait on the database pool (0.5 s median, 2.1 s at worst).
