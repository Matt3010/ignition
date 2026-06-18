import { loadConfig } from "../src/config/env.js";

const config = loadConfig();
const response = await fetch(`http://${config.HOST === "0.0.0.0" ? "127.0.0.1" : config.HOST}:${config.PORT}/health`);
console.log(JSON.stringify(await response.json(), null, 2));
process.exit(response.ok ? 0 : 1);
