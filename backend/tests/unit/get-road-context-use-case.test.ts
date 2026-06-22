import { GetRoadContextUseCase } from "../../src/application/use-cases/get-road-context.use-case.js";
import type { AlertRepository } from "../../src/application/ports/alert-repository.js";
import type { RoadContextProvider } from "../../src/application/ports/road-context-provider.js";
import type { RoadMatch } from "../../src/domain/models/road-context.js";
import { SessionTraceStore } from "../../src/domain/services/session-trace.js";
import { testConfig, validPayload } from "../fixtures/config.js";

function matched(timestamp: string, roadId: string): RoadMatch {
  return {
    matched: true,
    roadId,
    roadName: roadId,
    speedLimitKmh: 50,
    speedLimitSource: "explicit",
    roadType: "primary",
    confidence: 0.9,
    direction: "forward",
    dataTimestamp: timestamp,
    distanceFromTraceMeters: 1,
    bearing: 0,
    valhallaQuality: 1,
  };
}

function unmatched(timestamp: string): RoadMatch {
  return {
    matched: false,
    unmatchedReason: "noMatch",
    roadId: null,
    roadName: null,
    speedLimitKmh: null,
    speedLimitSource: "unknown",
    roadType: null,
    confidence: 0,
    direction: "unknown",
    dataTimestamp: timestamp,
    distanceFromTraceMeters: null,
    bearing: null,
    valhallaQuality: 0,
  };
}

function repository(findNearby: AlertRepository["findNearby"]): AlertRepository {
  return {
    findNearby,
    upsertMany: async () => 0,
    health: async () => "up",
  };
}

describe("GetRoadContextUseCase transactional session flow", () => {
  it("rolls back a failed sample so the same timestamp can be retried", async () => {
    const traceStore = new SessionTraceStore(60_000);
    let attempts = 0;
    const provider: RoadContextProvider = {
      match: async ({ sample }) => matched(sample.timestamp, "road-a"),
      health: async () => "up",
    };
    const alerts = repository(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary database failure");
      return [];
    });
    const useCase = new GetRoadContextUseCase(provider, alerts, traceStore, testConfig());

    await expect(useCase.execute(validPayload)).rejects.toThrow("temporary database failure");
    await expect(useCase.execute(validPayload)).resolves.toMatchObject({ roadId: "road-a" });
  });

  it("applies the consecutive unmatched policy only after a successful request", async () => {
    const traceStore = new SessionTraceStore(60_000);
    traceStore.setState(validPayload.sessionId, {
      roadId: "road-a",
      roadType: "primary",
      direction: "forward",
      confidence: 0.8,
    });
    const provider: RoadContextProvider = {
      match: async ({ sample }) => unmatched(sample.timestamp),
      health: async () => "up",
    };
    let shouldFail = true;
    const alerts = repository(async () => {
      if (shouldFail) throw new Error("temporary database failure");
      return [];
    });
    const useCase = new GetRoadContextUseCase(provider, alerts, traceStore, testConfig());

    await expect(useCase.execute(validPayload)).rejects.toThrow("temporary database failure");
    expect(traceStore.getState(validPayload.sessionId)?.confidence).toBe(0.8);

    shouldFail = false;
    await expect(useCase.execute(validPayload)).resolves.toMatchObject({ matched: false });
    expect(traceStore.getState(validPayload.sessionId)?.confidence).toBe(0.8);
  });

  it("does not degrade road state when Valhalla has a provider error", async () => {
    const traceStore = new SessionTraceStore(60_000);
    traceStore.setState(validPayload.sessionId, {
      roadId: "road-a",
      roadType: "primary",
      direction: "forward",
      confidence: 0.8,
    });
    const provider: RoadContextProvider = {
      match: async ({ sample }) => ({
        ...unmatched(sample.timestamp),
        unmatchedReason: "providerError",
      }),
      health: async () => "down",
    };
    const useCase = new GetRoadContextUseCase(
      provider,
      repository(async () => []),
      traceStore,
      testConfig(),
    );

    for (let offset = 0; offset < 3; offset += 1) {
      await expect(
        useCase.execute({
          ...validPayload,
          timestamp: new Date(Date.parse(validPayload.timestamp) + offset * 1_000).toISOString(),
        }),
      ).resolves.toMatchObject({ matched: false });
    }

    expect(traceStore.getState(validPayload.sessionId)).toMatchObject({
      roadId: "road-a",
      confidence: 0.8,
    });
  });

  it("serializes requests of the same session and leaves the newest state committed", async () => {
    const traceStore = new SessionTraceStore(60_000);
    const firstTimestamp = new Date().toISOString();
    const secondTimestamp = new Date(Date.parse(firstTimestamp) + 1_000).toISOString();
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const provider: RoadContextProvider = {
      match: async ({ sample, previousState }) => {
        calls.push(`start:${sample.timestamp}:${previousState?.roadId ?? "none"}`);
        if (sample.timestamp === firstTimestamp) await firstGate;
        calls.push(`end:${sample.timestamp}`);
        return matched(sample.timestamp, sample.timestamp === firstTimestamp ? "road-old" : "road-new");
      },
      health: async () => "up",
    };
    const useCase = new GetRoadContextUseCase(
      provider,
      repository(async () => []),
      traceStore,
      testConfig(),
    );

    const first = useCase.execute({ ...validPayload, timestamp: firstTimestamp });
    const second = useCase.execute({ ...validPayload, timestamp: secondTimestamp });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toEqual([`start:${firstTimestamp}:none`]);

    releaseFirst();
    await Promise.all([first, second]);

    expect(calls).toEqual([
      `start:${firstTimestamp}:none`,
      `end:${firstTimestamp}`,
      `start:${secondTimestamp}:road-old`,
      `end:${secondTimestamp}`,
    ]);
    expect(traceStore.getState(validPayload.sessionId)?.roadId).toBe("road-new");
  });
});
