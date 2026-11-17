import { spawn } from "node:child_process";
import { resolve } from "node:path";
import electron from "electron";
const child = spawn(electron, [resolve("dist/web/server.cjs")], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => child.kill(signal));
