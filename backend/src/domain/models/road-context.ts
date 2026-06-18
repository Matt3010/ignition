import type { AlertCandidate, Direction } from "./alert.js";

export interface GpsSample {
  latitude: number;
  longitude: number;
  speedKmh: number;
  course: number | null;
  horizontalAccuracyMeters: number;
  timestamp: string;
  sessionId: string;
}

export interface MatchedRoad {
  matched: true;
  roadId: string | null;
  roadName: string | null;
  speedLimitKmh: number | null;
  roadType: string | null;
  confidence: number;
  direction: Direction;
  dataTimestamp: string;
  distanceFromTraceMeters: number | null;
  bearing: number | null;
  valhallaQuality: number;
}

export interface UnmatchedRoad {
  matched: false;
  roadId: null;
  roadName: null;
  speedLimitKmh: null;
  roadType: null;
  confidence: number;
  direction: "unknown";
  dataTimestamp: string;
  distanceFromTraceMeters: number | null;
  bearing: number | null;
  valhallaQuality: number;
}

export type RoadMatch = MatchedRoad | UnmatchedRoad;

export interface RoadContextResponse extends Omit<RoadMatch, "distanceFromTraceMeters" | "bearing" | "valhallaQuality"> {
  alerts: Array<{
    id: string;
    type: AlertCandidate["type"];
    distanceMeters: number;
    speedLimitKmh: number | null;
    latitude: number;
    longitude: number;
    direction: Direction;
    confidence: number;
  }>;
}

export interface SessionRoadState {
  roadId: string | null;
  roadType: string | null;
  direction: Direction;
  confidence: number;
  updatedAt: number;
}
