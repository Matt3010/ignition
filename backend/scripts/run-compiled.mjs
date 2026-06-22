import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const allowed = new Set([
  "migrate",
  "import-alerts",
  "import-osm-alerts",
  "purge-non-osm-alerts",
  "raspberry-smoke",
  "health",
]);

const command = process.argv[2];
if (!command || !allowed.has(command)) {
  console.error(`Unsupported script: ${command ?? "missing"}`);
  process.exit(64);
}

const forwardedArgs = process.argv.slice(3);
const compiled = new URL(`../dist/scripts/${command}.js`, import.meta.url);
const source = new URL(`./${command}.ts`, import.meta.url);
let executableArgs;

if (existsSync(compiled)) {
  executableArgs = [fileURLToPath(compiled), ...forwardedArgs];
} else {
  const tsxCli = new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url);
  if (!existsSync(tsxCli) || !existsSync(source)) {
    console.error(
      `Cannot run ${command}: build output is missing and the local tsx development runner is unavailable. Run npm ci && npm run build.`,
    );
    process.exit(69);
  }
  executableArgs = [fileURLToPath(tsxCli), fileURLToPath(source), ...forwardedArgs];
}

const result = spawnSync(process.execPath, executableArgs, {
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
