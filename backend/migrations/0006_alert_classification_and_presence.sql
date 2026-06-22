alter table road_alerts
  add column if not exists direction_bearings double precision[] not null default '{}',
  add column if not exists osm_presence_status text not null default 'present'
    check (osm_presence_status in ('present', 'missingFromLatestImport'));

update road_alerts
set osm_presence_status = case when active then 'present' else 'missingFromLatestImport' end;

create index if not exists road_alerts_osm_presence_status_idx
  on road_alerts (osm_presence_status);

alter table road_alerts drop constraint if exists road_alerts_type_check;
alter table road_alerts add constraint road_alerts_type_check check (
  type in (
    'fixedSpeedCamera',
    'mobileSpeedCamera',
    'redLightCamera',
    'policeControl',
    'accident',
    'roadHazard',
    'roadWorks',
    'roadClosure',
    'information'
  )
);
