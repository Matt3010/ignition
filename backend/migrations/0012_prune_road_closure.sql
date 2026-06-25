delete from road_alerts
where type = 'roadClosure';

alter table road_alerts drop constraint if exists road_alerts_type_check;
alter table road_alerts add constraint road_alerts_type_check check (
  type in (
    'fixedSpeedCamera',
    'averageSpeedCamera',
    'redLightCamera',
    'accessControl'
  )
);
