import { buildApp } from "./app.js";
import { loadConfig } from "./config/env.js";
import { registerGracefulShutdown } from "./infrastructure/runtime/graceful-shutdown.js";

const config = loadConfig();
const app = await buildApp(config);
registerGracefulShutdown(app);

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (error) {
  app.log.error({ err: error }, "server start failed");
  await app.close().catch((closeError) => {
    app.log.error({ err: closeError }, "server cleanup after start failure failed");
  });
  process.exitCode = 1;
}
