alter table road_alerts
  add column if not exists subtype text null,
  add column if not exists capabilities text[] not null default array[]::text[],
  add column if not exists primary_capability text null;

alter table road_alerts drop constraint if exists road_alerts_type_check;
alter table road_alerts add constraint road_alerts_type_check check (
  type in (
    'fixedSpeedCamera',
    'averageSpeedCamera',
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
