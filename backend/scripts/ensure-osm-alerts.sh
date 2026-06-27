#!/usr/bin/env bash
set -euo pipefail

OSM_REGIONS="${OSM_REGIONS:-italy}"
OSM_DATA_DIR="${OSM_DATA_DIR:-./data/osm}"
DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required}"

trim() { local v="$1"; v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"; printf '%s' "$v"; }

read_dataset_state() {
  node --input-type=module - "$DATABASE_URL" <<'NODE'
import pg from "pg";
const pool = new pg.Pool({ connectionString: process.argv[2] });
let exitCode = 0;
try {
  const result = await pool.query(`
    with active_alerts as (
      select count(*)::int as count
      from road_alerts
      where active = true
        and osm_presence_status = 'present'
        and (valid_from is null or valid_from <= now())
        and (valid_until is null or valid_until >= now())
    ), latest_import as (
      select status, records_count
      from data_imports
      where source = 'osm'
      order by imported_at desc, id desc
      limit 1
    )
    select active_alerts.count, latest_import.status, latest_import.records_count
    from active_alerts
    left join latest_import on true
  `);
  const row = result.rows[0] ?? {};
  process.stdout.write([
    Number(row.count ?? 0),
    row.status ?? "never",
    row.records_count === null || row.records_count === undefined ? "-1" : Number(row.records_count),
  ].join("\t"));
} catch (error) {
  if (error?.code === "42P01" || error?.code === "42703") {
    process.stdout.write("0\tschema_pending\t-1");
  } else {
    console.error(JSON.stringify({
      event: "osm_alert_healthcheck_query_failed",
      code: error?.code ?? "unknown",
      message: error?.message ?? String(error),
    }));
    exitCode = 1;
  }
} finally {
  await pool.end();
}
process.exit(exitCode);
NODE
}

classify_state() {
  local active_count="$1" import_status="$2" imported_records="$3"
  if (( active_count > 0 )); then printf 'available'; return; fi
  if [[ "$import_status" == "success" && "$imported_records" == "0" ]]; then printf 'empty'; return; fi
  printf 'unavailable'
}

missing_sources=()
IFS=',' read -r -a raw_regions <<< "$OSM_REGIONS"
for raw in "${raw_regions[@]}"; do
  region="$(trim "$raw")"
  [[ -n "$region" ]] || continue
  source_file="$OSM_DATA_DIR/$region.alerts.osm"
  [[ -s "$source_file" ]] || missing_sources+=("$source_file")
done

state_line="$(read_dataset_state)" || {
  echo '{"event":"osm_alert_healthcheck_failed","reason":"database_unavailable"}' >&2
  exit 3
}
IFS=$'\t' read -r active_count import_status imported_records <<< "$state_line"
if [[ "$import_status" == "schema_pending" ]]; then
  echo '{"event":"osm_alert_healthcheck_deferred","reason":"schema_pending"}' >&2
  exit 6
fi
dataset_status="$(classify_state "$active_count" "$import_status" "$imported_records")"
sources_missing=false
missing_json="[]"
if (( ${#missing_sources[@]} > 0 )); then
  sources_missing=true
  missing_json="$(printf '%s\n' "${missing_sources[@]}" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify(s.trim().split("\n").filter(Boolean))))')"
  echo "{\"event\":\"osm_alert_sources_missing\",\"datasetStatus\":\"$dataset_status\",\"files\":$missing_json}" >&2
fi

if [[ "$dataset_status" == "available" ]]; then
  echo "{\"event\":\"osm_alert_healthcheck_ok\",\"status\":\"available\",\"activeAlerts\":$active_count}"
  if [[ "$sources_missing" == "true" ]]; then exit 5; fi
  exit 0
fi
if [[ "$dataset_status" == "empty" ]]; then
  echo '{"event":"osm_alert_healthcheck_ok","status":"empty","activeAlerts":0,"reason":"last_import_succeeded_with_zero_records"}'
  if [[ "$sources_missing" == "true" ]]; then exit 5; fi
  exit 0
fi

if [[ "$sources_missing" == "true" ]]; then
  echo "{\"event\":\"osm_alert_repair_deferred\",\"reason\":\"missing_sources\",\"files\":$missing_json}" >&2
  exit 2
fi

echo "{\"event\":\"osm_alert_repair_started\",\"reason\":\"dataset_unavailable\",\"lastImportStatus\":\"$import_status\",\"lastImportedRecords\":$imported_records}"
if ! npm run import:osm-alerts; then
  echo '{"event":"osm_alert_repair_failed","reason":"import_failed"}' >&2
  exit 4
fi

state_line="$(read_dataset_state)" || {
  echo '{"event":"osm_alert_repair_failed","reason":"database_unavailable_after_import"}' >&2
  exit 3
}
IFS=$'\t' read -r active_count import_status imported_records <<< "$state_line"
dataset_status="$(classify_state "$active_count" "$import_status" "$imported_records")"
if [[ "$dataset_status" == "unavailable" ]]; then
  echo "{\"event\":\"osm_alert_repair_failed\",\"reason\":\"import_state_inconsistent\",\"lastImportStatus\":\"$import_status\",\"lastImportedRecords\":$imported_records,\"activeAlerts\":$active_count}" >&2
  exit 4
fi

echo "{\"event\":\"osm_alert_repair_finished\",\"status\":\"$dataset_status\",\"activeAlerts\":$active_count}"
