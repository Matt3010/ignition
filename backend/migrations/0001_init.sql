create extension if not exists postgis;
create extension if not exists pgcrypto;

create table if not exists road_alerts (
  id uuid primary key,
  type text not null check (
    type in (
      'fixedSpeedCamera',
      'mobileSpeedCamera',
      'policeControl',
      'accident',
      'roadHazard',
      'roadWorks',
      'roadClosure',
      'information'
    )
  ),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  geometry geometry(Point, 4326) not null,
  speed_limit_kmh integer null check (speed_limit_kmh > 0),
  speed_limit_source text not null default 'unknown' check (speed_limit_source in ('explicit', 'implicit', 'unknown')),
  direction text null check (direction in ('forward', 'backward', 'unknown')),
  bearing double precision null check (bearing >= 0 and bearing < 360),
  road_id text null,
  confidence double precision not null default 0.7 check (confidence >= 0 and confidence <= 1),
  active boolean not null default true,
  valid_from timestamptz null,
  valid_until timestamptz null,
  source text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists road_alerts_geometry_gix on road_alerts using gist (geometry);
create index if not exists road_alerts_active_valid_idx on road_alerts (active, valid_from, valid_until);
create index if not exists road_alerts_road_id_idx on road_alerts (road_id);

create table if not exists data_imports (
  id bigserial primary key,
  source text not null,
  version text not null,
  imported_at timestamptz not null default now(),
  status text not null check (status in ('success', 'failed')),
  records_count integer not null default 0,
  error_message text null
);
