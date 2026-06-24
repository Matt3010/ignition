import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";

const describeLive = process.env.RUN_RUNTIME_INTEGRATION === "1" ? describe : describe.skip;

describeLive("real server runtime", () => {
  const databaseUrl = process.env.DATABASE_URL;
  const valhallaBaseUrl = process.env.VALHALLA_BASE_URL ?? "http://127.0.0.1:8002";

  beforeAll(() => {
    if (!databaseUrl) throw new Error("DATABASE_URL is required when RUN_RUNTIME_INTEGRATION=1");
  });

  it("starts the compiled production server and closes cleanly on SIGTERM", async () => {
    const port = await reserveFreePort();
    const child = spawn(process.execPath, ["dist/src/server.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: String(port),
        DATABASE_URL: databaseUrl!,
        VALHALLA_BASE_URL: valhallaBaseUrl,
        LOG_LEVEL: "silent",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const output: string[] = [];
    child.stdout?.on("data", (chunk) => output.push(String(chunk)));
    child.stderr?.on("data", (chunk) => output.push(String(chunk)));

    try {
      await waitForReady(`http://127.0.0.1:${port}/ready`, child, output);
      child.kill("SIGTERM");
      const exit = await waitForExit(child, 10_000);
      expect(exit.signal).toBeNull();
      expect(exit.code).toBe(0);
      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 25_000);
});

async function reserveFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to reserve a TCP port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitForReady(url: string, child: ChildProcess, output: string[]): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Server exited before readiness: ${output.join("")}`);
    }
    try {
      const response = await fetch(url);
      if (response.status === 200) return;
    } catch {
      // The socket is expected to refuse connections until Fastify starts listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Server did not become ready: ${output.join("")}`);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server did not exit after SIGTERM")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}
