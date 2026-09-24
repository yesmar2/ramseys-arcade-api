-- A crowd in this week's official events: 5,000 players in the daily, 5,000
-- in the weekly with about 20,000 runs between them. Throwaway database only.
-- Run after the API has booted once (it creates the day's and week's events),
-- then restart the API so it reads them.
\set players 5000

-- The daily: best score counts, one row per player.
with d as (select id, starts_at from tournaments where id like 'daily-%' order by starts_at desc limit 1)
update tournaments t set data = jsonb_set(jsonb_set(t.data,
  '{players}', (select jsonb_agg(jsonb_build_object(
      'id', 'lp' || i, 'name', 'LT' || lpad(i::text, 5, '0'), 'joinedAt', d.starts_at + i * 7))
    from generate_series(1, :players) i)),
  '{scores}', (select jsonb_agg(jsonb_build_object(
      'playerId', 'lp' || i, 'game', t.data->'games'->>0,
      'score', 100 + (hashtext('d' || i) & 16383), 'at', d.starts_at + i * 11))
    from generate_series(1, :players) i))
from d where t.id = d.id;

-- The weekly: place points over three games, every run kept.
with w as (select id, starts_at from tournaments where id like 'weekly-%' order by starts_at desc limit 1),
runs as (
  select i, g, a
  from generate_series(1, :players) i, generate_series(0, 2) g, generate_series(1, 3) a
  where (hashtext(i || ':' || g) & 7) < 6          -- most players try most games
    and a <= 1 + (hashtext(g || ':' || i) & 1) * 2  -- one run, or three
)
update tournaments t set data = jsonb_set(jsonb_set(t.data,
  '{players}', (select jsonb_agg(jsonb_build_object(
      'id', 'wp' || i, 'name', 'LT' || lpad(i::text, 5, '0'), 'joinedAt', w.starts_at + i * 7))
    from generate_series(1, :players) i)),
  '{scores}', (select jsonb_agg(jsonb_build_object(
      'playerId', 'wp' || r.i, 'game', t.data->'games'->>r.g,
      'score', 10 + (hashtext(r.i || ':' || r.g || ':' || r.a) & 4095),
      'at', w.starts_at + r.i * 13 + r.a, 'attempt', r.a) order by r.i, r.g, r.a)
    from runs r))
from w where t.id = w.id;

select id, jsonb_array_length(data->'players') as players, jsonb_array_length(data->'scores') as scores,
  pg_size_pretty(length(data::text)::bigint) as size
from tournaments order by starts_at desc limit 2;
