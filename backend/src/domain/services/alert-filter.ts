import type { AlertCandidate, Direction } from "../models/alert.js";
import { isDirectionCompatible } from "./geo.js";

export interface AlertFilterInput {
  alerts: AlertCandidate[];
  roadId: string | null;
  userCourse: number | null;
  direction: Direction;
  directionToleranceDegrees: number;
  now: Date;
  limit: number;
}

export function filterRelevantAlerts(input: AlertFilterInput): AlertCandidate[] {
  return input.alerts
    .filter((alert) => alert.active)
    .filter((alert) => !alert.validFrom || alert.validFrom <= input.now)
    .filter((alert) => !alert.validUntil || alert.validUntil >= input.now)
    .filter((alert) => {
      if (input.roadId && alert.roadId && alert.roadId !== input.roadId) return false;
      if (alert.direction && alert.direction !== "unknown" && input.direction !== "unknown") {
        if (alert.direction !== input.direction) return false;
      }
      return isDirectionCompatible(input.userCourse, alert.bearing, input.directionToleranceDegrees);
    })
    .map((alert) => ({
      ...alert,
      confidence: alert.bearing === null ? Math.min(alert.confidence, 0.75) : alert.confidence,
    }))
    .sort((a, b) => {
      const roadA = input.roadId && a.roadId === input.roadId ? -10000 : 0;
      const roadB = input.roadId && b.roadId === input.roadId ? -10000 : 0;
      return a.distanceMeters + roadA - (b.distanceMeters + roadB);
    })
    .slice(0, input.limit);
}
