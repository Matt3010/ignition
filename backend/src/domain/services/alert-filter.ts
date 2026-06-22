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
      // A single GPS sample is not enough to prove that an alert has been passed:
      // on hairpins and ramps an alert can be geometrically behind while still ahead
      // along the road. Only suppress it after a second sample proves that the
      // vehicle is moving away and the alert is almost exactly behind.
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
      const movingAway =
        currentDistance >= previousDistance + input.behindMinDistanceIncreaseMeters;
      if (!movingAway) return true;
      return difference < input.behindImmediateAngleDegrees;
    })
    .sort((a, b) => a.distanceMeters - b.distanceMeters);
}
