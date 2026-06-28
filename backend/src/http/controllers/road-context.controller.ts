import type { FastifyReply, FastifyRequest } from "fastify";
import type { GetRoadContextUseCase } from "../../application/use-cases/get-road-context.use-case.js";
import { logRoadContextRequest, parseRoadContextSample } from "../requests/road-context-request.js";

export class RoadContextController {
  constructor(private readonly useCase: GetRoadContextUseCase) {}

  handle = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const sample = parseRoadContextSample(request);
    logRoadContextRequest(request, sample);
    const response = await this.useCase.execute(sample, (timing) => {
      request.log.info({ timing }, "road context timing");
    });
    reply.send(response);
  };
}
