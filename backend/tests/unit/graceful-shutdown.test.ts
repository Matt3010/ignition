import { registerGracefulShutdown } from "../../src/infrastructure/runtime/graceful-shutdown.js";

describe("graceful shutdown", () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it("closes the application once when multiple signals arrive", async () => {
    const listeners = new Map<string, () => void>();
    let closeCalls = 0;
    const app = {
      close: async () => {
        closeCalls += 1;
      },
      log: { info: () => undefined, error: () => undefined },
    };

    registerGracefulShutdown(app, {
      once: (signal, listener) => listeners.set(signal, listener),
    });

    listeners.get("SIGTERM")?.();
    listeners.get("SIGINT")?.();
    await new Promise((resolve) => setImmediate(resolve));

    expect(closeCalls).toBe(1);
    expect(process.exitCode).toBe(0);
  });

  it("sets a failing exit code when close fails", async () => {
    const listeners = new Map<string, () => void>();
    const errors: Record<string, unknown>[] = [];
    const app = {
      close: async () => {
        throw new Error("close failed");
      },
      log: { info: () => undefined, error: (data: Record<string, unknown>) => errors.push(data) },
    };

    registerGracefulShutdown(app, {
      once: (signal, listener) => listeners.set(signal, listener),
    });

    listeners.get("SIGTERM")?.();
    await new Promise((resolve) => setImmediate(resolve));

    expect(process.exitCode).toBe(1);
    expect(errors).toHaveLength(1);
  });
});
