import { parseMaxspeed, parseMaxspeedToKmh } from "../../src/domain/services/maxspeed.js";

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
    expect(parseMaxspeedToKmh("DE:urban")).toBeNull();
    expect(parseMaxspeedToKmh(null)).toBeNull();
  });

  it("parses simple conditional values", () => {
    expect(parseMaxspeedToKmh("70 @ (Mo-Fr 07:00-19:00)")).toBe(70);
  });

  it("parses Italian implicit speed limits", () => {
    expect(parseMaxspeedToKmh("IT:urban")).toBe(50);
    expect(parseMaxspeedToKmh("IT:rural")).toBe(90);
    expect(parseMaxspeedToKmh("IT:trunk")).toBe(110);
    expect(parseMaxspeedToKmh("IT:motorway")).toBe(130);
  });

  it("classifies speed limit source", () => {
    expect(parseMaxspeed("70")).toEqual({ value: 70, source: "explicit" });
    expect(parseMaxspeed("IT:urban")).toEqual({ value: 50, source: "implicit" });
    expect(parseMaxspeed("signals")).toEqual({ value: null, source: "unknown" });
  });
});
