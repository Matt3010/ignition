import type { AlertCandidate, Direction } from "../models/alert.js";
import { angularDifference, initialBearing } from "./geo.js";

export interface AlertFilterInput {
  alerts: AlertCandidate[];
  roadId: string | null;
  userCourse: number | null;
  direction: Direction;
  directionToleranceDegrees: number;
  unassignedMaxDistanceMeters: number;
  unmatchedMaxDistanceMeters: number;
  userLatitude?: number;
  userLongitude?: number;
  aheadToleranceDegrees?: number;
  minConfidence?: number;
  now: Date;
  limit: number;
}

export function filterRelevantAlerts(input: AlertFilterInput): AlertCandidate[] {
  return input.alerts
    .filter((alert) => {
      // Deliberately the only destructive filter: suppress alerts behind the vehicle.
      // Unknown course means we cannot prove the alert is behind, so it is retained.
      if (
        input.userCourse === null ||
        input.userLatitude === undefined ||
        input.userLongitude === undefined
      ) return true;
      const bearingToAlert = initialBearing(
        input.userLatitude,
        input.userLongitude,
        alert.latitude,
        alert.longitude,
      );
      const difference = angularDifference(input.userCourse, bearingToAlert);
      return difference === null || difference <= (input.aheadToleranceDegrees ?? 90);
    })
    .sort((a, b) => a.distanceMeters - b.distanceMeters);
}
