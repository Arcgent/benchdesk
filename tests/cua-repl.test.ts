import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "smol-toml";
import { findCuaInstallation, withCuaArgs } from "../src/runtime/cua-repl";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "benchdesk cua "));
  const account = join(home, "separate account");
  const node = join(home, "node"),
    repl = join(home, "node_repl"),
    service = join(home, "Computer Use.app");
  for (const path of [node, repl])
    writeFileSync(path, "fixture", { mode: 0o700 });
  mkdirSync(service);
  const install = (
    version: string,
    root = join(home, ".codex"),
    enabled = true,
  ) => {
    const plugin = join(
      root,
      "plugins/cache/openai-bundled/unified-computer-use",
      version,
    );
    mkdirSync(join(plugin, ".codex-plugin"), { recursive: true });
    const launcher = join(plugin, "launch.mjs");
    writeFileSync(launcher, "// fixture");
    writeFileSync(
      join(plugin, ".codex-plugin/plugin.json"),
      JSON.stringify({ name: "unified-computer-use" }),
    );
    writeFileSync(
      join(plugin, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          cua_repl: {
            command: node,
            args: [launcher],
            enabled,
            env: {
              CUA_REPL_NODE_REPL_PATH: repl,
              SKY_CUA_SERVICE_PATH: service,
              CODEX_HOME: root,
              CUA_REPL_ENABLED_SURFACES: "browser,computer",
            },
          },
        },
      }),
    );
    return plugin;
  };
  return {
    home,
    account,
    repl,
    install,
    discover: () => findCuaInstallation(account, home, "darwin"),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

test("separate Codex account uses installed CUA, retaining its own session home", () => {
  const f = fixture();
  try {
    f.install("26.9.2");
    f.install("26.9.10");
    const result = f.discover();
    assert.equal(result.available, true);
    assert.equal(result.version, "26.9.10");
    assert.equal(result.server!.env.CODEX_HOME, f.account);
    assert.equal(
      result.server!.env.CUA_REPL_ENABLED_SURFACES,
      "browser,computer",
    );
    assert.deepEqual(result.server!.enabled_tools, ["js", "js_reset"]);
  } finally {
    f.cleanup();
  }
});
test("missing or broken plugin does not inject an unusable MCP server", () => {
  const f = fixture();
  try {
    assert.equal(f.discover().available, false);
    f.install("26.9.10");
    rmSync(f.repl);
    assert.equal(f.discover().available, false);
    assert.deepEqual(withCuaArgs(["prompt"], f.discover()), ["prompt"]);
  } finally {
    f.cleanup();
  }
});
test("disabled/incomplete releases are skipped and account installation takes priority", () => {
  const f = fixture();
  try {
    f.install("26.9.1");
    f.install("26.9.20", undefined, false);
    assert.equal(f.discover().version, "26.9.1");
    f.install("26.9.2", f.account);
    assert.equal(f.discover().version, "26.9.2");
  } finally {
    f.cleanup();
  }
});
test("CUA override preserves resumed session, existing hooks and literal prompt", () => {
  const f = fixture();
  try {
    f.install("26.9.10");
    const original = [
      "resume",
      "thread-123",
      "-c",
      "hooks={}",
      "Prompt with ' quotes and $variables",
    ];
    const args = withCuaArgs(original, f.discover());
    assert.deepEqual(args.slice(0, 4), original.slice(0, 4));
    assert.equal(args.at(-1), original.at(-1));
    const parsed = parse(args.at(-2)!) as any;
    assert.deepEqual(parsed.mcp_servers.cua_repl, f.discover().server);
    assert.equal(original.length, 5);
  } finally {
    f.cleanup();
  }
});
test("unsupported platforms do not enable this macOS integration", () => {
  const f = fixture();
  try {
    f.install("26.9.10");
    assert.equal(
      findCuaInstallation(f.account, f.home, "linux").available,
      false,
    );
  } finally {
    f.cleanup();
  }
});
