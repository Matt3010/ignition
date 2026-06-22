alter table road_alerts
  add column if not exists operational_status text not null default 'unknown'
    check (operational_status in ('operational', 'notOperational', 'unknown')),
  add column if not exists status_reason text null;

create index if not exists road_alerts_operational_status_idx
  on road_alerts (active, operational_status);
