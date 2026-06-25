import type { AlertCandidate } from "../../src/domain/models/alert.js";
import { SessionTraceStore } from "../../src/domain/services/session-trace.js";
import { GetRoadContextUseCase } from "../../src/application/use-cases/get-road-context.use-case.js";
import type { AlertRepository } from "../../src/application/ports/alert-repository.js";
import type { RoadContextProvider } from "../../src/application/ports/road-context-provider.js";
import { testConfig } from "../fixtures/config.js";

const baseAlert: AlertCandidate = {
  id: "route-alert",
  type: "fixedSpeedCamera",
  latitude: 45.001,
  longitude: 11,
  speedLimitKmh: 70,
  speedLimitSource: "explicit",
  direction: "forward",
  bearing: 0,
  roadId: "way-1",
  confidence: 0.9,
  active: true,
  validFrom: null,
  validUntil: null,
  source: "test",
  distanceMeters: 100,
};

describe("road-context alert relevance", () => {
  it("labels route alerts explicitly and keeps other generic alerts nearby", async () => {
    const nearbyAlert: AlertCandidate = {
      ...baseAlert,
      id: "nearby-alert",
      latitude: 45.04,
      roadId: "way-2",
      distanceMeters: 5_000,
    };

    const provider: RoadContextProvider = {
      match: async () => ({
        matched: true,
        roadId: "way-1",
        roadName: "Test road",
        speedLimitKmh: 70,
        speedLimitSource: "explicit",
        roadType: "primary",
        confidence: 0.95,
        direction: "forward",
        dataTimestamp: new Date().toISOString(),
        distanceFromTraceMeters: 1,
        bearing: 0,
        valhallaQuality: 1,
      }),
      health: async () => "up",
    };

    const repository: AlertRepository = {
      findNearby: async () => [baseAlert, nearbyAlert],
      hasAvailableAlerts: async () => true,
      getDatasetStatus: async () => "available",
      upsertMany: async () => 0,
      health: async () => "up",
    };

    const useCase = new GetRoadContextUseCase(
      provider,
      repository,
      new SessionTraceStore(180_000),
      testConfig(),
    );

    const response = await useCase.execute({
      latitude: 45,
      longitude: 11,
      speedKmh: 50,
      course: 0,
      horizontalAccuracyMeters: 5,
      timestamp: new Date().toISOString(),
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
    });

    expect(response.alerts.map(({ id, relevance }) => ({ id, relevance }))).toEqual([
      { id: "route-alert", relevance: "route" },
    ]);
    expect(response.genericAlerts.map(({ id, relevance }) => ({ id, relevance }))).toEqual([
      { id: "route-alert", relevance: "route" },
      { id: "nearby-alert", relevance: "nearby" },
    ]);
  });
});
