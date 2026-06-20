import type { RoadAlert } from "../domain/models/alert.js";

export const mockBaseLatitude = 45.0;
export const mockBaseLongitude = 11.0;

export function createMockAlerts(): RoadAlert[] {
  const now = new Date("2026-01-01T00:00:00Z");
  return [
    alert("camera-1000", "fixedSpeedCamera", 45.00899, 11.0, 70, "forward", 0, "way-mock-primary", 0.98),
    alert("camera-500", "fixedSpeedCamera", 45.0045, 11.0, 70, "forward", 0, "way-mock-primary", 0.97),
    alert("camera-200", "fixedSpeedCamera", 45.0018, 11.0, 50, "forward", 0, "way-mock-primary", 0.96),
    alert("camera-opposite", "fixedSpeedCamera", 45.002, 11.0, 50, "backward", 180, "way-mock-primary", 0.95),
    alert("works-350", "roadWorks", 45.00315, 11.0, null, "unknown", null, "way-mock-primary", 0.8),
    alert("hazard-650", "roadHazard", 45.00585, 11.0, null, "forward", 0, "way-mock-primary", 0.82),
    {
      ...alert("expired-100", "roadHazard", 45.0009, 11.0, null, "forward", 0, "way-mock-primary", 0.9),
      validUntil: new Date("2020-01-01T00:00:00Z"),
    },
    {
      ...alert("inactive-100", "roadWorks", 45.0009, 11.0, null, "forward", 0, "way-mock-primary", 0.9),
      active: false,
    },
    {
      ...alert("parallel-250", "fixedSpeedCamera", 45.00225, 11.00025, 90, "forward", 0, "way-parallel", 0.9),
    },
  ].map((item) => ({ ...item, validFrom: now }));
}

function alert(
  id: string,
  type: RoadAlert["type"],
  latitude: number,
  longitude: number,
  speedLimitKmh: number | null,
  direction: RoadAlert["direction"],
  bearing: number | null,
  roadId: string | null,
  confidence: number,
): RoadAlert {
  const createdAt = new Date("2026-01-01T00:00:00Z");
  return {
    id,
    type,
    latitude,
    longitude,
    speedLimitKmh,
    speedLimitSource: speedLimitKmh === null ? "unknown" : "explicit",
    direction,
    bearing,
    roadId,
    confidence,
    active: true,
    validFrom: null,
    validUntil: null,
    source: "mock",
    createdAt,
    updatedAt: createdAt,
  } as RoadAlert;
}
