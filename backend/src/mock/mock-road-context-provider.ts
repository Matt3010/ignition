import type { RoadContextProvider } from "../application/ports/road-context-provider.js";
import type { GpsSample, MatchedRoad, RoadMatch } from "../domain/models/road-context.js";
import { calculateRoadConfidence } from "../domain/services/confidence.js";
import { haversineMeters, initialBearing } from "../domain/services/geo.js";
import { mockBaseLongitude } from "./mock-data.js";

const allowedScenarios = new Set([
  "limit50",
  "limit70",
  "lowConfidence",
  "matchedFalse",
  "timeout",
  "httpError",
  "slow",
  "nullLimit",
  "parallelRoad",
  "staleData",
]);

export class MockRoadContextProvider implements RoadContextProvider {
  constructor(private readonly production: boolean) {}

  async match(input: Parameters<RoadContextProvider["match"]>[0]): Promise<RoadMatch> {
    const scenario = this.resolveScenario(input.sample, input.scenario);

    if (scenario === "timeout") {
      await new Promise((resolve) => setTimeout(resolve, 3500));
      throw new Error("Mock Valhalla timeout");
    }
    if (scenario === "httpError") throw new Error("Mock Valhalla HTTP error");
    if (scenario === "slow") await new Promise((resolve) => setTimeout(resolve, 500));

    if (scenario === "matchedFalse") {
      return {
        matched: false,
        unmatchedReason: "noMatch",
        roadId: null,
        roadName: null,
        speedLimitKmh: null,
        speedLimitSource: "unknown",
        roadType: null,
        confidence: 0.18,
        direction: "unknown",
        dataTimestamp: input.sample.timestamp,
        distanceFromTraceMeters: null,
        bearing: null,
        valhallaQuality: 0.18,
      };
    }

    const distanceFromMockRoad = Math.min(
      haversineMeters(input.sample.latitude, input.sample.longitude, input.sample.latitude, mockBaseLongitude),
      45,
    );
    const roadId = scenario === "parallelRoad" ? "way-parallel" : "way-mock-primary";
    const speedLimitKmh =
      scenario === "nullLimit" ? null : scenario === "limit70" || input.sample.speedKmh >= 65 ? 70 : 50;
    const base: Omit<MatchedRoad, "confidence"> = {
      matched: true,
      roadId,
      roadName: scenario === "parallelRoad" ? "Complanare mock" : "SR308 Mock",
      speedLimitKmh,
      speedLimitSource: speedLimitKmh === null ? "unknown" : "explicit",
      roadType: scenario === "parallelRoad" ? "secondary_link" : "primary",
      direction: "forward",
      dataTimestamp:
        scenario === "staleData" ? new Date(Date.parse(input.sample.timestamp) - 86400000).toISOString() : input.sample.timestamp,
      distanceFromTraceMeters: distanceFromMockRoad,
      bearing:
        input.trace.length >= 2
          ? initialBearing(
              input.trace.at(-2)!.latitude,
              input.trace.at(-2)!.longitude,
              input.sample.latitude,
              input.sample.longitude,
            )
          : 0,
      valhallaQuality: scenario === "lowConfidence" ? 0.35 : 0.92,
    };
    const confidence =
      scenario === "lowConfidence"
        ? 0.34
        : calculateRoadConfidence({
            sample: input.sample,
            match: base,
            previousState: input.previousState,
            candidateAlternatives:
              scenario === "parallelRoad"
                ? [{ roadId: "way-mock-primary", distanceMeters: distanceFromMockRoad + 3, bearing: 0 }]
                : [],
          });
    return { ...base, confidence };
  }

  async health(): Promise<"up" | "down"> {
    return "up";
  }

  private resolveScenario(sample: GpsSample, requested: string | null | undefined): string {
    if (requested && (!this.production || allowedScenarios.has(requested))) return requested;
    const bucket = Math.abs(hash(`${sample.sessionId}:${sample.latitude.toFixed(4)}:${sample.longitude.toFixed(4)}`)) % 10;
    if (bucket === 0) return "limit70";
    if (bucket === 1) return "lowConfidence";
    if (bucket === 2) return "nullLimit";
    return "limit50";
  }
}

function hash(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) | 0;
  }
  return result;
}
