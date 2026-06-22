import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppLogController } from "../../src/http/controllers/app-log.controller.js";
import { FileAppLogStore } from "../../src/infrastructure/app-logs/file-app-log-store.js";
import { validPayload } from "../fixtures/config.js";

describe("AppLogController", () => {
  it("does not expose the session id indirectly through the server log metadata", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "app-log-controller-"));
    const controller = new AppLogController(
      new FileAppLogStore(directory, {
        maxFileBytes: 1,
        maxFiles: 10,
        retentionMs: 60_000,
      }),
    );
    const logged: Record<string, unknown>[] = [];
    let responseBody: unknown;
    const payload = {
      sessionId: validPayload.sessionId,
      createdAt: "2026-06-17T20:30:01Z",
      kind: "road_context_event" as const,
      platform: "ios" as const,
      appName: "RoadRecorder",
      backendBaseURL: "https://example.test",
      message: "test",
    };

    await controller.handle(
      {
        id: "request-1",
        body: payload,
        log: {
          info(metadata: Record<string, unknown>) {
            logged.push(metadata);
          },
        },
      } as never,
      {
        send(body: unknown) {
          responseBody = body;
        },
      } as never,
    );

    expect(responseBody).toMatchObject({ stored: true });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ kind: "road_context_event", rotated: false });
    expect(logged[0]).not.toHaveProperty("file");
    expect(JSON.stringify(logged[0])).not.toContain(validPayload.sessionId);
  });
});
