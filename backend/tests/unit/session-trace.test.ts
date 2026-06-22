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
