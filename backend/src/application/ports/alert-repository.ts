import type { AlertCandidate, RoadAlert } from "../../domain/models/alert.js";

export interface AlertRepository {
  findNearby(input: { latitude: number; longitude: number; radiusMeters: number }): Promise<AlertCandidate[]>;
  upsertMany(alerts: RoadAlert[]): Promise<number>;
  health(): Promise<"up" | "down">;
}
