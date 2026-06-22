import type { FastifyReply, FastifyRequest } from "fastify";
import type { GetRoadContextUseCase } from "../../application/use-cases/get-road-context.use-case.js";
import { ApplicationError } from "../../domain/errors/application-error.js";
import { normalizeCourse } from "../../domain/services/geo.js";
import { roadContextRequestSchema } from "../schemas/road-context.schema.js";
import { hashSessionId } from "../../domain/services/session-id.js";

export class RoadContextController {
  constructor(private readonly useCase: GetRoadContextUseCase) {}

  handle = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const payload = roadContextRequestSchema.parse(request.body);
    if (payload.horizontalAccuracyMeters > request.server.config.MAX_GPS_ACCURACY_METERS) {
      throw new ApplicationError("INVALID_REQUEST", "Accuratezza GPS troppo bassa", 400, [
        {
          path: "horizontalAccuracyMeters",
          max: request.server.config.MAX_GPS_ACCURACY_METERS,
        },
      ]);
    }

    const sampleTimestamp = Date.parse(payload.timestamp);
    const sampleAgeMs = Date.now() - sampleTimestamp;
    const maxAgeMs = request.server.config.MAX_SAMPLE_AGE_SECONDS * 1000;
    const maxFutureMs = request.server.config.MAX_SAMPLE_FUTURE_SECONDS * 1000;
    if (sampleAgeMs > maxAgeMs || sampleAgeMs < -maxFutureMs) {
      throw new ApplicationError("INVALID_REQUEST", "Timestamp GPS fuori dalla finestra consentita", 400, [
        {
          path: "timestamp",
          maxAgeSeconds: request.server.config.MAX_SAMPLE_AGE_SECONDS,
          maxFutureSeconds: request.server.config.MAX_SAMPLE_FUTURE_SECONDS,
        },
      ]);
    }

    const scenarioHeader = request.headers["x-road-context-scenario"];
    const scenario = Array.isArray(scenarioHeader) ? scenarioHeader[0] : scenarioHeader;
    if (scenario && request.server.config.NODE_ENV === "production") {
      throw new ApplicationError("INVALID_REQUEST", "Scenario debug non consentito in produzione", 400);
    }

    request.log.info(
      {
        sessionHash: hashSessionId(payload.sessionId),
        gps: request.server.config.NODE_ENV === "production" ? "redacted" : roundedGps(payload),
      },
      "road context request",
    );

    const response = await this.useCase.execute(
      {
        ...payload,
        course: normalizeCourse(payload.course),
      },
      scenario,
    );
    reply.send(response);
  };
}


function roundedGps(payload: { latitude: number; longitude: number }): { lat: number; lon: number } {
  return {
    lat: Number(payload.latitude.toFixed(3)),
    lon: Number(payload.longitude.toFixed(3)),
  };
}
