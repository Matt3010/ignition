create index if not exists road_alerts_geography_gix
  on road_alerts using gist ((geometry::geography));
