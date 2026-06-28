import { ApplicationError } from "../errors/application-error.js";
import type { GpsSample, SessionRoadState } from "../models/road-context.js";

export interface GeoPosition {
  latitude: number;
  longitude: number;
}

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
    const previous = this.traces.get(sample.sessionId) ?? [];
    assertSampleIsNewer(previous, sample);
    this.touch(sample.sessionId, now);
    const next = pruneTraceSamples({
      samples: [...previous, sample],
      now,
      ttlMs: this.ttlMs,
      maxFutureSkewMs: this.maxFutureSkewMs,
      maxSamples: this.maxSamples,
    });
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
    const next = nextRoadStateAfterMatchMiss({
      state,
      misses,
      clearStateAfterMisses: this.clearStateAfterMisses,
      confidenceDecayFactor: this.confidenceDecayFactor,
      updatedAt: now,
    });
    if (!next) {
      this.roadStates.delete(sessionId);
      this.consecutiveMatchMisses.delete(sessionId);
      if (!this.traces.has(sessionId)) {
        this.lastTouched.delete(sessionId);
      }
      return;
    }

    this.consecutiveMatchMisses.set(sessionId, misses);
    this.touch(sessionId, now);
    this.roadStates.set(sessionId, next);
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

export function previousTracePosition(trace: GpsSample[]): GeoPosition | null {
  if (trace.length < 2) return null;
  const previous = trace[trace.length - 2];
  return {
    latitude: previous.latitude,
    longitude: previous.longitude,
  };
}

export function pruneTraceSamples(input: {
  samples: GpsSample[];
  now: number;
  ttlMs: number;
  maxFutureSkewMs: number;
  maxSamples: number;
}): GpsSample[] {
  return input.samples
    .filter((sample) => {
      const age = input.now - Date.parse(sample.timestamp);
      return age >= -input.maxFutureSkewMs && age <= input.ttlMs;
    })
    .slice(-input.maxSamples);
}

export function assertSampleIsNewer(previous: GpsSample[], sample: GpsSample): void {
  if (previous.length === 0) return;
  const latest = previous[previous.length - 1];
  if (Date.parse(sample.timestamp) > Date.parse(latest.timestamp)) return;

  throw new ApplicationError(
    "INVALID_REQUEST",
    "Campione GPS non successivo all'ultimo campione elaborato",
    409,
    [{ path: "timestamp", previousTimestamp: latest.timestamp }],
  );
}

export function nextRoadStateAfterMatchMiss(input: {
  state: SessionRoadState;
  misses: number;
  clearStateAfterMisses: number;
  confidenceDecayFactor: number;
  updatedAt: number;
}): SessionRoadState | null {
  if (input.misses >= input.clearStateAfterMisses) return null;
  if (input.misses <= 1) return input.state;
  return {
    ...input.state,
    confidence: Math.max(0, Math.min(1, input.state.confidence * input.confidenceDecayFactor)),
    updatedAt: input.updatedAt,
  };
}
