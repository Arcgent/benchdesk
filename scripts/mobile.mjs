import { build } from "esbuild";
import { build as viteBuild } from "vite";
import react from "@vitejs/plugin-react";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import electron from "electron";

if (!process.argv.includes("--start")) {
  await build({
    entryPoints: ["src/mobile/start.ts"],
    outfile: "dist/mobile/start.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  await viteBuild({
    configFile: false,
    root: "src/mobile",
    base: "/",
    plugins: [react()],
    build: { outDir: "../../dist/mobile/ui", emptyOutDir: true },
  });
}
if (!process.argv.includes("--build")) {
  const child = spawn(electron, [resolve("dist/mobile/start.cjs")], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code ?? 1));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.on(signal, () => child.kill(signal));
}
