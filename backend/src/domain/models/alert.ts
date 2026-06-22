export const alertTypes = [
  "fixedSpeedCamera",
  "mobileSpeedCamera",
  "redLightCamera",
  "accessControl",
  "weightControl",
  "genericEnforcement",
  "policeControl",
  "accident",
  "roadHazard",
  "roadWorks",
  "roadClosure",
  "information",
] as const;

export type AlertType = (typeof alertTypes)[number];
export type Direction = "forward" | "backward" | "unknown";
export type SpeedLimitSource = "explicit" | "implicit" | "unknown";
export type OperationalStatus = "operational" | "notOperational" | "unknown";
export type OsmPresenceStatus = "present" | "missingFromLatestImport";

export interface RoadAlert {
  id: string;
  type: AlertType;
  latitude: number;
  longitude: number;
  speedLimitKmh: number | null;
  speedLimitSource: SpeedLimitSource;
  direction: Direction | null;
  bearing: number | null;
  roadId: string | null;
  confidence: number;
  active: boolean;
  validFrom: Date | null;
  validUntil: Date | null;
  source: string;
  osmType?: string | null;
  osmId?: string | null;
  osmRelationId?: string | null;
  osmVersion?: number | null;
  osmTimestamp?: Date | null;
  osmChangeset?: string | null;
  osmUser?: string | null;
  osmUid?: string | null;
  sourceTags?: Record<string, string> | null;
  fixme?: string | null;
  positionApproximate?: boolean;
  operationalStatus?: OperationalStatus;
  statusReason?: string | null;
  directionBearings?: number[];
  osmPresenceStatus?: OsmPresenceStatus;
  originalOsmIds?: string[];
  distanceMeters?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AlertCandidate extends RoadAlert {
  distanceMeters: number;
}
