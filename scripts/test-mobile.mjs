import { build } from "esbuild";
import { spawn } from "node:child_process";
await build({
  entryPoints: ["tests/mobile.test.ts"],
  outfile: "tmp/mobile/mobile.test.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
});
const child = spawn(
  process.execPath,
  ["--test", "tmp/mobile/mobile.test.cjs"],
  { stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 1));
