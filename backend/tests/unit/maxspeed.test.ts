import { parseMaxspeedToKmh } from "../../src/domain/services/maxspeed.js";

describe("maxspeed parsing", () => {
  it("parses numeric kmh", () => {
    expect(parseMaxspeedToKmh("70")).toBe(70);
    expect(parseMaxspeedToKmh("50 km/h")).toBe(50);
  });

  it("converts mph to kmh", () => {
    expect(parseMaxspeedToKmh("30 mph")).toBe(48);
  });

  it("returns null for unknown limits", () => {
    expect(parseMaxspeedToKmh("signals")).toBeNull();
    expect(parseMaxspeedToKmh(null)).toBeNull();
  });

  it("parses simple conditional values", () => {
    expect(parseMaxspeedToKmh("70 @ (Mo-Fr 07:00-19:00)")).toBe(70);
  });
});
