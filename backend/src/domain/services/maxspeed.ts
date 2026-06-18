export function parseMaxspeedToKmh(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") return Number.isFinite(input) && input > 0 ? Math.round(input) : null;

  const value = input.trim().toLowerCase();
  if (!value || ["none", "signals", "variable", "walk", "implicit"].includes(value)) return null;

  const conditional = value.match(/^(\d+(?:\.\d+)?)\s*(km\/h|kph|mph)?\s*@/);
  if (conditional) return convert(Number(conditional[1]), conditional[2]);

  const firstNumeric = value.match(/(\d+(?:\.\d+)?)\s*(km\/h|kph|mph)?/);
  if (!firstNumeric) return null;
  return convert(Number(firstNumeric[1]), firstNumeric[2]);
}

function convert(value: number, unit: string | undefined): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (unit === "mph") return Math.round(value * 1.609344);
  return Math.round(value);
}
