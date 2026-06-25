import type { AlertCandidate, RoadAlert } from "../../domain/models/alert.js";

export type AlertDatasetStatus = "available" | "empty" | "unavailable";

export interface AlertRepository {
  findNearby(input: { latitude: number; longitude: number; radiusMeters: number }): Promise<AlertCandidate[]>;
  hasAvailableAlerts(): Promise<boolean>;
  getDatasetStatus(): Promise<AlertDatasetStatus>;
  upsertMany(alerts: RoadAlert[]): Promise<number>;
  health(): Promise<"up" | "down">;
}
