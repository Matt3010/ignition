import type { AlertCandidate, RoadAlert } from "../../domain/models/alert.js";
import { haversineMeters } from "../../domain/services/geo.js";
import type { AlertRepository } from "../../application/ports/alert-repository.js";

export class InMemoryAlertRepository implements AlertRepository {
  constructor(private alerts: RoadAlert[] = []) {}

  async findNearby(input: { latitude: number; longitude: number; radiusMeters: number }): Promise<AlertCandidate[]> {
    return this.alerts
      .map((alert) => ({
        ...alert,
        distanceMeters: haversineMeters(input.latitude, input.longitude, alert.latitude, alert.longitude),
      }))
      .filter((alert) => alert.distanceMeters <= input.radiusMeters);
  }

  async upsertMany(alerts: RoadAlert[]): Promise<number> {
    const byId = new Map(this.alerts.map((alert) => [alert.id, alert]));
    for (const alert of alerts) byId.set(alert.id, alert);
    this.alerts = [...byId.values()];
    return alerts.length;
  }

  async health(): Promise<"up" | "down"> {
    return "up";
  }
}
