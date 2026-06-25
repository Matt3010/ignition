import type {
  AlertCandidate,
  Direction,
  OperationalStatus,
  OsmPresenceStatus,
  SpeedLimitSource,
} from "./alert.js";

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
  speedLimitSource: SpeedLimitSource;
  roadType: string | null;
  confidence: number;
  direction: Direction;
  dataTimestamp: string;
  distanceFromTraceMeters: number | null;
  bearing: number | null;
  valhallaQuality: number;
}

export type UnmatchedReason = "noMatch" | "providerError";
export type PublicMatchStatus = "matched" | "noMatch" | "providerUnavailable";

export interface UnmatchedRoad {
  matched: false;
  unmatchedReason: UnmatchedReason;
  roadId: null;
  roadName: null;
  speedLimitKmh: null;
  speedLimitSource: "unknown";
  roadType: null;
  confidence: number;
  direction: "unknown";
  dataTimestamp: string;
  distanceFromTraceMeters: number | null;
  bearing: number | null;
  valhallaQuality: number;
}

export type RoadMatch = MatchedRoad | UnmatchedRoad;

export interface RoadContextResponse extends Omit<
  RoadMatch,
  "distanceFromTraceMeters" | "bearing" | "valhallaQuality" | "unmatchedReason"
> {
  matchStatus: PublicMatchStatus;
  alertsStatus: "available" | "empty" | "unavailable";
  alerts: Array<{
    id: string;
    type: AlertCandidate["type"];
    subtype: string | null;
    capabilities: string[];
    primaryCapability: string | null;
    distanceMeters: number;
    speedLimitKmh: number | null;
    speedLimitSource: SpeedLimitSource;
    latitude: number;
    longitude: number;
    direction: Direction;
    confidence: number;
    operationalStatus: OperationalStatus;
    statusReason: string | null;
    directionBearings: number[];
    osmPresenceStatus: OsmPresenceStatus;
    active: boolean;
    positionApproximate: boolean;
    osmType: string | null;
    osmId: string | null;
    osmRelationId: string | null;
    osmTimestamp: string | null;
  }>;
  genericAlerts: Array<{
    id: string;
    type: AlertCandidate["type"];
    subtype: string | null;
    capabilities: string[];
    primaryCapability: string | null;
    distanceMeters: number;
    speedLimitKmh: number | null;
    speedLimitSource: SpeedLimitSource;
    latitude: number;
    longitude: number;
    direction: Direction;
    confidence: number;
    operationalStatus: OperationalStatus;
    statusReason: string | null;
    directionBearings: number[];
    osmPresenceStatus: OsmPresenceStatus;
    active: boolean;
    positionApproximate: boolean;
    osmType: string | null;
    osmId: string | null;
    osmRelationId: string | null;
    osmTimestamp: string | null;
  }>;
}

export interface SessionRoadState {
  roadId: string | null;
  roadType: string | null;
  direction: Direction;
  confidence: number;
  updatedAt: number;
}
