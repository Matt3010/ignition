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
