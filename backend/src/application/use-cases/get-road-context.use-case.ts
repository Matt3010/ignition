import type { AppConfig } from "../../config/env.js";
import type { RoadContextResponse, GpsSample } from "../../domain/models/road-context.js";
import type { AlertRepository } from "../ports/alert-repository.js";
import type { RoadContextProvider } from "../ports/road-context-provider.js";
import type { SessionTraceStore } from "../../domain/services/session-trace.js";
import { buildRoadContextAlerts } from "./road-context-alert-selection.js";
import { toPublicMatchStatus } from "./road-context-mappers.js";

export class GetRoadContextUseCase {
  private readonly sessionQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly provider: RoadContextProvider,
    private readonly alertRepository: AlertRepository,
    private readonly traceStore: SessionTraceStore,
    private readonly config: AppConfig,
  ) {}

  execute(sample: GpsSample): Promise<RoadContextResponse> {
    return this.enqueue(sample.sessionId, () => this.executeSerial(sample));
  }

  private async executeSerial(sample: GpsSample): Promise<RoadContextResponse> {
    const trace = this.traceStore.add(sample);

    try {
      const previousPosition = previousTracePosition(trace);
      const previousState = this.traceStore.getState(sample.sessionId);
      const match = await this.provider.match({ sample, trace, previousState });

      const [nearby, alertsStatus] = await Promise.all([
        this.alertRepository.findNearby({
          latitude: sample.latitude,
          longitude: sample.longitude,
          radiusMeters: Math.max(
            this.config.ALERT_SEARCH_RADIUS_METERS,
            this.config.GENERIC_ALERT_SEARCH_RADIUS_METERS,
          ),
        }),
        this.alertRepository.getDatasetStatus().catch(() => "unavailable" as const),
      ]);

      const selectedAlerts = buildRoadContextAlerts({
        nearby,
        match,
        sample,
        previousPosition,
        config: this.config,
      });

      if (match.matched) {
        this.traceStore.setState(sample.sessionId, {
          roadId: match.roadId,
          roadType: match.roadType,
          direction: match.direction,
          confidence: match.confidence,
        });
      } else if (match.unmatchedReason === "noMatch") {
        this.traceStore.registerMatchMiss(sample.sessionId);
      }

      return {
        matched: match.matched,
        matchStatus: toPublicMatchStatus(match),
        alertsStatus,
        roadId: match.roadId,
        roadName: match.roadName,
        speedLimitKmh: match.speedLimitKmh,
        speedLimitSource: match.speedLimitSource,
        roadType: match.roadType,
        confidence: match.confidence,
        direction: match.direction,
        dataTimestamp: match.dataTimestamp,
        alerts: selectedAlerts.alerts,
        genericAlerts: selectedAlerts.genericAlerts,
      };
    } catch (error) {
      this.traceStore.rollbackLast(sample.sessionId, sample.timestamp);
      throw error;
    }
  }

  private async enqueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    this.sessionQueues.set(sessionId, queued);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.sessionQueues.get(sessionId) === queued) {
        this.sessionQueues.delete(sessionId);
      }
    }
  }
}

function previousTracePosition(trace: GpsSample[]): { latitude: number; longitude: number } | null {
  if (trace.length < 2) return null;
  const previous = trace[trace.length - 2];
  return {
    latitude: previous.latitude,
    longitude: previous.longitude,
  };
}
