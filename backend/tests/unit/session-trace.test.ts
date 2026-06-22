import { SessionTraceStore } from "../../src/domain/services/session-trace.js";
import { validPayload } from "../fixtures/config.js";

describe("session trace", () => {
  it("keeps recent samples only", () => {
    const store = new SessionTraceStore(10000, 2);
    const baseTime = Date.now();
    store.add({ ...validPayload, timestamp: new Date(baseTime).toISOString() });
    store.add({ ...validPayload, timestamp: new Date(baseTime + 1000).toISOString() });
    const trace = store.add({ ...validPayload, timestamp: new Date(baseTime + 2000).toISOString() });
    expect(trace).toHaveLength(2);
  });
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
