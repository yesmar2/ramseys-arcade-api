-- A viral week for the load test: 20,000 players and 300,000 scores across every game.
-- Throwaway database only (port 55432). A few players play a lot; most play a little.
\set players 20000
\set scores 300000

truncate leaderboard_scores;

with games(i, game, top, time_scored) as (
  values
    (0, 'asteroids', 20000, false), (1, 'patriot', 15000, false), (2, 'snake', 1500, false),
    (3, 'crosswalk', 300, false), (4, 'stacker', 40, false), (5, 'centroid', 10000, false),
    (6, 'pop', 2500, false), (7, 'simon', 20, false), (8, 'spotter', 0, true),
    (9, 'pellets', 5000, false), (10, 'findbug', 0, true), (11, 'crumbtrail', 3000, false),
    (12, 'bop', 200, false), (13, 'putt', 100, false), (14, 'barrage', 50000, false),
    (15, 'frenzy', 5000, false), (16, 'fireflies', 60, false)
),
runs as (
  select
    n,
    floor(random() * 17)::int as gi,
    'LT' || lpad((floor(power(random(), 1.6) * :players) + 1)::int::text, 5, '0') as name,
    -- 40% of the week's runs in the last day, the rest spread over the week before.
    (extract(epoch from now()) * 1000)::bigint
      - case when random() < 0.4 then (random() * 86400000)::bigint else (random() * 7 * 86400000)::bigint end as at
  from generate_series(1, :scores) as n
)
insert into leaderboard_scores (id, game, name, score, at, device, run_id, duration_ms)
select
  md5(runs.n::text || random()::text),
  games.game,
  runs.name,
  case
    when games.time_scored then 1000000 - (15000 + floor(random() * 200000))::int
    else greatest(1, floor(power(random(), 2.2) * games.top))::int
  end,
  runs.at,
  case when random() < 0.55 then 'mobile' else 'desktop' end,
  md5(random()::text),
  (30000 + random() * 300000)::bigint
from runs join games on games.i = runs.gi;

analyze leaderboard_scores;
select count(*) as scores, count(distinct name) as players, count(distinct game) as games from leaderboard_scores;
