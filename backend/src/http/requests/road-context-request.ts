import type { FastifyRequest } from "fastify";
import type { AppConfig } from "../../config/env.js";
import { ApplicationError } from "../../domain/errors/application-error.js";
import type { GpsSample } from "../../domain/models/road-context.js";
import { normalizeCourse } from "../../domain/services/geo.js";
import { hashSessionId } from "../../domain/services/session-id.js";
import { roadContextRequestSchema } from "../schemas/road-context.schema.js";

export function parseRoadContextSample(request: FastifyRequest): GpsSample {
  const payload = roadContextRequestSchema.parse(request.body);
  validateGpsAccuracy(payload, request.server.config);
  validateSampleTimestamp(payload, request.server.config);
  return {
    ...payload,
    course: normalizeCourse(payload.course),
  };
}

export function logRoadContextRequest(request: FastifyRequest, sample: GpsSample): void {
  request.log.info(
    {
      sessionHash: hashSessionId(sample.sessionId),
      gps: request.server.config.NODE_ENV === "production" ? "redacted" : roundedGps(sample),
    },
    "road context request",
  );
}

function validateGpsAccuracy(sample: GpsSample, config: AppConfig): void {
  if (sample.horizontalAccuracyMeters <= config.MAX_GPS_ACCURACY_METERS) return;
  throw new ApplicationError("INVALID_REQUEST", "Accuratezza GPS troppo bassa", 400, [
    {
      path: "horizontalAccuracyMeters",
      max: config.MAX_GPS_ACCURACY_METERS,
    },
  ]);
}

function validateSampleTimestamp(sample: GpsSample, config: AppConfig): void {
  const sampleTimestamp = Date.parse(sample.timestamp);
  const sampleAgeMs = Date.now() - sampleTimestamp;
  const maxAgeMs = config.MAX_SAMPLE_AGE_SECONDS * 1000;
  const maxFutureMs = config.MAX_SAMPLE_FUTURE_SECONDS * 1000;
  if (sampleAgeMs <= maxAgeMs && sampleAgeMs >= -maxFutureMs) return;

  throw new ApplicationError("INVALID_REQUEST", "Timestamp GPS fuori dalla finestra consentita", 400, [
    {
      path: "timestamp",
      maxAgeSeconds: config.MAX_SAMPLE_AGE_SECONDS,
      maxFutureSeconds: config.MAX_SAMPLE_FUTURE_SECONDS,
    },
  ]);
}

function roundedGps(sample: { latitude: number; longitude: number }): { lat: number; lon: number } {
  return {
    lat: Number(sample.latitude.toFixed(3)),
    lon: Number(sample.longitude.toFixed(3)),
  };
}
