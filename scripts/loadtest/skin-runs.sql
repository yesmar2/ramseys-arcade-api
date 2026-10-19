-- 300 test tags (SKT001..SKT300) with Hot Lap runs on random days of October up to now, a third of them
-- in a skin, so the month's day points have rows that gain, lose and regain a skin. Throwaway world only.
insert into leaderboard_scores (id, game, name, score, at, device, run_id, duration_ms, ip_hash, user_agent, skin)
select
  'skt-' || p || '-' || d || '-' || r,
  'hotlap',
  'SKT' || lpad(p::text, 3, '0'),
  1000000 - (55000 + floor(random() * 40000))::int,
  least(
    (extract(epoch from ((date '2026-10-01' + d)::timestamp at time zone 'America/New_York')) * 1000)::bigint
      + floor(random() * 86000000)::bigint,
    (extract(epoch from now()) * 1000)::bigint - 60000 - floor(random() * 600000)::bigint
  ),
  case when random() < 0.5 then 'phone' else 'desktop' end,
  null, null, null, null,
  case when random() < 0.33 then 'hotlap-green-flash' when random() < 0.25 then 'hotlap-other' else null end
from generate_series(1, 300) p
cross join generate_series(0, 18) d
cross join generate_series(1, 2) r
where random() < 0.45;
