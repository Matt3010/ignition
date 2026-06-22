export interface ClosableApplication {
  close(): Promise<void>;
  log: {
    info(data: Record<string, unknown>, message: string): void;
    error(data: Record<string, unknown>, message: string): void;
  };
}

export interface SignalSource {
  once(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown;
}

export function registerGracefulShutdown(
  app: ClosableApplication,
  signalSource: SignalSource = process,
): () => Promise<void> {
  let shuttingDown = false;

  const shutdown = async (signal: "SIGTERM" | "SIGINT"): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "server shutdown started");

    try {
      await app.close();
      process.exitCode = 0;
    } catch (error) {
      app.log.error({ err: error, signal }, "server shutdown failed");
      process.exitCode = 1;
    }
  };

  signalSource.once("SIGTERM", () => void shutdown("SIGTERM"));
  signalSource.once("SIGINT", () => void shutdown("SIGINT"));

  return () => shutdown("SIGTERM");
}
