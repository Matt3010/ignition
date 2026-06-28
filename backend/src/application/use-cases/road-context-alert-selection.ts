import type { AppConfig } from "../../config/env.js";
import type { AlertCandidate } from "../../domain/models/alert.js";
import type { GpsSample, RoadContextResponse, RoadMatch } from "../../domain/models/road-context.js";
import { filterRelevantAlerts } from "../../domain/services/alert-filter.js";
import { toAlertResponse } from "./road-context-mappers.js";

export function buildRoadContextAlerts(input: {
  nearby: AlertCandidate[];
  match: RoadMatch;
  sample: GpsSample;
  previousPosition: { latitude: number; longitude: number } | null;
  config: AppConfig;
}): Pick<RoadContextResponse, "alerts" | "genericAlerts"> {
  const routeAlerts = filterRelevantAlerts({
    alerts: routeCandidates({
      alerts: input.nearby,
      matchedRoadId: input.match.roadId,
      routeRadiusMeters: input.config.ALERT_SEARCH_RADIUS_METERS,
      includeRouteAlerts: input.match.matched,
    }),
    userCourse: input.sample.course,
    matchedRoadBearing: input.match.bearing,
    userLatitude: input.sample.latitude,
    userLongitude: input.sample.longitude,
    userSpeedKmh: input.sample.speedKmh,
    horizontalAccuracyMeters: input.sample.horizontalAccuracyMeters,
    previousPosition: input.previousPosition,
    behindMinAngleDegrees: input.config.ALERT_BEHIND_MIN_ANGLE_DEGREES,
    behindImmediateAngleDegrees: input.config.ALERT_BEHIND_IMMEDIATE_ANGLE_DEGREES,
    behindMinSpeedKmh: input.config.ALERT_BEHIND_MIN_SPEED_KMH,
    behindMaxGpsAccuracyMeters: input.config.ALERT_BEHIND_MAX_GPS_ACCURACY_METERS,
    behindMinDistanceIncreaseMeters: input.config.ALERT_BEHIND_MIN_DISTANCE_INCREASE_METERS,
  }).map((alert) => toAlertResponse(alert, "route"));

  const routeAlertIds = new Set(routeAlerts.map((alert) => alert.id));
  return {
    alerts: routeAlerts,
    genericAlerts: genericAlertResponses({
      alerts: input.nearby,
      radiusMeters: input.config.GENERIC_ALERT_SEARCH_RADIUS_METERS,
      routeAlertIds,
    }),
  };
}

function routeCandidates(input: {
  alerts: AlertCandidate[];
  matchedRoadId: string | null;
  routeRadiusMeters: number;
  includeRouteAlerts: boolean;
}): AlertCandidate[] {
  if (!input.includeRouteAlerts) return [];
  return input.alerts.filter(
    (alert) =>
      alert.distanceMeters <= input.routeRadiusMeters &&
      isCandidateOnMatchedRoad(alert.roadId, input.matchedRoadId),
  );
}

function genericAlertResponses(input: {
  alerts: AlertCandidate[];
  radiusMeters: number;
  routeAlertIds: Set<string>;
}): RoadContextResponse["genericAlerts"] {
  return input.alerts
    .filter((alert) => alert.distanceMeters <= input.radiusMeters)
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .map((alert) =>
      toAlertResponse(alert, input.routeAlertIds.has(alert.id) ? "route" : "nearby"),
    );
}

function isCandidateOnMatchedRoad(alertRoadId: string | null, matchedRoadId: string | null): boolean {
  if (!alertRoadId || !matchedRoadId) return true;
  return alertRoadId === matchedRoadId;
}
