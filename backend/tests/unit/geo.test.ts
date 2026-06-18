import {
  angularDifference,
  haversineMeters,
  isDirectionCompatible,
  normalizeCourse,
} from "../../src/domain/services/geo.js";

describe("geo utilities", () => {
  it("normalizes course", () => {
    expect(normalizeCourse(360)).toBe(0);
    expect(normalizeCourse(-10)).toBe(350);
    expect(normalizeCourse(null)).toBeNull();
  });

  it("calculates angular difference across zero", () => {
    expect(angularDifference(350, 10)).toBe(20);
  });

  it("filters incompatible direction", () => {
    expect(isDirectionCompatible(0, 20, 45)).toBe(true);
    expect(isDirectionCompatible(0, 180, 45)).toBe(false);
  });

  it("calculates distance in meters", () => {
    expect(haversineMeters(45, 11, 45.001, 11)).toBeGreaterThan(100);
  });
});
