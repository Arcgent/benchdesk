import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import electron from "electron";
const files = (await readdir("dist/tests"))
  .filter((f) => f.endsWith(".test.cjs"))
  .map((f) => `dist/tests/${f}`);
const testEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
// Tests must never inherit the active Benchdesk session connection.
for (const key of ["WERK_SOCKET", "WERK_SESSION_ID", "WERK_SESSION_TOKEN", "WERK_DATA_DIR", "WERK_LAUNCH_FILE"]) delete testEnv[key];
const child = spawn(electron, ["--test", "--test-concurrency=1", ...files], {
  env: testEnv,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 1));
