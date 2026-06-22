alter table road_alerts
  add column if not exists osm_type text null,
  add column if not exists osm_id text null,
  add column if not exists osm_relation_id text null,
  add column if not exists source_tags jsonb null,
  add column if not exists fixme text null,
  add column if not exists position_approximate boolean not null default false,
  add column if not exists original_osm_ids text[] not null default '{}';

create index if not exists road_alerts_osm_identity_idx on road_alerts (source, osm_type, osm_id);
create index if not exists road_alerts_confidence_idx on road_alerts (active, confidence);
