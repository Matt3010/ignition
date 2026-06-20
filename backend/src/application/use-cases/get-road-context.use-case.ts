import type { AppConfig } from "../../config/env.js";
import type { RoadContextResponse, GpsSample } from "../../domain/models/road-context.js";
import { filterRelevantAlerts } from "../../domain/services/alert-filter.js";
import { TtlCache } from "../../domain/services/cache.js";
import { roundMeters } from "../../domain/services/geo.js";
import type { AlertRepository } from "../ports/alert-repository.js";
import type { RoadContextProvider } from "../ports/road-context-provider.js";
import type { SessionTraceStore } from "../../domain/services/session-trace.js";

export class GetRoadContextUseCase {
  private readonly roadContextCache: TtlCache<string, RoadContextResponse>;
  private readonly alertCache: TtlCache<string, Awaited<ReturnType<AlertRepository["findNearby"]>>>;

  constructor(
    private readonly provider: RoadContextProvider,
    private readonly alertRepository: AlertRepository,
    private readonly traceStore: SessionTraceStore,
    private readonly config: AppConfig,
  ) {
    const ttlMs = config.CACHE_TTL_SECONDS * 1000;
    this.roadContextCache = new TtlCache(ttlMs);
    this.alertCache = new TtlCache(ttlMs);
  }

  async execute(sample: GpsSample, scenario?: string | null): Promise<RoadContextResponse> {
    const cacheKey = `${sample.sessionId}:${sample.latitude.toFixed(5)}:${sample.longitude.toFixed(5)}:${sample.timestamp}:${scenario ?? ""}`;
    const cached = this.roadContextCache.get(cacheKey);
    if (cached) return cached;

    const trace = this.traceStore.add(sample);
    const previousState = this.traceStore.getState(sample.sessionId);
    const match = await this.provider.match({ sample, trace, previousState, scenario });

    if (match.matched) {
      this.traceStore.setState(sample.sessionId, {
        roadId: match.roadId,
        roadType: match.roadType,
        direction: match.direction,
        confidence: match.confidence,
      });
    }

    const alertCacheKey = `${sample.latitude.toFixed(3)}:${sample.longitude.toFixed(3)}:${this.config.ALERT_SEARCH_RADIUS_METERS}`;
    let nearby = this.alertCache.get(alertCacheKey);
    if (!nearby) {
      nearby = await this.alertRepository.findNearby({
        latitude: sample.latitude,
        longitude: sample.longitude,
        radiusMeters: this.config.ALERT_SEARCH_RADIUS_METERS,
        now: new Date(sample.timestamp),
      });
      this.alertCache.set(alertCacheKey, nearby);
    }

    const alerts = filterRelevantAlerts({
      alerts: nearby,
      roadId: match.roadId,
      userCourse: sample.course,
      direction: match.direction,
      directionToleranceDegrees: this.config.ALERT_DIRECTION_TOLERANCE_DEGREES,
      unassignedMaxDistanceMeters: this.config.ALERT_UNASSIGNED_RADIUS_METERS,
      unmatchedMaxDistanceMeters: this.config.ALERT_UNMATCHED_RADIUS_METERS,
      now: new Date(sample.timestamp),
      limit: 10,
    }).map((alert) => ({
      id: alert.id,
      type: alert.type,
      distanceMeters: roundMeters(alert.distanceMeters),
      speedLimitKmh: alert.speedLimitKmh,
      speedLimitSource: alert.speedLimitSource,
      latitude: alert.latitude,
      longitude: alert.longitude,
      direction: alert.direction ?? "unknown",
      confidence: alert.confidence,
    }));

    const response: RoadContextResponse = {
      matched: match.matched,
      roadId: match.roadId,
      roadName: match.roadName,
      speedLimitKmh: match.speedLimitKmh,
      speedLimitSource: match.speedLimitSource,
      roadType: match.roadType,
      confidence: match.confidence,
      direction: match.direction,
      dataTimestamp: match.dataTimestamp,
      alerts,
    };
    this.roadContextCache.set(cacheKey, response);
    return response;
  }
}
