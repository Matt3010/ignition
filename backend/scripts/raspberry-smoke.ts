const baseUrl = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000";
const latitude = numberEnv("SMOKE_LAT", 44.9646356);
const longitude = numberEnv("SMOKE_LON", 10.9995592);

const results = {
  baseUrl,
  health: await getJson("/health"),
  ready: await getJson("/ready"),
  config: await getJson("/api/v1/config"),
  roadContext: await postJson("/api/v1/road-context", {
    latitude,
    longitude,
    speedKmh: 42,
    course: 60,
    horizontalAccuracyMeters: 6,
    timestamp: new Date().toISOString(),
    sessionId: "550e8400-e29b-41d4-a716-446655440000",
  }),
};

console.log(JSON.stringify(results, null, 2));

if ((results.ready as { ready?: boolean }).ready !== true) {
  throw new Error("service not ready");
}

const roadContext = results.roadContext as { matched?: boolean; confidence?: number };
if (typeof roadContext.matched !== "boolean") throw new Error("invalid road context response");
if (typeof roadContext.confidence !== "number") throw new Error("invalid confidence response");

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`);
  const body = await response.json();
  if (!response.ok) throw new Error(`GET ${path} failed: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function postJson(path: string, payload: unknown): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`POST ${path} failed: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
