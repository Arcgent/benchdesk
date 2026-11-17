import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse } from "smol-toml";
import { shellQuote } from "./adapters";
import type { Inventory } from "../shared/types";
const read = (path: string) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
};
export async function inventory(
  cwd: string,
  runtimeDir: string,
): Promise<Inventory> {
  const result: Inventory = {
    shell: process.env.SHELL || "/bin/zsh",
    providers: [],
    mcps: [],
    skills: [],
    inspectedAt: new Date().toISOString(),
  };
  const shell = await promisify(execFile)(
    result.shell,
    [
      "-ilc",
      `ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} ${shellQuote(join(runtimeDir, "inspect-shell.cjs"))}`,
    ],
    {
      cwd,
      timeout: 18000,
      maxBuffer: 100000,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        CLAUDECODE: undefined,
      },
    },
  );
  const line = shell.stdout
    .split("\n")
    .find((l) => l.startsWith("WERK_INVENTORY:"));
  if (line) Object.assign(result, JSON.parse(line.slice(15)));
  const home = homedir(),
    globalClaude = read(join(home, ".claude.json")),
    local = read(join(cwd, ".claude/settings.local.json"));
  const entries = new Map<string, Inventory["mcps"][number]>();
  for (const [source, servers] of [
    [
      join(home, ".claude/settings.json"),
      read(join(home, ".claude/settings.json")).mcpServers,
    ],
    [join(home, ".claude.json"), globalClaude.mcpServers],
    [join(cwd, ".mcp.json"), read(join(cwd, ".mcp.json")).mcpServers],
    [
      `${join(home, ".claude.json")} → ${cwd}`,
      globalClaude.projects?.[cwd]?.mcpServers,
    ],
  ] as const) {
    for (const name of Object.keys(servers || {}))
      entries.set(name, {
        name,
        source,
        provider: "claude",
        enabled: !(local.disabledMcpjsonServers || []).includes(name),
      });
  }
  result.mcps.push(...entries.values());
  const codexEntries = new Map<string, Inventory["mcps"][number]>();
  for (const path of [
    join(home, ".codex/config.toml"),
    join(cwd, ".codex/config.toml"),
  ])
    try {
      const config = parse(readFileSync(path, "utf8")) as any;
      for (const [name, value] of Object.entries(
        config.mcp_servers || {},
      ) as any[])
        codexEntries.set(name, {
          name,
          source: path,
          provider: "codex",
          enabled: value.enabled !== false,
        });
    } catch {}
  result.mcps.push(...codexEntries.values());
  for (const [path, provider] of [
    [join(cwd, ".claude/skills"), "Claude · project"],
    [join(home, ".claude/skills"), "Claude · persoonlijk"],
    [join(cwd, ".agents/skills"), "Codex · project"],
    [join(home, ".agents/skills"), "Codex · persoonlijk"],
    [join(home, ".codex/skills"), "Codex · bestaande map"],
  ] as const) {
    try {
      const count = readdirSync(path).filter((name) =>
        existsSync(join(path, name, "SKILL.md")),
      ).length;
      result.skills.push({ path, count, provider });
    } catch {}
  }
  return result;
}
