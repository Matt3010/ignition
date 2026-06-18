export interface ImportLogRepository {
  record(input: {
    source: string;
    version: string;
    status: "success" | "failed";
    recordsCount: number;
    bbox?: string | null;
    filePath?: string | null;
    deactivatedCount?: number;
    errorMessage?: string | null;
  }): Promise<void>;
}
