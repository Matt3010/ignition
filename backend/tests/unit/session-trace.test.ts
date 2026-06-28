import {
  assertSampleIsNewer,
  nextRoadStateAfterMatchMiss,
  previousTracePosition,
  pruneTraceSamples,
  SessionTraceStore,
} from "../../src/domain/services/session-trace.js";
import { validPayload } from "../fixtures/config.js";

describe("SessionTraceStore", () => {
  it("keeps recent samples only", () => {
    const store = new SessionTraceStore(10000, 2);
    const baseTime = Date.now();
    store.add({ ...validPayload, timestamp: new Date(baseTime).toISOString() });
    store.add({ ...validPayload, timestamp: new Date(baseTime + 1000).toISOString() });
    const trace = store.add({ ...validPayload, timestamp: new Date(baseTime + 2000).toISOString() });
    expect(trace).toHaveLength(2);
  });

  it("keeps the trace when no previous road state exists", () => {
    const store = new SessionTraceStore(10000, 8);
    const baseTime = Date.now();
    store.add({ ...validPayload, timestamp: new Date(baseTime).toISOString() });
    expect(store.getState(validPayload.sessionId)).toBeNull();
    const trace = store.add({ ...validPayload, timestamp: new Date(baseTime + 1000).toISOString() });
    expect(trace).toHaveLength(2);
  });

  it("drops samples that are too far in the future", () => {
    const store = new SessionTraceStore(10_000, 8, 5_000, 5_000);
    const trace = store.add({
      ...validPayload,
      timestamp: new Date(Date.now() + 6_000).toISOString(),
    });
    expect(trace).toHaveLength(0);
  });

  it("rejects duplicate and out-of-order samples without mutating the trace", () => {
    const store = new SessionTraceStore(10_000, 8);
    const baseTime = Date.now();
    const first = { ...validPayload, timestamp: new Date(baseTime).toISOString() };
    const second = { ...validPayload, timestamp: new Date(baseTime + 1_000).toISOString() };

    store.add(first);
    store.add(second);

    expect(() => store.add({ ...validPayload, timestamp: first.timestamp })).toThrow(
      "Campione GPS non successivo all'ultimo campione elaborato",
    );
    expect(() => store.add({ ...validPayload, timestamp: second.timestamp })).toThrow(
      "Campione GPS non successivo all'ultimo campione elaborato",
    );

    const trace = store.add({ ...validPayload, timestamp: new Date(baseTime + 2_000).toISOString() });
    expect(trace.map((sample) => sample.timestamp)).toEqual([
      first.timestamp,
      second.timestamp,
      new Date(baseTime + 2_000).toISOString(),
    ]);
  });

  it("rolls back only the matching latest sample", () => {
    const store = new SessionTraceStore(10_000, 8);
    const baseTime = Date.now();
    const first = { ...validPayload, timestamp: new Date(baseTime).toISOString() };
    const second = { ...validPayload, timestamp: new Date(baseTime + 1_000).toISOString() };

    store.add(first);
    store.add(second);
    store.rollbackLast(validPayload.sessionId, first.timestamp);

    expect(() => store.add({ ...validPayload, timestamp: second.timestamp })).toThrow();
    store.rollbackLast(validPayload.sessionId, second.timestamp);
    expect(() => store.add({ ...validPayload, timestamp: second.timestamp })).not.toThrow();
  });

  it("preserves, degrades, and then clears road state after consecutive match misses", () => {
    const store = new SessionTraceStore(10_000);
    store.setState(validPayload.sessionId, {
      roadId: "road-a",
      roadType: "primary",
      direction: "forward",
      confidence: 0.8,
    });

    store.registerMatchMiss(validPayload.sessionId);
    expect(store.getState(validPayload.sessionId)).toMatchObject({
      roadId: "road-a",
      confidence: 0.8,
    });

    store.registerMatchMiss(validPayload.sessionId);
    expect(store.getState(validPayload.sessionId)).toMatchObject({
      roadId: "road-a",
      confidence: 0.4,
    });

    store.registerMatchMiss(validPayload.sessionId);
    expect(store.getState(validPayload.sessionId)).toBeNull();
  });

  it("resets consecutive match misses when a new road match is committed", () => {
    const store = new SessionTraceStore(10_000);
    store.setState(validPayload.sessionId, {
      roadId: "road-a",
      roadType: "primary",
      direction: "forward",
      confidence: 0.8,
    });
    store.registerMatchMiss(validPayload.sessionId);
    store.registerMatchMiss(validPayload.sessionId);

    store.setState(validPayload.sessionId, {
      roadId: "road-b",
      roadType: "secondary",
      direction: "forward",
      confidence: 0.9,
    });
    store.registerMatchMiss(validPayload.sessionId);

    expect(store.getState(validPayload.sessionId)).toMatchObject({
      roadId: "road-b",
      confidence: 0.9,
    });
  });

  it("does not refresh session recency when a duplicate sample is rejected", () => {
    const store = new SessionTraceStore(60_000, 8, 2);
    const baseTime = Date.now();
    const sessionA = "00000000-0000-4000-8000-00000000000a";
    const sessionB = "00000000-0000-4000-8000-00000000000b";
    const sessionC = "00000000-0000-4000-8000-00000000000c";
    const sampleA = { ...validPayload, sessionId: sessionA, timestamp: new Date(baseTime).toISOString() };
    const sampleB = { ...validPayload, sessionId: sessionB, timestamp: new Date(baseTime + 1).toISOString() };

    store.add(sampleA);
    store.add(sampleB);
    expect(() => store.add(sampleA)).toThrow();
    store.add({ ...validPayload, sessionId: sessionC, timestamp: new Date(baseTime + 2).toISOString() });

    expect(() => store.add(sampleB)).toThrow();
    expect(() => store.add(sampleA)).not.toThrow();
  });
});

describe("session trace helpers", () => {
  it("returns the previous trace position from the second-to-last sample", () => {
    const baseTime = Date.now();
    const trace = [
      { ...validPayload, latitude: 45.1, longitude: 11.1, timestamp: new Date(baseTime).toISOString() },
      { ...validPayload, latitude: 45.2, longitude: 11.2, timestamp: new Date(baseTime + 1_000).toISOString() },
      { ...validPayload, latitude: 45.3, longitude: 11.3, timestamp: new Date(baseTime + 2_000).toISOString() },
    ];

    expect(previousTracePosition(trace)).toEqual({ latitude: 45.2, longitude: 11.2 });
    expect(previousTracePosition(trace.slice(0, 1))).toBeNull();
  });

  it("prunes expired, too-far future, and excess trace samples", () => {
    const now = Date.now();
    const samples = [
      { ...validPayload, timestamp: new Date(now - 11_000).toISOString(), sessionId: "expired" },
      { ...validPayload, timestamp: new Date(now - 2_000).toISOString(), sessionId: "older" },
      { ...validPayload, timestamp: new Date(now - 1_000).toISOString(), sessionId: "recent" },
      { ...validPayload, timestamp: new Date(now + 6_000).toISOString(), sessionId: "future" },
    ];

    expect(pruneTraceSamples({
      samples,
      now,
      ttlMs: 10_000,
      maxFutureSkewMs: 5_000,
      maxSamples: 1,
    }).map((sample) => sample.sessionId)).toEqual(["recent"]);
  });

  it("validates that a new sample is newer than the latest trace sample", () => {
    const baseTime = Date.now();
    const first = { ...validPayload, timestamp: new Date(baseTime).toISOString() };
    const second = { ...validPayload, timestamp: new Date(baseTime + 1_000).toISOString() };

    expect(() => assertSampleIsNewer([first], second)).not.toThrow();
    expect(() => assertSampleIsNewer([second], first)).toThrow(
      "Campione GPS non successivo all'ultimo campione elaborato",
    );
    expect(() => assertSampleIsNewer([second], { ...validPayload, timestamp: second.timestamp })).toThrow(
      "Campione GPS non successivo all'ultimo campione elaborato",
    );
  });

  it("computes the next road state after consecutive match misses", () => {
    const state = {
      roadId: "road-a",
      roadType: "primary",
      direction: "forward" as const,
      confidence: 0.8,
      updatedAt: 100,
    };

    expect(nextRoadStateAfterMatchMiss({
      state,
      misses: 1,
      clearStateAfterMisses: 3,
      confidenceDecayFactor: 0.5,
      updatedAt: 200,
    })).toBe(state);
    expect(nextRoadStateAfterMatchMiss({
      state,
      misses: 2,
      clearStateAfterMisses: 3,
      confidenceDecayFactor: 0.5,
      updatedAt: 200,
    })).toMatchObject({ confidence: 0.4, updatedAt: 200 });
    expect(nextRoadStateAfterMatchMiss({
      state,
      misses: 3,
      clearStateAfterMisses: 3,
      confidenceDecayFactor: 0.5,
      updatedAt: 200,
    })).toBeNull();
  });
});
