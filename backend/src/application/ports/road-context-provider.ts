import type { GpsSample, RoadMatch, SessionRoadState } from "../../domain/models/road-context.js";

export interface RoadContextProvider {
  match(input: {
    sample: GpsSample;
    trace: GpsSample[];
    previousState: SessionRoadState | null;
    scenario?: string | null;
  }): Promise<RoadMatch>;

  health(): Promise<"up" | "down">;
}
