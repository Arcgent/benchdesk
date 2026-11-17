import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  statSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { RpcClient } from "../src/runtime/rpc";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { findProgram } from "../src/runtime/launch";
import { configPath } from "../src/core/preferences";
import { parse } from "smol-toml";
import { benchdeskInstructions, promptFor } from "../src/runtime/adapters";

const runtimeDir = process.env.WERK_TEST_RUNTIME_DIR || resolve("dist/runtime");

async function until<T>(
  fn: () => Promise<T> | T,
  timeout = 10000,
): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value as NonNullable<T>;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("Testvoorwaarde niet bereikt binnen de timeout");
}
async function fixture(t: any, fakeProvider = false) {
  const root = mkdtempSync(join(tmpdir(), "werk-runner-")),
    workspace = join(root, "workspace"),
    dataDir = join(root, "data");
  mkdirSync(workspace);
  mkdirSync(dataDir);
  const dotdir = join(root, "shell");
  if (fakeProvider) {
    mkdirSync(dotdir);
    writeFileSync(
      join(dotdir, ".zshrc"),
      "export PATH=" + JSON.stringify(dotdir) + ":$PATH\n",
    );
    writeFileSync(
      join(dotdir, "codex"),
      '#!/bin/sh\nprintf \'%s\\0\' "$@" > "$WERK_LAUNCH_FILE.arguments"\nprintf %s "$WERK_SESSION_TOKEN" > "$WERK_LAUNCH_FILE.test-token"\nprintf "TEST_CLI_EXIT\\n"\nexit 7\n',
      { mode: 0o755 },
    );
    writeFileSync(
      join(dotdir, "claude"),
      '#!/bin/sh\nprintf \'%s\\0\' "$@" > "$WERK_LAUNCH_FILE.arguments"\n',
      { mode: 0o755 },
    );
  }
  let logs = "";
  let child: ChildProcess;
  let client: RpcClient;
  const connect = async () => {
    const c = new RpcClient(join(dataDir, "runner.sock"), {
      channel: "app",
      token: readFileSync(join(dataDir, "control-token"), "utf8"),
    });
    await c.call("ping");
    return c;
  };
  const boot = async () => {
    child = spawn(
      process.execPath,
      [join(runtimeDir, "runner.cjs")],
      {
        env: {
          ...process.env,
          ...(fakeProvider ? { ZDOTDIR: dotdir } : {}),
          ELECTRON_RUN_AS_NODE: "1",
          WERK_DATA_DIR: dataDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stderr?.on("data", (x) => {
      logs += x;
    });
    child.stdout?.on("data", (x) => {
      logs += x;
    });
    await until(async () => {
      if (child.exitCode !== null) throw new Error(logs);
      if (!existsSync(join(dataDir, "runner.sock"))) return false;
      try {
        client = await connect();
        return true;
      } catch {
        return false;
      }
    });
  };
  t.after(async () => {
    client?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  });
  await boot();
  const companyId = await client!.call("company.save", {
    value: { name: "Testbedrijf", workspacePath: workspace },
  });
  const projectId = await client!.call("project.save", {
    value: { companyId, name: "Voorstellen" },
  });
  const taskId = await client!.call("task.save", {
    value: { companyId, projectId, title: "Voorstel maken" },
  });
  return {
    root,
    workspace,
    dataDir,
    companyId,
    projectId,
    taskId,
    connect,
    boot,
    get client() {
      return client!;
    },
    get child() {
      return child!;
    },
  };
}

test(
  "echte PTY behoudt werkmap, uitvoer en invoer na loskoppelen van het venster",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const id = await f.client.call("session.start", {
      companyId: f.companyId,
      taskId: f.taskId,
      provider: "shell",
    });
    const cwdFile = join(f.workspace, "cwd.txt");
    const session = (await f.client.call<any>("snapshot")).sessions.find((s: any) => s.id === id);
    assert.equal(session.outputDir, realpathSync(f.workspace));
    assert.equal(existsSync(join(f.workspace, ".werk-results")), false);
    await f.client.call("session.write", {
      id,
      data:
        "pwd > " + JSON.stringify(cwdFile) + "; printf 'WERK_%s\\n' PTY_OK\r",
    });
    await until(async () =>
      (await f.client.call("session.screen", { id })).screen.includes(
        "WERK_PTY_OK",
      ),
    );
    assert.equal(
      readFileSync(cwdFile, "utf8")
        .trim()
        .replace(/^\/private/, ""),
      f.workspace.replace(/^\/private/, ""),
    );
    await f.client.call("session.resize", { id, cols: 120, rows: 35 });
    f.client.close();
    const second = await f.connect();
    t.after(() => second.close());
    const frame = await second.call("session.screen", { id });
    assert.equal(frame.cols, 120);
    assert.equal(frame.rows, 35);
    assert.ok(frame.screen.includes("WERK_PTY_OK"));
    await second.call("session.write", {
      id,
      data: "printf 'AFTER_%s\\n' RECONNECT\r",
    });
    await until(async () =>
      (await second.call("session.screen", { id })).screen.includes(
        "AFTER_RECONNECT",
      ),
    );
    await second.call("session.stop", { id });
    await until(
      async () =>
        !(await second.call("snapshot")).sessions.find((s: any) => s.id === id)
          .alive,
    );
    assert.equal(
      (await second.call("snapshot")).tasks.find((x: any) => x.id === f.taskId)
        .status,
      "in_progress",
    );
    assert.ok(
      (await second.call("session.screen", { id })).screen.includes(
        "AFTER_RECONNECT",
      ),
    );
  },
);

test("terminal results use the chosen company or project folder across providers", async (t) => {
  const f = await fixture(t, true);
  const projectPath = join(f.root, "project");
  const otherPath = join(f.root, "other-company");
  mkdirSync(projectPath);
  mkdirSync(otherPath);
  await f.client.call("project.save", {
    id: f.projectId,
    value: { companyId: f.companyId, name: "Project", workspacePath: projectPath },
  });
  const otherCompanyId = await f.client.call("company.save", {
    value: { name: "Other", workspacePath: otherPath },
  });
  for (const [companyId, taskId, provider, expected] of [
    [f.companyId, null, "codex", f.workspace],
    [f.companyId, f.taskId, "claude", projectPath],
    [otherCompanyId, null, "codex", otherPath],
  ]) {
    const id = await f.client.call<string>("session.start", { companyId, taskId, provider });
    const session = (await f.client.call<any>("snapshot")).sessions.find((s: any) => s.id === id);
    assert.equal(session.cwd, realpathSync(expected!));
    assert.equal(session.outputDir, session.cwd);
    assert.equal(existsSync(join(expected!, ".werk-results")), false);
    await f.client.call("session.stop", { id });
  }
});

test("taakmodel bereikt Codex en een taak met een actief gesprek kan niet worden verwijderd", async (t) => {
  const f = await fixture(t, true);
  await f.client.call("task.save", {
    id: f.taskId,
    value: {
      companyId: f.companyId,
      projectId: f.projectId,
      title: "Modeltaak",
      provider: "codex",
      model: "gpt-6-astra",
    },
  });
  const codex = await f.client.call<string>("session.start", {
    companyId: f.companyId,
    taskId: f.taskId,
    provider: "codex",
  });
  const launch = join(f.dataDir, "sessions", codex, "launch.json.arguments");
  await until(() => existsSync(launch));
  const args = readFileSync(launch, "utf8").split("\0").slice(0, -1);
  const model = args.find((arg) => arg.startsWith("model="));
  assert.equal(parse(model!).model, "gpt-6-astra");
  await until(async () =>
    !(await f.client.call<any>("snapshot")).sessions.find(
      (session: any) => session.id === codex,
    )?.agentRunning,
  );
  await f.client.call("session.stop", { id: codex });
  const shell = await f.client.call<string>("session.start", {
    companyId: f.companyId,
    taskId: f.taskId,
    provider: "shell",
  });
  await assert.rejects(
    f.client.call("task.remove", { id: f.taskId }),
    /actieve gesprek/,
  );
  await f.client.call("session.stop", { id: shell });
  await until(async () =>
    (await f.client.call<any>("snapshot")).sessions
      .filter((session: any) => session.taskId === f.taskId)
      .every((session: any) => !session.alive),
  );
  await f.client.call("task.remove", { id: f.taskId });
  assert.equal(
    (await f.client.call<any>("snapshot")).tasks.some(
      (task: any) => task.id === f.taskId,
    ),
    false,
  );
});

test(
  "MCP gebruikt echte stdio en mag uitsluitend de gekoppelde taak wijzigen",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const id = await f.client.call("session.start", {
      companyId: f.companyId,
      taskId: f.taskId,
      provider: "shell",
    });
    const tokenFile = join(f.workspace, "test-session-token");
    await f.client.call("session.write", {
      id,
      data:
        'printf %s "$WERK_SESSION_TOKEN" > ' + JSON.stringify(tokenFile) + "\r",
    });
    await until(
      () =>
        existsSync(tokenFile) && readFileSync(tokenFile, "utf8").length === 64,
    );
    const token = readFileSync(tokenFile, "utf8");
    const mcp = new Client({ name: "werk-integration-test", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(runtimeDir, "mcp.cjs")],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        WERK_SOCKET: join(f.dataDir, "runner.sock"),
        WERK_SESSION_ID: id,
        WERK_SESSION_TOKEN: token,
      },
      stderr: "pipe",
    });
    await mcp.connect(transport);
    t.after(() => mcp.close());
    const tools = await mcp.listTools();
    for (const name of [
      "gmail_list_accounts",
      "gmail_search",
      "gmail_read_thread",
      "gmail_create_draft",
      "fireflies_list_transcripts",
      "fireflies_get_transcript",
      "pocket_list_recordings",
      "pocket_get_recording",
      "pocket_list_tags",
      "unipile_list_accounts",
      "unipile_list_chats",
      "unipile_get_messages",
      "github_list_repositories",
      "github_search_issues",
      "github_get_issue",
    ])
      assert.ok(tools.tools.some((tool) => tool.name === name));
    assert.ok(!tools.tools.some((tool) => /gmail.*send/.test(tool.name)));
    const gmail = await mcp.callTool({
      name: "gmail_list_accounts",
      arguments: {},
    });
    assert.deepEqual(JSON.parse((gmail.content as any)[0].text), {
      accounts: [],
    });
    for (const name of ["search_company_brain", "read_brain_page", "read_brain_source", "list_brain_pending", "save_brain_changes", "get_context_details", "patch_session_memory"])
      assert.ok(tools.tools.some(tool => tool.name === name));
    assert.equal(tools.tools.length, 41);
    for (const name of ["search_agent_history", "get_agent_skill", "save_agent_skill", "list_agent_teammates", "handoff_agent_work", "read_agent_handoff", "ask_person", "show_component"])
      assert.ok(tools.tools.some(tool => tool.name === name));
    assert.ok(tools.tools.some(tool => tool.name === "get_agent_context"));
    assert.ok(tools.tools.some(tool => tool.name === "save_agent_memory"));
    for (const name of [
      "computer_status",
      "computer_screenshot",
      "computer_action",
    ])
      assert.ok(
        !tools.tools.some((tool) => tool.name === name),
        "Legacy physical cursor tools must not be advertised",
      );
    const context = await mcp.callTool({
      name: "get_task_context",
      arguments: {},
    });
    assert.equal(
      JSON.parse((context.content as any)[0].text).task.id,
      f.taskId,
    );
    assert.equal(JSON.parse((context.content as any)[0].text).outputDirectory, realpathSync(f.workspace));
    const checkpoint = await mcp.callTool({
      name: "save_session_memory",
      arguments: {
        summary: "Voorstel voorbereid",
        completed: ["Drie varianten geschreven"],
        decisions: ["Eerst review"],
        nextSteps: ["Feedback verwerken"],
        blockers: [],
        expectedRevision: 0,
      },
    });
    assert.ok(!checkpoint.isError);
    const remembered = await mcp.callTool({
      name: "get_task_context",
      arguments: {},
    });
    assert.equal(
      JSON.parse((remembered.content as any)[0].text).sessionMemory.summary,
      "Voorstel voorbereid",
    );
    const hookResult = spawnSync(
      process.execPath,
      [join(runtimeDir, "hook.cjs")],
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          WERK_SOCKET: join(f.dataDir, "runner.sock"),
          WERK_SESSION_ID: id,
          WERK_SESSION_TOKEN: token,
        },
        input: JSON.stringify({
          hook_event_name: "SessionStart",
          session_id: "fixture-provider-session",
        }),
        encoding: "utf8",
        timeout: 6000,
      },
    );
    assert.equal(hookResult.status, 0);
    assert.ok(
      JSON.parse(
        hookResult.stdout,
      ).hookSpecificOutput.additionalContext.includes("get_task_context"),
    );
    const stale = await mcp.callTool({
      name: "save_session_memory",
      arguments: { summary: "Oude versie", expectedRevision: 0 },
    });
    assert.equal(stale.isError, true);
    const file = join(f.workspace, "voorstel.md");
    writeFileSync(file, "# Voorstel");
    const result = await mcp.callTool({
      name: "submit_result",
      arguments: { summary: "Voorstel klaar", files: [file] },
    });
    assert.ok(!result.isError);
    assert.equal((await f.client.call("snapshot")).tasks[0].status, "review");
    const unauthorized = new RpcClient(join(f.dataDir, "runner.sock"), {
      channel: "agent",
      sessionId: id,
      token,
    });
    t.after(() => unauthorized.close());
    for (const method of [
      "integrations.get",
      "integrations.configure",
      "integrations.unlock",
      "integrations.session",
    ])
      await assert.rejects(unauthorized.call(method, {}), /niet beschikbaar/);
    await assert.rejects(
      unauthorized.call("company.save", { value: {} }),
      /niet beschikbaar/,
    );
    const bad = new RpcClient(join(f.dataDir, "runner.sock"), {
      channel: "agent",
      sessionId: id,
      token: "incorrect",
    });
    t.after(() => bad.close());
    await assert.rejects(
      bad.call("tool", { name: "get_task_context" }),
      /sessietoegang/,
    );
    await f.client.call("session.stop", { id });
    await until(
      async () => !(await f.client.call("snapshot")).sessions[0].alive,
    );
    await assert.rejects(
      unauthorized.call("tool", { name: "get_task_context" }),
      /sessietoegang/,
    );
  },
);

test(
  "herstart van de service bewaart scherm en taak, en maakt de oude sessie onderbroken",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const id = await f.client.call("session.start", {
      companyId: f.companyId,
      taskId: f.taskId,
      provider: "shell",
    });
    await f.client.call("session.write", {
      id,
      data: "printf 'BEFORE_%s\\n' RESTART\r",
    });
    await until(async () =>
      (await f.client.call("session.screen", { id })).screen.includes(
        "BEFORE_RESTART",
      ),
    );
    const exited = once(f.child, "exit");
    f.child.kill("SIGTERM");
    await exited;
    await f.boot();
    const snapshot = await f.client.call("snapshot"),
      session = snapshot.sessions.find((x: any) => x.id === id);
    assert.equal(session.alive, false);
    assert.equal(session.state, "interrupted");
    assert.equal(snapshot.tasks[0].status, "in_progress");
    assert.ok(
      (await f.client.call("session.screen", { id })).screen.includes(
        "BEFORE_RESTART",
      ),
    );
  },
);

test(
  "terminals scheiden Benchdesk-regels van de opdracht bij beide providers en hervatten",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, true);
    const projectRules = "# Mijn eigen projectregels\n";
    for (const name of ["CLAUDE.md", "AGENTS.md", "SOUL.md"])
      writeFileSync(join(f.workspace, name), projectRules);
    const taskTitle = 'Offerte "review" — $HOME, `date` en $(whoami)';
    await f.client.call("task.save", {
      id: f.taskId,
      value: { companyId: f.companyId, projectId: f.projectId, title: taskTitle },
    });
    await f.client.call("goal.save", {
      value: { companyId: f.companyId, title: "Meer gesprekken", target: 12, unit: "gesprekken" },
    });
    for (const provider of ["claude", "codex"] as const) {
      let resumeFrom: string | undefined;
      let threadId: string | undefined;
      for (const mode of ["work", "work", "intake", "planning", "suggestions"] as const) {
        const resuming = mode === "work" && !!resumeFrom;
        const id = await f.client.call<string>("session.start", {
          companyId: f.companyId,
          taskId: mode === "work" ? f.taskId : null,
          provider,
          mode,
          ...(resuming ? { resumeFrom } : {}),
        });
        const session = await until(async () => {
          const s = (await f.client.call("snapshot")).sessions.find((s: any) => s.id === id);
          return s && !s.agentRunning && s;
        });
        const sessionDir = join(f.dataDir, "sessions", id);
        // Inspect what actually reached the provider, after launch.cjs and the shell.
        const args = readFileSync(join(sessionDir, "launch.json.arguments"), "utf8")
          .split("\0").slice(0, -1);
        assert.equal(args.at(-1), promptFor(mode, mode === "work" ? taskTitle : undefined));
        assert.doesNotMatch(args.at(-1)!, /save_session_memory|save_brain_changes|gmail_create_draft/);
        let instructions: string;
        if (provider === "claude") {
          const path = args[args.indexOf("--append-system-prompt-file") + 1];
          assert.equal(path, join(sessionDir, "benchdesk-instructions.md"));
          assert.equal(statSync(path).mode & 0o777, 0o600);
          instructions = readFileSync(path, "utf8");
          assert.equal(args.at(-2), "--");
          if (resuming) assert.equal(args[args.indexOf("--resume") + 1], threadId);
          threadId = session.providerSessionId;
        } else {
          const override = args.find((arg: string) => arg.startsWith("developer_instructions="))!;
          instructions = parse(override).developer_instructions as string;
          assert.ok(!args.some((arg: string) => arg.includes("model_instructions_file=")));
          if (resuming) assert.equal(args[args.indexOf("resume") + 1], threadId);
          else {
            threadId = "codex-fixture-thread";
            const agent = new RpcClient(join(f.dataDir, "runner.sock"), {
              channel: "agent", sessionId: id,
              token: readFileSync(join(sessionDir, "launch.json.test-token"), "utf8"),
            });
            try {
              await agent.call("hook", {
                id: randomUUID(), name: "SessionStart", at: Date.now(), providerSessionId: threadId,
              });
            } finally { agent.close(); }
          }
        }
        assert.equal(instructions, benchdeskInstructions(mode));
        assert.ok(!instructions.includes(taskTitle));
        await f.client.call("session.stop", { id });
        resumeFrom = id;
      }
    }
    for (const name of ["CLAUDE.md", "AGENTS.md", "SOUL.md"])
      assert.equal(readFileSync(join(f.workspace, name), "utf8"), projectRules);
  },
);

test(
  "Claude accepteert het instructiebestand en de korte prompt bij werk, intake, planning, voorstellen en hervatten",
  { timeout: 30000 },
  async (t) => {
    const claude = findProgram("claude");
    if (!claude) return t.skip("Lokale Claude CLI niet geïnstalleerd");
    const f = await fixture(t, true);
    const configDir = join(f.root, "isolated-claude");
    mkdirSync(configDir);
    // --bare with an empty config and no credentials stops at login, after
    // argument/config parsing, without accessing the user's account or tools.
    const env = {
      HOME: process.env.HOME!,
      PATH: process.env.PATH!,
      TMPDIR: tmpdir(),
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };
    await f.client.call("goal.save", {
      value: {
        companyId: f.companyId,
        title: "Meer gesprekken",
        target: 12,
        unit: "gesprekken",
      },
    });
    let resumeFrom: string | undefined;
    for (const mode of [
      "work",
      "work",
      "intake",
      "planning",
      "suggestions",
    ] as const) {
      const id = await f.client.call<string>("session.start", {
        companyId: f.companyId,
        taskId: mode === "work" ? f.taskId : null,
        provider: "claude",
        mode,
        ...(mode === "work" && resumeFrom ? { resumeFrom } : {}),
      });
      await until(async () => {
        const session = (await f.client.call("snapshot")).sessions.find(
          (s: any) => s.id === id,
        );
        return session && !session.agentRunning;
      });
      const args = readFileSync(
        join(f.dataDir, "sessions", id, "launch.json.arguments"),
        "utf8",
      )
        .split("\0")
        .slice(0, -1);
      const result = spawnSync(
        claude,
        [
          "--bare",
          "--print",
          "--no-session-persistence",
          "--setting-sources",
          "",
          ...args,
        ],
        { env, cwd: f.workspace, encoding: "utf8", timeout: 10000 },
      );
      const output = result.stdout + result.stderr;
      assert.ifError(result.error);
      assert.doesNotMatch(output, /Invalid MCP configuration|ENAMETOOLONG/);
      assert.match(
        output,
        mode === "work" && resumeFrom
          ? /No conversation found with session ID:/
          : /Not logged in/,
        `${mode}: ${output}`,
      );
      await f.client.call("session.stop", { id });
      resumeFrom = id;
    }
  },
);

test(
  "een vastgelopen agent wordt als fout gemeld en laat een bruikbare shell achter",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, true);
    const id = await f.client.call("session.start", {
      companyId: f.companyId,
      taskId: f.taskId,
      provider: "codex",
    });
    const session = await until(async () => {
      const s = (await f.client.call("snapshot")).sessions[0];
      return s && !s.agentRunning && s;
    });
    assert.equal(session.state, "error");
    assert.match(session.error, /7/);
    assert.equal(session.alive, true);
    await f.client.call("session.write", {
      id,
      data: "printf 'SHELL_%s\\n' STILL_WORKS\r",
    });
    await until(async () =>
      (await f.client.call("session.screen", { id })).screen.includes(
        "SHELL_STILL_WORKS",
      ),
    );
    await f.client.call("session.stop", { id });
  },
);

test(
  "accounts blijven gescheiden na shellinitialisatie en hervatten behoudt het oorspronkelijke account",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, true);
    const configA = join(f.root, "account-a"),
      configB = join(f.root, "account-b");
    writeFileSync(
      join(f.root, "shell", ".zshrc"),
      `export PATH='${join(f.root, "shell")}':$PATH\nexport CLAUDE_CONFIG_DIR='${join(f.root, "wrong-account")}'\nexport ANTHROPIC_API_KEY='fixture-only'\n`,
    );
    writeFileSync(
      join(f.root, "shell", "claude"),
      '#!/bin/sh\nprintf "%s\\n%s" "$CLAUDE_CONFIG_DIR" "${ANTHROPIC_API_KEY:+set}" > "$WERK_LAUNCH_FILE.account-check"\n',
      { mode: 0o755 },
    );
    const accountA = await f.client.call("account.save", {
      value: {
        provider: "claude",
        label: "Bedrijf A",
        configDir: configA,
        companyIds: [f.companyId],
      },
    });
    const accountB = await f.client.call("account.save", {
      value: { provider: "claude", label: "Bedrijf B", configDir: configB },
    });
    const start = async (params: any) => {
      const id = await f.client.call("session.start", {
        companyId: f.companyId,
        taskId: f.taskId,
        provider: "claude",
        ...params,
      });
      const file = join(f.dataDir, "sessions", id, "launch.json.account-check");
      await until(
        async () =>
          existsSync(file) &&
          !(await f.client.call("snapshot")).sessions.find(
            (s: any) => s.id === id,
          ).agentRunning,
      );
      return {
        id,
        environment: readFileSync(file, "utf8"),
        session: (await f.client.call("snapshot")).sessions.find(
          (s: any) => s.id === id,
        ),
      };
    };
    const original = await start({});
    assert.equal(original.session.accountId, accountA);
    assert.equal(original.environment, configPath(configA) + "\n");
    await f.client.call("account.save", {
      id: accountB,
      value: {
        provider: "claude",
        label: "Bedrijf B",
        configDir: configB,
        companyIds: [f.companyId],
      },
    });
    await assert.rejects(
      f.client.call("session.start", {
        companyId: f.companyId,
        taskId: f.taskId,
        provider: "claude",
        resumeFrom: original.id,
        accountId: accountB,
      }),
      /oorspronkelijke account/,
    );
    await f.client.call("session.stop", { id: original.id });
    await until(
      async () =>
        !(await f.client.call("snapshot")).sessions.find(
          (s: any) => s.id === original.id,
        ).alive,
    );
    await f.client.call("account.remove", { id: accountA });
    const resumed = await start({
      resumeFrom: original.id,
      accountId: accountA,
    });
    assert.equal(resumed.session.accountId, accountA);
    assert.equal(
      resumed.session.providerSessionId,
      original.session.providerSessionId,
    );
    assert.equal(resumed.environment, configPath(configA) + "\n");
  },
);

test("snapshots van meerdere MB, ook een paar tegelijk, verbreken de verbinding niet", async (t) => {
  const f = await fixture(t);
  // On 2 Nov 2026 a real profile's snapshot was 2.2 MB and the old 4 MB limits dropped the app as
  // soon as two were queued. Build one of ~4.7 MB: above the old limit for a single reply too.
  const description = "x".repeat(29_000);
  for (let i = 0; i < 160; i++)
    await f.client.call("task.save", {
      value: {
        companyId: f.companyId,
        projectId: f.projectId,
        title: `Taak ${i}`,
        description,
      },
    });
  const snap = await f.client.call("snapshot", {}, 30000);
  assert.ok(JSON.stringify(snap).length > 4_500_000);
  // A client that is busy for a moment while the window, its panes and a file check each ask for
  // a snapshot.
  const token = readFileSync(join(f.dataDir, "control-token"), "utf8");
  const socket = net.createConnection(join(f.dataDir, "runner.sock"));
  await once(socket, "connect");
  socket.pause();
  socket.write(
    [0, 1, 2, 3]
      .map(
        (i) =>
          JSON.stringify({ id: `s${i}`, channel: "app", token, method: "snapshot", params: {} }) +
          "\n",
      )
      .join(""),
  );
  await new Promise((r) => setTimeout(r, 1000));
  let replies = 0,
    rest = "",
    closed = false;
  socket.setEncoding("utf8");
  socket.on("data", (data: string) => {
    rest += data;
    let end;
    while ((end = rest.indexOf("\n")) >= 0) {
      assert.match(rest.slice(0, end), /^\{"id":"s\d","result":/);
      rest = rest.slice(end + 1);
      replies++;
    }
  });
  socket.on("close", () => {
    closed = true;
  });
  socket.resume();
  await until(() => replies === 4 || closed, 30000);
  assert.equal(closed, false);
  assert.equal(replies, 4);
  socket.destroy();
});
