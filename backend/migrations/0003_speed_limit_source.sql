alter table road_alerts
  add column if not exists speed_limit_source text not null default 'unknown'
    check (speed_limit_source in ('explicit', 'implicit', 'unknown'));

update road_alerts
set speed_limit_source = 'explicit'
where speed_limit_kmh is not null
  and speed_limit_source = 'unknown';
