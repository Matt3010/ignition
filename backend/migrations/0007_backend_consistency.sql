alter table road_alerts
  add column if not exists osm_version integer null,
  add column if not exists osm_timestamp timestamptz null,
  add column if not exists osm_changeset text null,
  add column if not exists osm_user text null,
  add column if not exists osm_uid text null;

alter table road_alerts drop constraint if exists road_alerts_type_check;
alter table road_alerts add constraint road_alerts_type_check check (
  type in (
    'fixedSpeedCamera',
    'mobileSpeedCamera',
    'redLightCamera',
    'accessControl',
    'weightControl',
    'genericEnforcement',
    'policeControl',
    'accident',
    'roadHazard',
    'roadWorks',
    'roadClosure',
    'information'
  )
);

create index if not exists road_alerts_osm_timestamp_idx on road_alerts (osm_timestamp);
