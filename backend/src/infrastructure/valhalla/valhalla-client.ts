import type { AppConfig } from "../../config/env.js";

export interface ValhallaTracePoint {
  lat: number;
  lon: number;
  time: number;
  heading?: number;
  accuracy?: number;
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
              "edge.speed",
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
      if (!response.ok) throw new Error(`Valhalla responded ${response.status}`);
      return response.json();
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
