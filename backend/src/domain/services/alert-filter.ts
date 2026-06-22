import type { AlertCandidate } from "../models/alert.js";
import { angularDifference, haversineMeters, initialBearing } from "./geo.js";

export interface AlertFilterInput {
  alerts: AlertCandidate[];
  userCourse: number | null;
  matchedRoadBearing: number | null;
  userLatitude: number;
  userLongitude: number;
  userSpeedKmh: number;
  horizontalAccuracyMeters: number;
  previousPosition: { latitude: number; longitude: number } | null;
  behindMinAngleDegrees: number;
  behindImmediateAngleDegrees: number;
  behindMinSpeedKmh: number;
  behindMaxGpsAccuracyMeters: number;
  behindMinDistanceIncreaseMeters: number;
}

export function filterRelevantAlerts(input: AlertFilterInput): AlertCandidate[] {
  const travelBearing = input.matchedRoadBearing ?? input.userCourse;
  return input.alerts
    .filter((alert) => {
      if (
        travelBearing === null ||
        input.userSpeedKmh < input.behindMinSpeedKmh ||
        input.horizontalAccuracyMeters > input.behindMaxGpsAccuracyMeters
      ) return true;

      const bearingToAlert = initialBearing(input.userLatitude, input.userLongitude, alert.latitude, alert.longitude);
      const difference = angularDifference(travelBearing, bearingToAlert);
      if (difference === null || difference < input.behindMinAngleDegrees) return true;
      if (difference >= input.behindImmediateAngleDegrees && alert.roadId === null) return false;
      if (!input.previousPosition) return true;

      const previousDistance = haversineMeters(
        input.previousPosition.latitude,
        input.previousPosition.longitude,
        alert.latitude,
        alert.longitude,
      );
      const currentDistance = haversineMeters(
        input.userLatitude,
        input.userLongitude,
        alert.latitude,
        alert.longitude,
      );
      return currentDistance < previousDistance + input.behindMinDistanceIncreaseMeters;
    })
    .sort((a, b) => a.distanceMeters - b.distanceMeters);
}
