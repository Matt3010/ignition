export const alertTypes = [
  "fixedSpeedCamera",
  "mobileSpeedCamera",
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
  distanceMeters?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AlertCandidate extends RoadAlert {
  distanceMeters: number;
}
