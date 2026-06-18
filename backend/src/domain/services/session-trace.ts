import type { GpsSample, SessionRoadState } from "../models/road-context.js";

export class SessionTraceStore {
  private readonly traces = new Map<string, GpsSample[]>();
  private readonly roadStates = new Map<string, SessionRoadState>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxSamples = 8,
  ) {}

  add(sample: GpsSample): GpsSample[] {
    const now = Date.now();
    const previous = this.traces.get(sample.sessionId) ?? [];
    const next = [...previous, sample]
      .filter((item) => now - Date.parse(item.timestamp) <= this.ttlMs)
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
      .slice(-this.maxSamples);
    this.traces.set(sample.sessionId, next);
    return next;
  }

  getState(sessionId: string): SessionRoadState | null {
    const state = this.roadStates.get(sessionId);
    if (!state || Date.now() - state.updatedAt > this.ttlMs) {
      this.roadStates.delete(sessionId);
      return null;
    }
    return state;
  }

  setState(sessionId: string, state: Omit<SessionRoadState, "updatedAt">): void {
    this.roadStates.set(sessionId, { ...state, updatedAt: Date.now() });
  }
}
