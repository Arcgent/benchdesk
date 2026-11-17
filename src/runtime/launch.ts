import { interactiveEnvironment } from "./terminal-env";
import { readFileSync, writeFileSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { findCuaInstallation, withCuaArgs } from "./cua-repl";
import { join, delimiter } from "node:path";
import { spawn } from "node:child_process";
import { agentRequest } from "./rpc";
import {
  accountEnvironment,
  clearAccountOverrides,
  isolatedAccount,
} from "./accounts";
export function findProgram(name: string) {
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (/bmone-title-hooks|context-links/.test(dir)) continue;
    const file = join(dir, name);
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {}
  }
  return "";
}
async function main() {
  const config = JSON.parse(
    readFileSync(process.env.WERK_LAUNCH_FILE!, "utf8"),
  );
  const executable = findProgram(config.provider);
  if (!executable) {
    process.stderr.write(
      `\r\n${config.provider} is niet gevonden in je login-shell. Installeer de CLI of pas je PATH aan.\r\n`,
    );
    await agentRequest("launch.end", {
      error: "CLI niet gevonden in PATH.",
    }).catch(() => {});
    return;
  }
  await agentRequest("launch.start", { executable }).catch(() => {});
  const env = interactiveEnvironment(process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  if (isolatedAccount(config.provider, config.accountConfigDir))
    clearAccountOverrides(env, config.provider);
  Object.assign(
    env,
    accountEnvironment(config.provider, config.accountConfigDir),
  );
  let args: string[] = [...config.args];
  if (config.provider === "codex" && !config.authAction) {
    const installation = findCuaInstallation(
      env.CODEX_HOME || join(homedir(), ".codex"),
    );
    args = withCuaArgs(args, installation);
    writeFileSync(
      process.env.WERK_LAUNCH_FILE! + ".cua.json",
      JSON.stringify({
        configured: installation.available,
        version: installation.version,
      }),
      { mode: 0o600 },
    );
  }
  // Benchdesk stores the prompt last. Claude's variadic --mcp-config would consume
  // it as another filename without an option boundary, including on resume.
  if (
    config.provider === "claude" &&
    !config.authAction &&
    !args.includes("--")
  )
    args.splice(args.length - 1, 0, "--");
  const child = spawn(executable, args, {
    stdio: "inherit",
    env,
    cwd: process.cwd(),
  });
  // The PTY delivers Ctrl-C to both processes; only the actual CLI handles it.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  const exit = await new Promise<{
    code: number | null;
    signal?: string | null;
    error?: string;
  }>((resolve) => {
    child.once("error", (e) => resolve({ code: 1, error: e.message }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  process.removeListener("SIGINT", ignore);
  await agentRequest("launch.end", {
    code: exit.code,
    error:
      exit.error ||
      (exit.code === 0
        ? ""
        : exit.signal
          ? `Het agentproces is beëindigd (${exit.signal}).`
          : `Het agentproces stopte met foutcode ${exit.code}. Bekijk de terminaluitvoer.`),
  }).catch(() => {});
  process.stdout.write(
    "\r\n\x1b[90mGesprek beëindigd. Je volledige shell blijft beschikbaar.\x1b[0m\r\n",
  );
}
if (process.env.WERK_LAUNCH_FILE)
  main().catch(async (e) => {
    process.stderr.write(`Benchdesk: ${e.message}\n`);
    await agentRequest("launch.end", { error: e.message }).catch(() => {});
    process.exitCode = 1;
  });
