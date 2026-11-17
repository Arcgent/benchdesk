import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
const find = (name: string) => {
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (/bmone-title-hooks|context-links/.test(dir)) continue;
    const path = join(dir, name);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {}
  }
  return "";
};
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const providers = ["claude", "codex"].map((name) => {
  const path = find(name);
  const result = path
    ? spawnSync(path, ["--version"], { encoding: "utf8", env, timeout: 6000 })
    : null;
  return { name, path, version: (result?.stdout || "").trim().slice(0, 100) };
});
process.stdout.write(
  "\nWERK_INVENTORY:" +
    JSON.stringify({ shell: process.env.SHELL || "/bin/zsh", providers }) +
    "\n",
);
