const earthRadiusMeters = 6371008.8;

export function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

export function toDegrees(value: number): number {
  return (value * 180) / Math.PI;
}

export function normalizeCourse(course: number | null | undefined): number | null {
  if (course === null || course === undefined || Number.isNaN(course)) return null;
  if (course === 360) return 0;
  return ((course % 360) + 360) % 360;
}

export function angularDifference(a: number | null | undefined, b: number | null | undefined): number | null {
  const left = normalizeCourse(a);
  const right = normalizeCourse(b);
  if (left === null || right === null) return null;
  const diff = Math.abs(left - right) % 360;
  return diff > 180 ? 360 - diff : diff;
}

export function haversineMeters(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number {
  const lat1 = toRadians(latitudeA);
  const lat2 = toRadians(latitudeB);
  const dLat = toRadians(latitudeB - latitudeA);
  const dLon = toRadians(longitudeB - longitudeA);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function initialBearing(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number {
  const lat1 = toRadians(latitudeA);
  const lat2 = toRadians(latitudeB);
  const dLon = toRadians(longitudeB - longitudeA);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return normalizeCourse(toDegrees(Math.atan2(y, x))) ?? 0;
}

export function isDirectionCompatible(
  userCourse: number | null,
  targetBearing: number | null,
  toleranceDegrees: number,
): boolean {
  const diff = angularDifference(userCourse, targetBearing);
  return diff === null || diff <= toleranceDegrees;
}

export function roundMeters(value: number): number {
  return Math.max(0, Math.round(value));
}
