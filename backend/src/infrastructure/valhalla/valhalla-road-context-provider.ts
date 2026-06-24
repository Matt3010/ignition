import { z } from "zod";
import type { RoadContextProvider } from "../../application/ports/road-context-provider.js";
import type { GpsSample, MatchedRoad, RoadMatch } from "../../domain/models/road-context.js";
import { calculateRoadConfidence } from "../../domain/services/confidence.js";
import { normalizeCourse } from "../../domain/services/geo.js";
import { parseMaxspeed } from "../../domain/services/maxspeed.js";
import { hashSessionId } from "../../domain/services/session-id.js";
import { ValhallaNoMatchError, type ValhallaTracePoint } from "./valhalla-client.js";

export interface ValhallaGateway {
  traceAttributes(points: ValhallaTracePoint[]): Promise<unknown>;
  health(): Promise<"up" | "down">;
}

const valhallaEdgeSchema = z
  .object({
    names: z.array(z.string()).optional(),
    way_id: z.union([z.string(), z.number()]).optional(),
    road_class: z.string().optional(),
    speed_limit: z.union([z.number(), z.string()]).optional(),
    forward: z.boolean().optional(),
    begin_heading: z.number().finite().optional(),
    end_heading: z.number().finite().optional(),
  })
  .passthrough()
  .superRefine((edge, context) => {
    const hasName = edge.names?.some((name) => name.trim().length > 0) ?? false;
    if (edge.way_id === undefined && !hasName && edge.road_class === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Valhalla edge has no road identity",
      });
    }
  });

const valhallaMatchedPointSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.enum(["matched", "interpolated"]),
    edge_index: z.number().int().nonnegative(),
    distance_from_trace_point: z.number().finite().optional(),
  }).passthrough(),
  z.object({
    type: z.literal("unmatched"),
    edge_index: z.number().int().nonnegative().optional(),
    distance_from_trace_point: z.number().finite().optional(),
  }).passthrough(),
]);

const valhallaTraceAttributesSchema = z
  .object({
    edges: z.array(valhallaEdgeSchema),
    matched_points: z.array(valhallaMatchedPointSchema),
  })
  .passthrough();

type ValhallaEdge = z.infer<typeof valhallaEdgeSchema>;
type ValhallaMatchedPoint = z.infer<typeof valhallaMatchedPointSchema>;

interface WarningLogger {
  warn(data: Record<string, unknown>, message: string): void;
}

export class ValhallaRoadContextProvider implements RoadContextProvider {
  constructor(
    private readonly client: ValhallaGateway,
    private readonly logger?: WarningLogger,
  ) {}

  async match(input: Parameters<RoadContextProvider["match"]>[0]): Promise<RoadMatch> {
    try {
      const points = input.trace.map(toValhallaPoint);
      if (points.length < 2) {
        return unmatched(input.sample, 0.1, "noMatch");
      }

      const data = valhallaTraceAttributesSchema.parse(await this.client.traceAttributes(points));
      const matched = data.matched_points.at(-1);
      if (!matched || matched.type === "unmatched") {
        return unmatched(input.sample, 0.15, "noMatch");
      }

      const edge = data.edges[matched.edge_index];
      if (!edge) {
        throw new Error(`Valhalla edge_index ${matched.edge_index} is outside edges bounds`);
      }

      const distance = Number(matched.distance_from_trace_point ?? input.sample.horizontalAccuracyMeters);
      const speedLimit = parseMaxspeed(edge.speed_limit);
      const base: Omit<MatchedRoad, "confidence"> = {
        matched: true,
        roadId: edge.way_id === undefined || edge.way_id === null ? null : `way-${edge.way_id}`,
        roadName: displayRoadName(edge),
        speedLimitKmh: speedLimit.value,
        speedLimitSource: speedLimit.source,
        roadType: edge.road_class ?? null,
        direction: edge.forward === false ? "backward" : edge.forward === true ? "forward" : "unknown",
        dataTimestamp: input.sample.timestamp,
        distanceFromTraceMeters: Number.isFinite(distance) ? distance : null,
        bearing: normalizeCourse(edge.end_heading ?? edge.begin_heading),
        valhallaQuality: qualityFromMatchedPoint(matched, distance, input.sample.horizontalAccuracyMeters),
      };
      const confidence = calculateRoadConfidence({
        sample: input.sample,
        match: base,
        previousState: input.previousState,
      });
      return { ...base, confidence };
    } catch (error) {
      if (error instanceof ValhallaNoMatchError) {
        this.logger?.warn(
          {
            error: error.message,
            valhallaStatusCode: error.statusCode,
            valhallaErrorCode: error.errorCode,
            sessionHash: hashSessionId(input.sample.sessionId),
          },
          "Valhalla could not match the trace",
        );
        return unmatched(input.sample, 0.15, "noMatch");
      }

      this.logger?.warn(
        {
          error: error instanceof Error ? error.message : String(error),
          sessionHash: hashSessionId(input.sample.sessionId),
        },
        "Valhalla road match failed",
      );
      return unmatched(input.sample, 0, "providerError");
    }
  }

  async health(): Promise<"up" | "down"> {
    return this.client.health();
  }
}

function toValhallaPoint(sample: GpsSample): ValhallaTracePoint {
  return {
    lat: sample.latitude,
    lon: sample.longitude,
    time: Math.floor(Date.parse(sample.timestamp) / 1000),
    heading: sample.course ?? undefined,
    accuracy: sample.horizontalAccuracyMeters,
  };
}

function displayRoadName(edge: ValhallaEdge): string | null {
  const explicitName = edge.names?.find((name) => name.trim().length > 0);
  if (explicitName) return explicitName;
  if (!edge.road_class && edge.way_id === undefined) return null;
  const typeLabel = roadTypeLabel(edge.road_class);
  return `${typeLabel} senza nome`;
}

function roadTypeLabel(roadType: string | undefined): string {
  switch (roadType) {
    case "motorway":
      return "Autostrada";
    case "trunk":
      return "Strada extraurbana principale";
    case "primary":
      return "Strada primaria";
    case "secondary":
      return "Strada secondaria";
    case "tertiary":
      return "Strada terziaria";
    case "residential":
      return "Strada residenziale";
    case "service":
      return "Strada di servizio";
    case "unclassified":
      return "Strada locale";
    case "motorway_link":
    case "trunk_link":
    case "primary_link":
    case "secondary_link":
    case "tertiary_link":
      return "Rampa";
    default:
      return "Strada";
  }
}

function qualityFromMatchedPoint(
  matched: ValhallaMatchedPoint,
  distanceMeters: number,
  accuracyMeters: number,
): number {
  const typeScore = matched.type === "matched" ? 1 : 0.72;
  const distanceScore = Math.max(0, 1 - distanceMeters / Math.max(accuracyMeters * 4, 20));
  return Math.max(0, Math.min(1, Number((typeScore * 0.55 + distanceScore * 0.45).toFixed(2))));
}

function unmatched(sample: GpsSample, quality: number, unmatchedReason: "noMatch" | "providerError"): RoadMatch {
  return {
    matched: false,
    unmatchedReason,
    roadId: null,
    roadName: null,
    speedLimitKmh: null,
    speedLimitSource: "unknown",
    roadType: null,
    confidence: quality,
    direction: "unknown",
    dataTimestamp: sample.timestamp,
    distanceFromTraceMeters: null,
    bearing: null,
    valhallaQuality: quality,
  };
}
