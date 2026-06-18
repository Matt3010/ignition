install:
	npm install

dev:
	npm run dev

test:
	npm test

drive-test:
	npm run test:drive

drive-test-real:
	npm run test:drive:real

drive-test-real-chunks:
	npm run test:drive:real:chunks

lint:
	npm run lint

build:
	npm run build

mock-up:
	docker compose -f docker-compose.mock.yml up --build

up:
	docker compose up --build

down:
	docker compose down

migrate:
	npm run migrate

seed:
	npm run seed

import-alerts:
	npm run import:alerts -- --file tests/fixtures/alerts.geojson --source fixture

valhalla-build:
	npm run valhalla:build

valhalla-prefetch:
	npm run valhalla:prefetch

osm-bbox:
	npm run osm:bbox

osm-bbox-direct:
	npm run osm:bbox:direct

health:
	npm run health
