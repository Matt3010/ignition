import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileAppLogStore } from "../../src/infrastructure/app-logs/file-app-log-store.js";
import type { AppLogRequest } from "../../src/http/schemas/app-log.schema.js";

const sessionId = "550e8400-e29b-41d4-a716-446655440099";

function payload(index: number): AppLogRequest {
  return {
    sessionId,
    createdAt: "2026-06-22T12:00:00Z",
    kind: "road_context_event",
    platform: "ios",
    appName: "RoadRecorder",
    appVersion: "1.0",
    backendBaseURL: "https://roads.example.test",
    message: `event-${index}-${"x".repeat(100)}`,
  };
}

describe("FileAppLogStore", () => {
  it("serializes concurrent writes for the same session and creates unique rotated files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "file-app-log-store-"));
    const store = new FileAppLogStore(directory, {
      maxFileBytes: 220,
      maxFiles: 20,
      retentionMs: 60_000,
    });

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.append(payload(index), {
          requestId: `request-${index}`,
          receivedAt: "2026-06-22T12:00:00Z",
        }),
      ),
    );

    const files = (await readdir(directory)).filter((file) => file.endsWith(".jsonl"));
    expect(new Set(files).size).toBe(files.length);
    expect(files).toContain(`${sessionId}.jsonl`);
    expect(files.filter((file) => file !== `${sessionId}.jsonl`).every((file) => file.includes(sessionId))).toBe(true);

    const records = (
      await Promise.all(files.map((file) => readFile(path.join(directory, file), "utf8")))
    )
      .flatMap((content) => content.trim().split("\n"))
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { requestId: string });

    expect(records).toHaveLength(8);
    expect(new Set(records.map((record) => record.requestId)).size).toBe(8);
  });

  it("enforces maxFiles after creating a rotated file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "file-app-log-store-limit-"));
    const store = new FileAppLogStore(directory, {
      maxFileBytes: 220,
      maxFiles: 3,
      retentionMs: 60_000,
    });

    for (let index = 0; index < 8; index += 1) {
      await store.append(payload(index), {
        requestId: `request-${index}`,
        receivedAt: "2026-06-22T12:00:00Z",
      });
    }

    const files = (await readdir(directory)).filter((file) => file.endsWith(".jsonl"));
    expect(files.length).toBeLessThanOrEqual(3);
  });
});

it("handles concurrent writes from different sessions without losing active base files", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "file-app-log-store-multi-session-"));
  const store = new FileAppLogStore(directory, {
    maxFileBytes: 220,
    maxFiles: 4,
    retentionMs: 60_000,
  });

  const sessionIds = Array.from({ length: 4 }, (_, index) =>
    `550e8400-e29b-41d4-a716-4466554401${index}`,
  );
  await Promise.all(sessionIds.map((id, index) => store.append({ ...payload(index), sessionId: id }, {
    requestId: `multi-${index}`,
    receivedAt: "2026-06-22T12:00:00Z",
  })));

  const files = (await readdir(directory)).filter((file) => file.endsWith(".jsonl"));
  for (const id of sessionIds) expect(files).toContain(`${id}.jsonl`);
});

it("keeps maxFiles as a hard limit across many concurrent sessions", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "file-app-log-store-hard-limit-"));
  const store = new FileAppLogStore(directory, {
    maxFileBytes: 10_000,
    maxFiles: 3,
    retentionMs: 60_000,
  });
  const sessionIds = Array.from({ length: 12 }, (_, index) =>
    `550e8400-e29b-41d4-a716-44665544${String(index).padStart(4, "0")}`,
  );

  await Promise.all(sessionIds.map((id, index) => store.append({ ...payload(index), sessionId: id }, {
    requestId: `hard-${index}`,
    receivedAt: "2026-06-22T12:00:00Z",
  })));

  const files = (await readdir(directory)).filter((file) => file.endsWith(".jsonl"));
  expect(files.length).toBeLessThanOrEqual(3);
});
