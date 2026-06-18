import type { GpsSample, RoadMatch, SessionRoadState } from "../models/road-context.js";
import { angularDifference } from "./geo.js";

export interface ConfidenceInput {
  sample: GpsSample;
  match: Omit<RoadMatch, "confidence">;
  previousState: SessionRoadState | null;
  candidateAlternatives?: Array<{ roadId: string | null; distanceMeters: number; bearing: number | null }>;
}

export function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

export function calculateRoadConfidence(input: ConfidenceInput): number {
  if (!input.match.matched) return clampConfidence(Math.min(0.3, input.match.valhallaQuality));

  const accuracy = Math.max(1, input.sample.horizontalAccuracyMeters);
  const distance = input.match.distanceFromTraceMeters ?? accuracy;
  const distanceScore = Math.max(0, 1 - distance / Math.max(accuracy * 3, 15));

  const courseDiff = angularDifference(input.sample.course, input.match.bearing);
  const courseScore = courseDiff === null ? 0.65 : Math.max(0, 1 - courseDiff / 90);

  const continuityScore =
    input.previousState?.roadId && input.previousState.roadId === input.match.roadId
      ? 1
      : input.previousState?.roadType && input.previousState.roadType === input.match.roadType
        ? 0.72
        : 0.52;

  const parallelPenalty = calculateParallelPenalty(input);
  const raw =
    0.28 * distanceScore +
    0.22 * courseScore +
    0.2 * continuityScore +
    0.25 * input.match.valhallaQuality +
    0.05 * (input.sample.speedKmh > 5 ? 1 : 0.75) -
    parallelPenalty;

  return clampConfidence(raw);
}

function calculateParallelPenalty(input: ConfidenceInput): number {
  const alternatives = input.candidateAlternatives ?? [];
  if (!alternatives.length || !input.match.matched) return 0;
  const closeCompetitor = alternatives.find(
    (candidate) =>
      candidate.roadId !== input.match.roadId &&
      Math.abs(candidate.distanceMeters - (input.match.distanceFromTraceMeters ?? 0)) < 8,
  );
  if (!closeCompetitor) return 0;
  const courseDiff = angularDifference(input.sample.course, input.match.bearing);
  return courseDiff !== null && courseDiff < 25 ? 0.05 : 0.16;
}
