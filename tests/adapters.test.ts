import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "smol-toml";
import { adapterConfig, benchdeskInstructions, promptFor, shellQuote, toml } from "../src/runtime/adapters";
import { findProgram } from "../src/runtime/launch";

test("Claude-configuratie voegt alleen taak-MCP en hooks toe en houdt hervatten expliciet", () => {
  const config = adapterConfig(
    "claude",
    "/test path/runtime",
    "/test path/Electron",
    "test-session",
  );
  assert.deepEqual(config.args, ["--resume", "test-session"]);
  assert.deepEqual(Object.keys(config.mcp), ["command", "args", "env"]);
  assert.ok(!config.args.includes("--strict-mcp-config"));
  assert.ok(!config.args.includes("--dangerously-skip-permissions"));
  const path = "/test/path with 'quotes' and $VARIABLE";
  const result = spawnSync("/bin/sh", ["-c", "printf %s " + shellQuote(path)], {
    encoding: "utf8",
  });
  assert.equal(result.stdout, path);
});

test("Codex-configuratie houdt normale rechten en geeft alleen taakverbinding door aan de extra MCP", () => {
  const config = adapterConfig(
    "codex",
    "/test path/runtime",
    "/test path/Electron",
    "test-session",
  );
  assert.deepEqual(config.args.slice(0, 2), ["resume", "test-session"]);
  const override = config.args.find((a) => a.startsWith("mcp_servers."))!;
  const parsed: any = parse(override);
  assert.deepEqual(parsed.mcp_servers.werk_task_context.env_vars, [
    "WERK_SOCKET",
    "WERK_SESSION_ID",
    "WERK_SESSION_TOKEN",
  ]);
  assert.ok(
    !config.args.some((a) => /bypass|approval_policy|sandbox|model=/.test(a)),
  );
});

test("geïnstalleerde Codex accepteert de extra instructies, hooks en MCP-configuratie", (t) => {
  const codex = findProgram("codex");
  if (!existsSync(codex)) return t.skip("Lokale Codex CLI niet geïnstalleerd");
  const config = adapterConfig(
    "codex",
    resolve("dist/runtime"),
    process.execPath,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(
    codex,
    [...config.args, "-c", `developer_instructions=${toml(benchdeskInstructions("work"))}`, "mcp", "get", "werk_task_context", "--json"],
    { encoding: "utf8", env, timeout: 15000 },
  );
  assert.equal(result.status, 0, result.stderr);
  const server = JSON.parse(result.stdout);
  assert.equal(server.transport.command, process.execPath);
  assert.ok(server.transport.env_vars.includes("WERK_SESSION_TOKEN"));
});

test("korte startprompts behouden de opdracht; alle werkregels blijven in de instructielaag", () => {
  for (const mode of ["work", "intake", "planning", "suggestions"] as const) {
    const instructions = benchdeskInstructions(mode);
    assert.match(instructions, /save_session_memory/);
    assert.match(instructions, /expectedRevision/);
    assert.match(instructions, /save_brain_changes/);
    assert.match(instructions, /gmail_create_draft/);
    assert.match(instructions, /Behoud normale toestemmingen/);
    assert.match(promptFor(mode), /get_task_context/);
    assert.ok(promptFor(mode).length < 220);
  }
  assert.match(benchdeskInstructions("work"), /submit_result/);
  assert.match(benchdeskInstructions("intake"), /propose_company_context/);
  assert.match(benchdeskInstructions("planning"), /propose_priorities/);
  assert.match(benchdeskInstructions("suggestions"), /propose_next_actions/);
  assert.match(benchdeskInstructions("suggestions"), /Voer geen voorgestelde taken uit/);
});
