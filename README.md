# Ignition

Ignition is a motorcycle road-context assistant. It combines an iOS GPS recorder with a TypeScript backend that performs map matching through Valhalla, reads road metadata from OpenStreetMap data, and returns speed limits plus selected static road alerts such as fixed speed cameras, average-speed cameras, red-light cameras, and access-control zones.

The backend is designed to run locally or on a small server such as a Raspberry Pi. It does not permanently store user GPS traces; it keeps only a short in-memory session trace to improve road continuity.

## Repository Layout

```text
backend/        Fastify API, domain logic, PostgreSQL/PostGIS migrations, OSM and Valhalla tooling
ios/            Swift iOS client that records GPS samples and calls the backend
server-deploy/  Minimal Docker Compose deployment bundle for servers
.github/        CI workflow for backend, Swift syntax checks, PostGIS, Valhalla, and image publishing
```

More detailed component documentation is available in:

- [backend/README.md](backend/README.md)
- [ios/RoadRecorder/README.md](ios/RoadRecorder/README.md)
- [server-deploy/README.md](server-deploy/README.md)

## Backend Features

- Fastify HTTP API with Zod validation and OpenAPI documentation.
- Valhalla-backed map matching for road context and speed-limit lookup.
- PostgreSQL/PostGIS storage for imported static OSM alerts.
- OSM download, alert extraction, Valhalla tile building, and refresh scripts.
- Deterministic unit and integration tests that do not require internet access.
- Optional live integration suites for PostGIS, Valhalla, full-stack checks, runtime failures, and network faults.
- Docker Compose stack for backend, PostgreSQL/PostGIS, Valhalla, and OSM maintenance.

## Requirements

- Node.js 20.11 or newer
- npm
- Docker and Docker Compose
- Bash-compatible shell for OSM and Valhalla scripts
- Xcode for the iOS app

For real map matching, Valhalla needs prebuilt graph tiles generated from OSM extracts. The included maintenance scripts can download supported Geofabrik regions and build those tiles.

## Backend Quick Start

```bash
cd backend
npm install
cp .env.example .env
npm run build
npm test
npm run dev
```

The API listens on port `3000` by default.

Useful endpoints:

- `POST /api/v1/road-context`
- `GET /health`
- `GET /ready`
- `GET /api/v1/config`
- `GET /documentation`

Example request:

```bash
curl -X POST http://127.0.0.1:3000/api/v1/road-context \
  -H 'content-type: application/json' \
  -d '{
    "latitude": 45.0,
    "longitude": 11.0,
    "speedKmh": 72.5,
    "course": 0,
    "horizontalAccuracyMeters": 6.0,
    "timestamp": "2026-06-17T20:30:00Z",
    "sessionId": "550e8400-e29b-41d4-a716-446655440000"
  }'
```

## Common Backend Commands

Run these from `backend/`.

```bash
npm run dev                  # Start the development server
npm run build                # Compile TypeScript
npm run lint                 # Run ESLint
npm test                     # Run deterministic unit and integration tests
npm run verify:local         # Build, lint, and run deterministic tests
npm run migrate              # Apply PostgreSQL migrations
npm run osm:download         # Download configured OSM extracts
npm run valhalla:build       # Build Valhalla tiles
npm run import:osm-alerts    # Import static OSM alerts into PostGIS
npm run osm:refresh          # Run the OSM refresh pipeline once
```

## Local Docker Stack

From `backend/`:

```bash
cp .env.example .env
docker compose up --build
```

The Compose stack includes:

- `backend`: Fastify API
- `postgres`: PostgreSQL 16 with PostGIS
- `valhalla`: Valhalla service using local tile data
- `osm-refresh`: optional maintenance profile for recurring OSM refreshes

To run maintenance:

```bash
docker compose --profile maintenance up -d osm-refresh
```

## OSM and Valhalla Workflow

The default OSM region is Italy. Multiple supported regions can be configured with a comma-separated list:

```env
OSM_REGIONS=italy,france,switzerland
```

Typical real-data setup:

```bash
cd backend
npm run osm:download
npm run valhalla:build
docker compose up -d postgres valhalla
DATABASE_URL=postgres://road:road@127.0.0.1:5433/road_context npm run migrate
DATABASE_URL=postgres://road:road@127.0.0.1:5433/road_context npm run import:osm-alerts
docker compose up -d backend
```

For Raspberry Pi deployments, build large Valhalla tile sets on a more powerful machine when possible, then transfer the generated `data/valhalla` directory.

## iOS App

The iOS app lives in `ios/RoadRecorder`. It records GPS samples and sends them to `POST /api/v1/road-context`.

Build example:

```bash
cd ios/RoadRecorder
xcodebuild -project RoadRecorder.xcodeproj -scheme RoadRecorder -sdk iphonesimulator build
```

The backend URL is configured inside the app and persisted locally after the user sets it.

## Server Deployment

Use `server-deploy/` when deploying a published container image to a server. This folder is intentionally minimal and does not require the full source tree, Node.js, or npm on the target machine.

Basic flow on the server:

```bash
cp .env.example .env
nano .env
docker compose up -d
```

For updates after CI publishes a new image:

```bash
./update.sh
```

See [server-deploy/README.md](server-deploy/README.md) for the complete deployment procedure and operational checks.

## Testing

Deterministic tests:

```bash
cd backend
npm test
```

Full local verification:

```bash
npm run verify:local
```

Live integration suites require running services and explicit environment flags:

```bash
RUN_DB_INTEGRATION=1 DATABASE_URL=postgres://road:road@127.0.0.1:5432/road_context npm run test:postgis
RUN_VALHALLA_INTEGRATION=1 VALHALLA_BASE_URL=http://127.0.0.1:8002 npm run test:valhalla
```

## Privacy and Safety Notes

- User GPS samples are not permanently stored by the backend.
- Session traces are kept only in memory for a configurable short TTL.
- Production logs redact full coordinates and anonymize session identifiers.
- SQL access uses parameterized queries.
- API input is validated with Zod and protected by rate limiting, CORS settings, payload limits, and normalized error handling.

## Known Limitations

- Road data quality depends on the configured OpenStreetMap extracts.
- `speedLimitKmh` can be `null` when OSM or Valhalla does not provide a reliable value.
- Live dynamic traffic incidents are not included without an external authorized source.
- The current alert model focuses on selected static alert types only.
- Map matching works only inside areas covered by the prepared Valhalla tiles.
