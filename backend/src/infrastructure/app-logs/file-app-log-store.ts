import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { AppLogRequest } from "../../http/schemas/app-log.schema.js";

interface FileAppLogStoreOptions {
  maxFileBytes: number;
  maxFiles: number;
  retentionMs: number;
}

const defaultOptions: FileAppLogStoreOptions = {
  maxFileBytes: 5_000_000,
  maxFiles: 200,
  retentionMs: 14 * 24 * 60 * 60 * 1000,
};

export class FileAppLogStore {
  private cleanupPromise: Promise<void> | null = null;
  private readonly sessionQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly directory: string,
    private readonly options: FileAppLogStoreOptions = defaultOptions,
  ) {}

  async append(payload: AppLogRequest, metadata: { requestId: string; receivedAt: string }): Promise<string> {
    return this.enqueueForSession(payload.sessionId, async () => {
      await mkdir(this.directory, { recursive: true });
      await this.cleanup();

      const baseFile = `${payload.sessionId}.jsonl`;
      const filePath = path.join(this.directory, baseFile);
      const record = {
        receivedAt: metadata.receivedAt,
        requestId: metadata.requestId,
        ...payload,
      };
      const line = `${JSON.stringify(record)}\n`;
      const file = await this.rotateIfNeeded(baseFile, filePath, Buffer.byteLength(line));
      await appendFile(path.join(this.directory, file), line, "utf8");

      // Enforce retention and maxFiles after a possible rotation/new file creation as well.
      await this.cleanup();
      return file;
    });
  }

  private async enqueueForSession<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.sessionQueues.set(sessionId, queued);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.sessionQueues.get(sessionId) === queued) {
        this.sessionQueues.delete(sessionId);
      }
    }
  }

  private async rotateIfNeeded(baseFile: string, filePath: string, incomingBytes: number): Promise<string> {
    try {
      const current = await stat(filePath);
      if (current.size + incomingBytes <= this.options.maxFileBytes) return baseFile;

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const rotated = baseFile.replace(/\.jsonl$/, `.${timestamp}.${randomUUID()}.jsonl`);
      await rename(filePath, path.join(this.directory, rotated));
      return baseFile;
    } catch (error) {
      if (isMissingFile(error)) return baseFile;
      throw error;
    }
  }

  private async cleanup(): Promise<void> {
    if (!this.cleanupPromise) {
      this.cleanupPromise = this.performCleanup().finally(() => {
        this.cleanupPromise = null;
      });
    }
    await this.cleanupPromise;
  }

  private async performCleanup(): Promise<void> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    const files = (await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map(async (entry) => {
          const filePath = path.join(this.directory, entry.name);
          try {
            const info = await stat(filePath);
            return { name: entry.name, filePath, modifiedAt: info.mtimeMs };
          } catch (error) {
            if (isMissingFile(error)) return null;
            throw error;
          }
        }),
    )).filter((file): file is { name: string; filePath: string; modifiedAt: number } => file !== null);

    const protectedBaseFiles = new Set(
      [...this.sessionQueues.keys()].map((sessionId) => `${sessionId}.jsonl`),
    );
    const cutoff = Date.now() - this.options.retentionMs;
    const expired = files.filter(
      (file) => file.modifiedAt < cutoff && !protectedBaseFiles.has(file.name),
    );
    await Promise.all(expired.map((file) => this.unlinkIfPresent(file.filePath)));

    const expiredNames = new Set(expired.map((file) => file.name));
    const remaining = files
      .filter((file) => !expiredNames.has(file.name))
      .sort((left, right) => right.modifiedAt - left.modifiedAt);
    const removable = remaining.filter((file) => !protectedBaseFiles.has(file.name));
    const protectedCount = remaining.length - removable.length;
    const removableLimit = Math.max(0, this.options.maxFiles - protectedCount);
    const excess = removable.slice(removableLimit);
    await Promise.all(excess.map((file) => this.unlinkIfPresent(file.filePath)));
  }
  private async unlinkIfPresent(filePath: string): Promise<void> {
    try {
      await unlink(filePath);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }

}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
