import { build } from "esbuild";
import { build as viteBuild } from "vite";
import { mkdir, readdir, rm } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await rm("dist/native", { recursive: true, force: true });
await rm("dist/electron", { recursive: true, force: true });
await build({
  entryPoints: ["src/electron/main.ts", "src/electron/preload.ts"],
  outdir: "dist/electron",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  outExtension: { ".js": ".cjs" },
  sourcemap: true,
});
await build({
  entryPoints: [
    "src/runtime/runner.ts",
    "src/runtime/launch.ts",
    "src/runtime/hook.ts",
    "src/runtime/mcp.ts",
    "src/runtime/inspect-shell.ts",
  ],
  outdir: "dist/runtime",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: [
    "node-pty",
    "@anthropic-ai/claude-agent-sdk",
    "better-sqlite3",
    "@xterm/headless",
    "@xterm/addon-serialize",
  ],
  outExtension: { ".js": ".cjs" },
  sourcemap: true,
});
await build({
  entryPoints: ["src/web/server.ts"],
  outdir: "dist/web",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["better-sqlite3", "node-pty"],
  outExtension: { ".js": ".cjs" },
  sourcemap: true,
});
if (process.argv.includes("--tests")) {
  await rm("dist/tests", { recursive: true, force: true });
  const tests = (await readdir("tests"))
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => `tests/${f}`);
  await build({
    entryPoints: tests,
    outdir: "dist/tests",
    bundle: true,
    platform: "node",
    format: "cjs",
    external: [
      "@anthropic-ai/claude-agent-sdk",
      "node-pty",
      "better-sqlite3",
      "@xterm/headless",
      "@xterm/addon-serialize",
    ],
    outExtension: { ".js": ".cjs" },
  });
} else await viteBuild();
