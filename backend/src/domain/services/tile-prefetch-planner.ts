import type { GpsSample } from "../models/road-context.js";

export interface TilePrefetchPlanItem {
  region: string;
  bbox: string;
  centerLat: number;
  centerLon: number;
}

export interface TilePrefetchPlannerOptions {
  prefix: string;
  halfLat: number;
  halfLon: number;
  gridDegrees: number;
  lookaheadChunks: number;
  lookaheadMeters: number;
}

const earthRadiusMeters = 6_371_000;

export function planTilePrefetch(
  sample: GpsSample,
  options: TilePrefetchPlannerOptions,
): TilePrefetchPlanItem[] {
  const targets = [{ latitude: sample.latitude, longitude: sample.longitude }];
  if (sample.course !== null) {
    for (let index = 1; index <= options.lookaheadChunks; index += 1) {
      targets.push(movePoint(sample.latitude, sample.longitude, sample.course, options.lookaheadMeters * index));
    }
  }

  const byRegion = new Map<string, TilePrefetchPlanItem>();
  for (const target of targets) {
    const centerLat = snap(target.latitude, options.gridDegrees);
    const centerLon = snap(target.longitude, options.gridDegrees);
    const region = `${options.prefix}-${encodeCoord(centerLat)}-${encodeCoord(centerLon)}`;
    byRegion.set(region, {
      region,
      bbox: [
        formatCoord(centerLon - options.halfLon),
        formatCoord(centerLat - options.halfLat),
        formatCoord(centerLon + options.halfLon),
        formatCoord(centerLat + options.halfLat),
      ].join(","),
      centerLat,
      centerLon,
    });
  }
  return [...byRegion.values()];
}

function movePoint(latitude: number, longitude: number, bearingDegrees: number, distanceMeters: number) {
  const angularDistance = distanceMeters / earthRadiusMeters;
  const bearing = toRadians(bearingDegrees);
  const lat1 = toRadians(latitude);
  const lon1 = toRadians(longitude);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
    );
  return {
    latitude: toDegrees(lat2),
    longitude: toDegrees(lon2),
  };
}

function snap(value: number, gridDegrees: number): number {
  return Number((Math.round(value / gridDegrees) * gridDegrees).toFixed(6));
}

function encodeCoord(value: number): string {
  return formatCoord(value).replace("-", "m").replace(".", "p");
}

function formatCoord(value: number): string {
  return value.toFixed(6);
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function toDegrees(value: number): number {
  return (value * 180) / Math.PI;
}
