import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { toml } from "./adapters";

const serverSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().optional(),
});
export type CuaInstallation = {
  available: boolean;
  version: string | null;
  reason: string;
  server?: {
    command: string;
    args: string[];
    env: Record<string, string>;
    enabled: true;
    enabled_tools: string[];
    startup_timeout_sec: number;
  };
};

// Use the installed OpenAI plugin without copying code or inventing turn
// metadata. Codex itself supplies the authenticated session/turn context.
export function findCuaInstallation(
  accountHome = join(homedir(), ".codex"),
  userHome = homedir(),
  platform = process.platform,
): CuaInstallation {
  if (platform !== "darwin")
    return {
      available: false,
      version: null,
      reason: "Deze koppeling is beschikbaar op macOS.",
    };
  const homes = [...new Set([accountHome, join(userHome, ".codex")])];
  for (const home of homes) {
    const root = join(
      home,
      "plugins/cache/openai-bundled/unified-computer-use",
    );
    let versions: string[];
    try {
      versions = readdirSync(root)
        .filter((v) => /^\d+(?:\.\d+)+$/.test(v))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    } catch {
      continue;
    }
    for (const version of versions) {
      try {
        const plugin = join(root, version);
        const metadata = JSON.parse(
          readFileSync(join(plugin, ".codex-plugin/plugin.json"), "utf8"),
        );
        if (metadata.name !== "unified-computer-use") continue;
        const manifest = JSON.parse(
          readFileSync(join(plugin, ".mcp.json"), "utf8"),
        );
        const source = serverSchema.parse(manifest.mcpServers?.cua_repl);
        if (source.enabled === false || !isAbsolute(source.command)) continue;
        accessSync(source.command, constants.X_OK);
        const repl = source.env.CUA_REPL_NODE_REPL_PATH;
        const service = source.env.SKY_CUA_SERVICE_PATH;
        if (!repl || !isAbsolute(repl) || !service || !isAbsolute(service))
          continue;
        accessSync(repl, constants.X_OK);
        if (
          !existsSync(service) ||
          !source.args.length ||
          source.args.some((arg) => !isAbsolute(arg) || !existsSync(arg))
        )
          continue;
        return {
          available: true,
          version,
          reason: "OpenAI Computer Use is beschikbaar.",
          server: {
            command: source.command,
            args: source.args,
            env: { ...source.env, CODEX_HOME: accountHome },
            enabled: true,
            enabled_tools: ["js", "js_reset"],
            startup_timeout_sec: 120,
          },
        };
      } catch {
        /* An incomplete update must not prevent a terminal starting. */
      }
    }
  }
  return {
    available: false,
    version: null,
    reason:
      "Open ChatGPT en installeer of activeer de Computer Use-plugin. Start daarna een nieuw Codex-gesprek in Benchdesk.",
  };
}

export function withCuaArgs(
  args: string[],
  installation: CuaInstallation,
): string[] {
  if (!installation.server) return [...args];
  // Before the positional prompt, including codex resume <id> ... <prompt>.
  return [
    ...args.slice(0, -1),
    "-c",
    `mcp_servers.cua_repl=${toml(installation.server)}`,
    args.at(-1)!,
  ];
}
