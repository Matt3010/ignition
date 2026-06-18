import type { FastifyReply, FastifyRequest } from "fastify";
import type { GetRoadContextUseCase } from "../../application/use-cases/get-road-context.use-case.js";
import { ApplicationError } from "../../domain/errors/application-error.js";
import { normalizeCourse } from "../../domain/services/geo.js";
import { roadContextRequestSchema } from "../schemas/road-context.schema.js";

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

    const scenarioHeader = request.headers["x-road-context-scenario"];
    const scenario = Array.isArray(scenarioHeader) ? scenarioHeader[0] : scenarioHeader;
    if (scenario && request.server.config.NODE_ENV === "production") {
      throw new ApplicationError("INVALID_REQUEST", "Scenario debug non consentito in produzione", 400);
    }

    request.log.info(
      {
        sessionHash: hashSession(payload.sessionId),
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

function hashSession(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 33) ^ value.charCodeAt(index);
  return `s_${(hash >>> 0).toString(16)}`;
}

function roundedGps(payload: { latitude: number; longitude: number }): { lat: number; lon: number } {
  return {
    lat: Number(payload.latitude.toFixed(3)),
    lon: Number(payload.longitude.toFixed(3)),
  };
}
