import { ApplicationError } from "../errors/application-error.js";
import type { GpsSample, SessionRoadState } from "../models/road-context.js";

export class SessionTraceStore {
  private readonly traces = new Map<string, GpsSample[]>();
  private readonly roadStates = new Map<string, SessionRoadState>();
  private readonly lastTouched = new Map<string, number>();
  private readonly consecutiveMatchMisses = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxSamples = 8,
    private readonly maxSessions = 5_000,
    private readonly maxFutureSkewMs = 5_000,
    private readonly clearStateAfterMisses = 3,
    private readonly confidenceDecayFactor = 0.5,
  ) {}

  add(sample: GpsSample): GpsSample[] {
    const now = Date.now();
    this.cleanup(now);
    this.touch(sample.sessionId, now);
    const previous = this.traces.get(sample.sessionId) ?? [];
    const sampleTime = Date.parse(sample.timestamp);
    const latestTime = previous.length > 0 ? Date.parse(previous[previous.length - 1].timestamp) : null;
    if (latestTime !== null && sampleTime <= latestTime) {
      throw new ApplicationError(
        "INVALID_REQUEST",
        "Campione GPS non successivo all'ultimo campione elaborato",
        409,
        [{ path: "timestamp", previousTimestamp: previous[previous.length - 1].timestamp }],
      );
    }
    const next = [...previous, sample]
      .filter((item) => {
        const age = now - Date.parse(item.timestamp);
        return age >= -this.maxFutureSkewMs && age <= this.ttlMs;
      })
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
      .slice(-this.maxSamples);
    this.traces.set(sample.sessionId, next);
    return next;
  }

  rollbackLast(sessionId: string, timestamp: string): void {
    const trace = this.traces.get(sessionId);
    if (!trace || trace.length === 0) return;
    const last = trace[trace.length - 1];
    if (last.timestamp !== timestamp) return;

    const next = trace.slice(0, -1);
    if (next.length === 0) {
      this.traces.delete(sessionId);
      if (!this.roadStates.has(sessionId)) {
        this.lastTouched.delete(sessionId);
      }
      return;
    }

    this.traces.set(sessionId, next);
    this.touch(sessionId, Date.now());
  }

  getState(sessionId: string): SessionRoadState | null {
    const now = Date.now();
    this.cleanup(now);
    const state = this.roadStates.get(sessionId);
    if (!state) return null;
    if (now - state.updatedAt > this.ttlMs) {
      this.roadStates.delete(sessionId);
      this.consecutiveMatchMisses.delete(sessionId);
      return null;
    }
    this.touch(sessionId, now);
    return state;
  }

  setState(sessionId: string, state: Omit<SessionRoadState, "updatedAt">): void {
    const now = Date.now();
    this.cleanup(now);
    this.touch(sessionId, now);
    this.consecutiveMatchMisses.delete(sessionId);
    this.roadStates.set(sessionId, { ...state, updatedAt: now });
  }

  registerMatchMiss(sessionId: string): void {
    const now = Date.now();
    this.cleanup(now);
    const state = this.roadStates.get(sessionId);
    if (!state) {
      this.consecutiveMatchMisses.delete(sessionId);
      return;
    }

    const misses = (this.consecutiveMatchMisses.get(sessionId) ?? 0) + 1;
    if (misses >= this.clearStateAfterMisses) {
      this.roadStates.delete(sessionId);
      this.consecutiveMatchMisses.delete(sessionId);
      if (!this.traces.has(sessionId)) {
        this.lastTouched.delete(sessionId);
      }
      return;
    }

    this.consecutiveMatchMisses.set(sessionId, misses);
    this.touch(sessionId, now);
    if (misses > 1) {
      this.roadStates.set(sessionId, {
        ...state,
        confidence: Math.max(0, Math.min(1, state.confidence * this.confidenceDecayFactor)),
        updatedAt: now,
      });
    }
  }

  private touch(sessionId: string, now: number): void {
    this.lastTouched.delete(sessionId);
    this.lastTouched.set(sessionId, now);
    while (this.lastTouched.size > this.maxSessions) {
      const oldest = this.lastTouched.keys().next().value as string | undefined;
      if (!oldest) break;
      this.deleteSession(oldest);
    }
  }

  private cleanup(now: number): void {
    for (const [sessionId, touchedAt] of this.lastTouched.entries()) {
      if (now - touchedAt <= this.ttlMs) continue;
      this.deleteSession(sessionId);
    }
  }

  private deleteSession(sessionId: string): void {
    this.traces.delete(sessionId);
    this.roadStates.delete(sessionId);
    this.consecutiveMatchMisses.delete(sessionId);
    this.lastTouched.delete(sessionId);
  }
}
