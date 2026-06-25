import type { AlertCandidate } from "../../domain/models/alert.js";
import type {
  AlertRelevance,
  PublicMatchStatus,
  RoadContextResponse,
  RoadMatch,
} from "../../domain/models/road-context.js";
import { roundMeters } from "../../domain/services/geo.js";

export function toAlertResponse(
  alert: AlertCandidate,
  relevance: AlertRelevance,
): RoadContextResponse["alerts"][number] {
  return {
    id: alert.id,
    relevance,
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
  };
}

export function toPublicMatchStatus(match: RoadMatch): PublicMatchStatus {
  if (match.matched) return "matched";
  return match.unmatchedReason === "providerError" ? "providerUnavailable" : "noMatch";
}
