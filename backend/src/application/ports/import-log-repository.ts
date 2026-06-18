export interface ImportLogRepository {
  record(input: {
    source: string;
    version: string;
    status: "success" | "failed";
    recordsCount: number;
    errorMessage?: string | null;
  }): Promise<void>;
}
