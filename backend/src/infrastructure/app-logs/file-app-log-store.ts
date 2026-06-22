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
  private appendQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory: string,
    private readonly options: FileAppLogStoreOptions = defaultOptions,
  ) {}

  async append(payload: AppLogRequest, metadata: { requestId: string; receivedAt: string }): Promise<string> {
    const previous = this.appendQueue;
    let release!: () => void;
    this.appendQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      await mkdir(this.directory, { recursive: true });
      await this.performCleanup();

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
      await this.performCleanup(file);
      return file;
    } finally {
      release();
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

  private async performCleanup(protectedFile?: string): Promise<void> {
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

    const cutoff = Date.now() - this.options.retentionMs;
    const expired = files.filter(
      (file) => file.modifiedAt < cutoff && file.name !== protectedFile,
    );
    await Promise.all(expired.map((file) => this.unlinkIfPresent(file.filePath)));

    const expiredNames = new Set(expired.map((file) => file.name));
    const remaining = files
      .filter((file) => !expiredNames.has(file.name))
      .sort((left, right) => right.modifiedAt - left.modifiedAt);
    const removable = remaining.filter((file) => file.name !== protectedFile);
    const protectedCount = protectedFile && remaining.some((file) => file.name === protectedFile) ? 1 : 0;
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
