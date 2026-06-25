delete from road_alerts
where type in (
  'mobileSpeedCamera',
  'accident',
  'information'
);

alter table road_alerts drop constraint if exists road_alerts_type_check;
alter table road_alerts add constraint road_alerts_type_check check (
  type in (
    'fixedSpeedCamera',
    'averageSpeedCamera',
    'redLightCamera',
    'accessControl',
    'weightControl',
    'genericEnforcement',
    'policeControl',
    'roadHazard',
    'roadWorks',
    'roadClosure'
  )
);
