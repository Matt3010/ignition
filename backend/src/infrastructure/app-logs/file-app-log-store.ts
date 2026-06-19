import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AppLogRequest } from "../../http/schemas/app-log.schema.js";

export class FileAppLogStore {
  constructor(private readonly directory: string) {}

  async append(payload: AppLogRequest, metadata: { requestId: string; receivedAt: string }): Promise<string> {
    await mkdir(this.directory, { recursive: true });
    const file = `${payload.sessionId}.jsonl`;
    const filePath = path.join(this.directory, file);
    const record = {
      receivedAt: metadata.receivedAt,
      requestId: metadata.requestId,
      ...payload,
    };
    await appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
    return file;
  }
}
