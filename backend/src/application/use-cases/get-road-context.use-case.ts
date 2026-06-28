import type { AppConfig } from "../../config/env.js";
import type { RoadContextResponse, GpsSample } from "../../domain/models/road-context.js";
import type { AlertRepository } from "../ports/alert-repository.js";
import type { RoadContextProvider } from "../ports/road-context-provider.js";
import { SessionOperationQueue } from "../services/session-operation-queue.js";
import type { SessionTraceStore } from "../../domain/services/session-trace.js";
import { previousTracePosition } from "../../domain/services/session-trace.js";
import { buildRoadContextAlerts } from "./road-context-alert-selection.js";
import { toPublicMatchStatus } from "./road-context-mappers.js";

export interface RoadContextTiming {
  totalUseCaseMs: number;
  queueWaitMs: number;
  valhallaMatchMs: number;
  findNearbyMs: number;
  alertsStatusMs: number;
  alertSelectionMs: number;
}

export type RoadContextTimingSink = (timing: RoadContextTiming) => void;

export class GetRoadContextUseCase {
  constructor(
    private readonly provider: RoadContextProvider,
    private readonly alertRepository: AlertRepository,
    private readonly traceStore: SessionTraceStore,
    private readonly config: AppConfig,
    private readonly sessionQueue = new SessionOperationQueue(),
  ) {}

  async execute(sample: GpsSample, onTiming?: RoadContextTimingSink): Promise<RoadContextResponse> {
    const totalStartedAt = performance.now();
    const queueStartedAt = performance.now();
    let queueWaitMs = 0;
    return this.sessionQueue.run(sample.sessionId, async () => {
      queueWaitMs = elapsedMs(queueStartedAt);
      return this.executeSerial(sample, totalStartedAt, queueWaitMs, onTiming);
    });
  }

  private async executeSerial(
    sample: GpsSample,
    totalStartedAt: number,
    queueWaitMs: number,
    onTiming?: RoadContextTimingSink,
  ): Promise<RoadContextResponse> {
    const trace = this.traceStore.add(sample);

    try {
      const previousPosition = previousTracePosition(trace);
      const previousState = this.traceStore.getState(sample.sessionId);
      const matchStartedAt = performance.now();
      const match = await this.provider.match({ sample, trace, previousState });
      const valhallaMatchMs = elapsedMs(matchStartedAt);

      let findNearbyMs = 0;
      let alertsStatusMs = 0;
      const [nearby, alertsStatus] = await Promise.all([
        timed(
          async () =>
            this.alertRepository.findNearby({
              latitude: sample.latitude,
              longitude: sample.longitude,
              radiusMeters: Math.max(
                this.config.ALERT_SEARCH_RADIUS_METERS,
                this.config.GENERIC_ALERT_SEARCH_RADIUS_METERS,
              ),
            }),
          (elapsed) => {
            findNearbyMs = elapsed;
          },
        ),
        timed(
          async () => this.alertRepository.getDatasetStatus().catch(() => "unavailable" as const),
          (elapsed) => {
            alertsStatusMs = elapsed;
          },
        ),
      ]);

      const alertSelectionStartedAt = performance.now();
      const selectedAlerts = buildRoadContextAlerts({
        nearby,
        match,
        sample,
        previousPosition,
        config: this.config,
      });
      const alertSelectionMs = elapsedMs(alertSelectionStartedAt);

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

      const response = {
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
      onTiming?.({
        totalUseCaseMs: elapsedMs(totalStartedAt),
        queueWaitMs,
        valhallaMatchMs,
        findNearbyMs,
        alertsStatusMs,
        alertSelectionMs,
      });
      return response;
    } catch (error) {
      this.traceStore.rollbackLast(sample.sessionId, sample.timestamp);
      throw error;
    }
  }

}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

async function timed<T>(operation: () => Promise<T>, record: (elapsed: number) => void): Promise<T> {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    record(elapsedMs(startedAt));
  }
}
