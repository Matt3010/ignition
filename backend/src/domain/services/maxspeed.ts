export type SpeedLimitSource = "explicit" | "implicit" | "unknown";

export interface ParsedMaxspeed {
  value: number | null;
  source: SpeedLimitSource;
}

export function parseMaxspeedToKmh(input: string | number | null | undefined): number | null {
  return parseMaxspeed(input).value;
}

export function parseMaxspeed(input: string | number | null | undefined): ParsedMaxspeed {
  if (input === null || input === undefined) return { value: null, source: "unknown" };
  if (typeof input === "number") {
    return Number.isFinite(input) && input > 0
      ? { value: Math.round(input), source: "explicit" }
      : { value: null, source: "unknown" };
  }

  const value = input.trim().toLowerCase();
  if (!value || ["none", "signals", "variable", "walk", "implicit"].includes(value)) {
    return { value: null, source: "unknown" };
  }
  const implicit = implicitMaxspeedToKmh(value);
  if (implicit !== null) return { value: implicit, source: "implicit" };

  const conditional = value.match(/^(\d+(?:\.\d+)?)\s*(km\/h|kph|mph)?\s*@/);
  if (conditional) return withExplicitSource(convert(Number(conditional[1]), conditional[2]));

  const firstNumeric = value.match(/(\d+(?:\.\d+)?)\s*(km\/h|kph|mph)?/);
  if (!firstNumeric) return { value: null, source: "unknown" };
  return withExplicitSource(convert(Number(firstNumeric[1]), firstNumeric[2]));
}

function withExplicitSource(value: number | null): ParsedMaxspeed {
  return value === null ? { value: null, source: "unknown" } : { value, source: "explicit" };
}

function convert(value: number, unit: string | undefined): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (unit === "mph") return Math.round(value * 1.609344);
  return Math.round(value);
}

function implicitMaxspeedToKmh(value: string): number | null {
  switch (value) {
    case "it:urban":
      return 50;
    case "it:rural":
      return 90;
    case "it:trunk":
      return 110;
    case "it:motorway":
      return 130;
    default:
      return null;
  }
}
