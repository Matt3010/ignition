import type { AppConfig } from "../../config/env.js";
import type { RoadContextResponse, GpsSample } from "../../domain/models/road-context.js";
import { filterRelevantAlerts } from "../../domain/services/alert-filter.js";
import { roundMeters } from "../../domain/services/geo.js";
import type { AlertRepository } from "../ports/alert-repository.js";
import type { RoadContextProvider } from "../ports/road-context-provider.js";
import type { SessionTraceStore } from "../../domain/services/session-trace.js";

export class GetRoadContextUseCase {
  constructor(
    private readonly provider: RoadContextProvider,
    private readonly alertRepository: AlertRepository,
    private readonly traceStore: SessionTraceStore,
    private readonly config: AppConfig,
  ) {}

  async execute(sample: GpsSample, scenario?: string | null): Promise<RoadContextResponse> {
    const trace = this.traceStore.add(sample);
    const previousPosition = trace.length >= 2
      ? { latitude: trace[trace.length - 2].latitude, longitude: trace[trace.length - 2].longitude }
      : null;
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

    const nearby = await this.alertRepository.findNearby({
      latitude: sample.latitude,
      longitude: sample.longitude,
      radiusMeters: this.config.ALERT_SEARCH_RADIUS_METERS,
    });

    const alerts = filterRelevantAlerts({
      alerts: nearby,
      userCourse: sample.course,
      matchedRoadBearing: match.bearing,
      userLatitude: sample.latitude,
      userLongitude: sample.longitude,
      userSpeedKmh: sample.speedKmh,
      horizontalAccuracyMeters: sample.horizontalAccuracyMeters,
      previousPosition,
      behindMinAngleDegrees: this.config.ALERT_BEHIND_MIN_ANGLE_DEGREES,
      behindImmediateAngleDegrees: this.config.ALERT_BEHIND_IMMEDIATE_ANGLE_DEGREES,
      behindMinSpeedKmh: this.config.ALERT_BEHIND_MIN_SPEED_KMH,
      behindMaxGpsAccuracyMeters: this.config.ALERT_BEHIND_MAX_GPS_ACCURACY_METERS,
      behindMinDistanceIncreaseMeters: this.config.ALERT_BEHIND_MIN_DISTANCE_INCREASE_METERS,
    }).map((alert) => ({
      id: alert.id,
      type: alert.type,
      subtype: alert.subtype ?? null,
      capabilities: alert.capabilities ?? [],
      primaryCapability: alert.primaryCapability ?? null,
      distanceMeters: roundMeters(alert.distanceMeters),
      speedLimitKmh: alert.speedLimitKmh,
      speedLimitSource: alert.speedLimitSource,
      latitude: alert.latitude,
      longitude: alert.longitude,
      direction: alert.direction ?? "unknown",
      confidence: alert.confidence,
      operationalStatus: alert.operationalStatus ?? "unknown",
      statusReason: alert.statusReason ?? alert.fixme ?? null,
      directionBearings: alert.directionBearings ?? [],
      osmPresenceStatus: alert.osmPresenceStatus ?? "present",
      active: alert.active,
      positionApproximate: alert.positionApproximate ?? false,
      osmType: alert.osmType ?? null,
      osmId: alert.osmId ?? null,
      osmRelationId: alert.osmRelationId ?? null,
      osmTimestamp: alert.osmTimestamp?.toISOString() ?? null,
    }));

    return {
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
  }
}
