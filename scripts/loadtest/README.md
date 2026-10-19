# Load test

A crowd on a throwaway database, to see where the API gives out before real players find it. Nothing here touches Neon.

1. **A private Postgres** (PostgreSQL 18 is installed on the dev machine). Pick a scratch folder and a free port:
   ```
   initdb -D <scratch>/pgdata -U postgres --auth=trust -E UTF8 --no-locale
   pg_ctl -D <scratch>/pgdata -o "-p 55432" -l <scratch>/pg.log start
   psql -h 127.0.0.1 -p 55432 -U postgres -c "create database arcade_load"
   ```
2. **The schema, then one boot to stamp it.** With `DATABASE_URL=postgres://postgres@127.0.0.1:55432/arcade_load` and `NEON_BRANCH=loadtest` exported, run `npx tsx src/db/migrate-cli.ts`. Then start the API once and stop it. The first boot on a fresh database wipes the boards (`applySeedRevision`), so the crowd has to go in after it.
3. **The crowd**: `psql ... -d arcade_load -f scripts/loadtest/seed.sql` loads 20,000 players and 300,000 scores, 40% of them from the last day. `seed-records.sql` adds 150,000 record-book runs across every book. `seed-events.sql` puts 5,000 players in the day's official event and 5,000 in the week's, with about 20,000 runs; the API makes those two events on its first boot, so run it after, and restart the API to read them.
4. **The API under test**, with the same exports plus `PORT=8796`: `npx tsx src/index.ts`. `NEON_BRANCH=loadtest` lets `/auth/magic-link` make the saving players' accounts.
5. **The crowd at work**: `node scripts/loadtest/load.mjs --users 200 --writers 100 --seconds 60` prints latency percentiles per request, failures, and the server's memory. Browsers visit the home page (site records, the events on now), game pages (record books, the game's events) and event pages; savers join the day's and week's events, post two records, then the score, and post it to an event when the game is in one (four runs in ten are). Windows only: memory is read with `tasklist`.
6. **Same answers as before?** Run the committed code from a worktree on port 8797, then `node scripts/loadtest/compare.mjs --count 250` sends both the same requests and compares every answer; `--records only` or `--records mixed` takes in the record books, `--events only` or `--events mixed` the events (slow against code from before ac1a90a, which took seconds an event request). `writes.mjs` saves a batch through one server. Restart the other afterwards, so it reads fresh, and compare again.
7. **The standings, patched as saves land, against a count from scratch**: `npx tsx scripts/loadtest/standings-check.ts 40` saves 40 runs (new players, new bests, runs that aren't, new tops) and compares every period's standings after each one.
8. **A period's runs, by timestamps, against the day keys**: `npx tsx scripts/loadtest/period-check.ts` compares the boards' period filter with `inPeriod` on real runs and on runs a millisecond either side of every quarter hour through both daylight-saving changes, month ends and a year end.
9. **The ten-minute look at the tables**: `LOG_SQL=1 npx tsx scripts/loadtest/history-check.ts` moves the clock on and shows the score and record copies kept after one small query when nothing changed, and the tables read again when a row was added outside the API.
10. **Which queries a request makes**: `LOG_SQL=1` prints every query the API sends; `LOG_REQUESTS=1` prints each request with its time and query count.
11. **More than one server** (`MULTI_INSTANCE=1`, see `src/feed.ts`): start two with the same exports plus `MULTI_INSTANCE=1`, on 8796 and 8797. `node scripts/loadtest/multi-check.mjs` makes changes on one and reads them on the other: a save, a record, a log-out, an avatar, a group, a run in the day's event, a capped event and a bracket joined from both at once. `load.mjs --bases http://127.0.0.1:8796,http://127.0.0.1:8797` sends each request to either at random, each player saying back their last change's feed number as the app does; `compare.mjs --old <one> --new <other>` should then find every answer the same, and so should a third server started afterwards, reading fresh.

Stop with `pg_ctl -D <scratch>/pgdata stop -m fast` and delete the folder.

## The site's crowd (October 2026)

`load.mjs` is September's crowd: boards, record books and events. `site.mjs` follows the site as it is now. It makes the requests the header, the home page, the Dailies, the game pages and their Past and Records tabs make. Its players play runs the way the games do: `/runs/start`, then the run's own length, then records, the save, the end card's reads, course bests and a race's ghost. Each person comes from an address of their own (`X-Forwarded-For`), so the per-address limits apply as they do for people.

- **The world:** seed it with the real seed, which plays every daily up to today. A copy of an older world has empty day boards. Use the steps in [The world, seeded](#the-world-seeded) below.
- **Matching production:** start the API with `REQUIRE_RUN_TOKEN=1`, as production runs.
- **The command:** `node scripts/loadtest/site.mjs --visitors 300 --guests 100 --players 150 --seconds 120 [--base http://127.0.0.1:8806] [--ramp 10]`.
  - `--visitors` are signed in and look around.
  - `--guests` are signed out.
  - `--players` play.
  - Accounts are kept in `site-accounts.json`, made on the first run through `/auth/magic-link`.
- **The report:** a failure says its status and code, so a refused save says why.

### The world, seeded
1. Create the database, then with `DATABASE_URL` and `NEON_BRANCH=loadtest` exported, run `npm run db:migrate`.
2. Run `applySeedRevision()` and `applyDataRepairs()` once, as a first boot would. Otherwise the API's real first boot clears the seeded boards.
3. Run `NODE_OPTIONS=--max-old-space-size=8192 npx tsx src/seedWorld.ts --players 20000`. That took 6 minutes for 20,000 accounts, 2.27M runs (131k of them today's) and 1.78M record entries.

**Measured 2026-10-19 (91bc9e2) on that world, laptop, local Postgres:**
- **40 people** (20 visitors, 5 guests, 15 players): p50 0.5 s, p99 5.6 s, with the server stalled 0.5–1 s at a time throughout.
  - The home page asks `/leaderboards/<race>/days` for each of the four races. Each call walks every run of that game (`dailyDays`), uncached: 80–470 ms each, for any player. One home page view costs about 0.6 s of the server's time.
  - `/tracks/<game>/records` (the Past and Records tabs) takes 200–400 ms a call.
- **80 players only**, with no home pages: about 0.6 saves a second.
  - Saves took 260–320 ms at p50, 1–2.8 s at p95, and up to 11 s.
  - The profile is mostly `poolView`, `dayPointsBoard` and `dayIndex` (store.ts), redrawn after each daily's save.
- **Fast:** every other request takes 2–25 ms alone.
- **After a boot:** the first `/records/site` takes 2–10 s, and the boot itself stalls about 6.5 s.

**Fixed the same day:**
- **A daily's days** (`store.ts` dayBook): each game's runs are kept by day, and a save goes into its day in place. `/days`, the day boards and the week's, month's and season's day points are drawn again only for the day that changed. `/days` now takes 10–15 ms.
- **Course boards** (`trackLaps.ts`): a game's laps are kept, with a cheap count check once a minute. Each course's board is kept until its days or laps change. Track records now take 9–14 ms (Lander's was 0.7 s).
- **The course records at start** (`courseRecords.ts`, `records.ts` seedRecordEntries): each player's best in a book is looked up once, not by a walk down the book for every entry. That walk was 62 s of stalls after every boot on the old code. With the boards kept it became one 152 s stall; now it's gone.
- **Same answers:** `days-check.mjs` compares every dailies answer from two servers on one database: days, day boards, week, month and season points, standings, daily records and course boards. 4,971 of 4,971 matched at rest. After about 500 saves through the new code, all 4,863 matched the old code reading the tables fresh.

**After the fixes** (`site.mjs`, warm server, laptop, local Postgres):

| People (visitors / guests / players) | Requests a second | p50 | p95 | p99 | Saves p50 / p95 | Failed |
|---|---|---|---|---|---|---|
| 40 (20 / 5 / 15) | 28 | 14 ms | 70 ms | 0.68 s | 67 ms / 163 ms | 1 of 8,268 |
| 550 (300 / 100 / 150) | 420 | 31 ms | 555 ms | 1.4 s | 0.4 s / 3.5 s | 51 of 156,811 |
| 1,000 (550 / 200 / 250) | 498 | 149 ms | 3.4 s | 6.4 s | 10 s / 25 s | 1,662 of 166,810 |

- **The ceiling:** one server tops out near 500 requests a second, about 550–600 people on this mix. That is CPU, not stalls.
- **What's left:**
  - Saves are the costliest request: about 12 queries each, through the 10-connection pool.
  - `buildSiteRecords` takes about 0.9 s once a minute.
  - Reading the tables at boot takes about 5 s for scores and 7 s for record books.
  - Memory reached 2.6 GB of a 3 GB heap with 1,300 requests in flight.
- **Don't trust a slow run until you've checked the machine.** Another process ate three quarters of the CPU during one run here.
- **Columns:** `q` in the table is the average number of database queries a request made (`X-Db-Queries`).

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

**With the events full (same day):**
- Before, one request at a time: listing the events took 4 to 8.5 s, the week's event page 12.5 s. Every home page lists them twice.
- Each event's runs indexed per player and its standings counted once per change: listing 6 ms, the week's page 50 ms (most of it the 1.8 MB answer: every player, every row). 200 + 100 with events in the mix: no failures.
- An event read back from the database after that run was byte for byte what the API had in memory: no run lost between its writes.

**The save (same day):**
- A save redrew its game's four period boards, and each redraw looked every player up by name in a new map and worked out every run's day: 30 to 100 ms a save at 18,000 runs a game, most of the CPU a crowd of savers used. Now each run carries its player's number, a board is drawn with a stamp and typed arrays, and a period is two timestamps; the saved run's rank is a binary search, and the streak records read the player's runs from memory instead of the table.
- 200 + 100 with events in the mix: no failures; reads 13 to 17 ms at the median; saves 54 ms at the median (from 2.6 s), records 96 ms (from 833 ms), event runs 391 ms (half a second of that is the standings settling). Boards, ranks and standings matched the round-1 code across 400 compared requests.

**More than one server (same day, `MULTI_INSTANCE=1`):**
- Two servers on one database, each request to either at random: 200 browsing + 100 saving, no failures; afterwards the two agreed on all 400 compared answers, a third server started fresh from the tables agreed with them, and every event page matched across all three.
- A capped event joined by six players from both servers at once seated exactly three; a bracket filled from both was drawn once, and was the draw in the database.
- The feed costs a server almost nothing: one server taking all of 1,000 browsing + 100 saving while a second followed the feed ran as one server with the flag off (about 2,080 requests a second, 6 to 7 ms at the median, 95% under 90 ms).
- This laptop can't show what a second server adds: with two servers, the database and the load all on it, it ran at 99% CPU and two did worse than one. On separate machines each server serves its share of the reads, and every server still takes in every save.
