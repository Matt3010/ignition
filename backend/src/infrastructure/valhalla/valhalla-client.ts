import type { AppConfig } from "../../config/env.js";

export interface ValhallaTracePoint {
  lat: number;
  lon: number;
  time: number;
  heading?: number;
  accuracy?: number;
}

interface ValhallaErrorPayload {
  error_code?: unknown;
  error?: unknown;
  status_code?: unknown;
  status?: unknown;
}

const VALHALLA_NO_MATCH_ERROR_CODES = new Set([170, 171, 441, 442, 443, 444]);

export class ValhallaNoMatchError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly errorCode: number,
  ) {
    super(message);
    this.name = "ValhallaNoMatchError";
  }
}

export class ValhallaHttpError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly errorCode: number | null,
  ) {
    super(message);
    this.name = "ValhallaHttpError";
  }
}

export class ValhallaClient {
  constructor(private readonly config: AppConfig) {}

  async traceAttributes(points: ValhallaTracePoint[]): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.VALHALLA_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.config.VALHALLA_BASE_URL}/trace_attributes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          shape: points,
          costing: "auto",
          shape_match: "map_snap",
          filters: {
            attributes: [
              "edge.names",
              "edge.way_id",
              "edge.road_class",
              "edge.speed_limit",
              "edge.forward",
              "edge.begin_heading",
              "edge.end_heading",
              "matched.point",
              "matched.edge_index",
              "matched.distance_along_edge",
              "matched.distance_from_trace_point",
              "matched.type",
            ],
            action: "include",
          },
        }),
        signal: controller.signal,
      });

      const body = await response.text();
      if (!response.ok) {
        throw toValhallaResponseError(response.status, body);
      }

      try {
        return JSON.parse(body) as unknown;
      } catch (error) {
        throw new ValhallaHttpError(
          `Valhalla returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          response.status,
          null,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<"up" | "down"> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    try {
      const response = await fetch(`${this.config.VALHALLA_BASE_URL}/status`, {
        signal: controller.signal,
      });
      return response.ok ? "up" : "down";
    } catch {
      return "down";
    } finally {
      clearTimeout(timer);
    }
  }
}

function toValhallaResponseError(statusCode: number, body: string): Error {
  const payload = parseValhallaErrorPayload(body);
  const errorCode = parseValhallaErrorCode(payload?.error_code);
  const detail = typeof payload?.error === "string" ? payload.error : body.trim();
  const message = detail
    ? `Valhalla responded ${statusCode}${errorCode === null ? "" : ` (${errorCode})`}: ${detail}`
    : `Valhalla responded ${statusCode}${errorCode === null ? "" : ` (${errorCode})`}`;

  if (errorCode !== null && VALHALLA_NO_MATCH_ERROR_CODES.has(errorCode)) {
    return new ValhallaNoMatchError(message, statusCode, errorCode);
  }

  return new ValhallaHttpError(message, statusCode, errorCode);
}

function parseValhallaErrorCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    if (/^\d+$/.test(normalized)) {
      const parsed = Number(normalized);
      return Number.isSafeInteger(parsed) ? parsed : null;
    }
  }

  return null;
}

function parseValhallaErrorPayload(body: string): ValhallaErrorPayload | null {
  try {
    const value = JSON.parse(body) as unknown;
    return value !== null && typeof value === "object" ? (value as ValhallaErrorPayload) : null;
  } catch {
    return null;
  }
}
