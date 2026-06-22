import { appLogRequestSchema } from "../../src/http/schemas/app-log.schema.js";

const base = {
  sessionId: "550e8400-e29b-41d4-a716-446655440099",
  createdAt: "2026-06-22T12:00:00Z",
  platform: "ios" as const,
  appName: "RoadRecorder",
  backendBaseURL: "https://roads.example.test",
};

describe("app log schema", () => {
  it.each([
    "session_start",
    "session_stop",
    "road_context_event",
    "client_error",
    "location_error",
    "session_permission_denied",
    "session_permission_unknown",
  ])("accepts client log kind %s", (kind) => {
    expect(appLogRequestSchema.safeParse({ ...base, kind }).success).toBe(true);
  });
});
