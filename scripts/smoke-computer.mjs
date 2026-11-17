import electronPath from "electron";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { _electron as electron } from "playwright";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import net from "node:net";
import assert from "node:assert/strict";

const root = await mkdtemp(join(tmpdir(), "benchdesk-computer-ui-"));
const dataDir = join(root, "data"),
  workspace = join(root, "workspace"),
  dotdir = join(root, "shell");
for (const dir of [dataDir, workspace, dotdir]) await mkdir(dir);
const shots = resolve("docs/rustig/screenshots/smoke-computer");
await mkdir(shots, { recursive: true });
await writeFile(
  join(dotdir, ".zshrc"),
  `export PATH='${dotdir}':$PATH\nPS1='werk %~ % '\n`,
);
// Fixture CLIs exercise launch, account and auth plumbing without any model calls.
const fakeCLI = `#!/bin/sh
provider=$(basename "$0")
if [ "$provider" = claude ]; then config="$CLAUDE_CONFIG_DIR"; else config="$CODEX_HOME"; fi
if [ "$1" = app-server ]; then
  while IFS= read -r line; do
    case "$line" in
      *'"method":"initialize"'*) printf '{"id":1,"result":{}}\\n';;
      *'"method":"account/read"'*) printf '{"id":2,"result":{"account":{"type":"chatgpt"}}}\\n';;
      *'"method":"account/rateLimits/read"'*) printf '{"id":3,"result":{"rateLimits":{"primary":{"usedPercent":25,"windowDurationMins":300,"resetsAt":1990000000},"secondary":{"usedPercent":62,"windowDurationMins":10080,"resetsAt":1990500000},"planType":"pro"}}}\\n';;
    esac
  done
  exit 0
fi
if [ "$1" = --version ]; then printf '%s 1.0 (testfixture)\\n' "$provider"; exit 0; fi
if [ "$1" = auth ]; then shift; fi
if [ "$1" = status ] || { [ "$1" = login ] && [ "$2" = status ]; }; then
  if [ -f "$config/werk-test-login" ]; then printf '{"loggedIn":true,"email":"demo@example.test"}\\n'; exit 0; else printf '{"loggedIn":false}\\n'; exit 1; fi
fi
if [ "$1" = login ]; then mkdir -p "$config"; printf 'fixture' > "$config/werk-test-login"; printf 'Testlogin geslaagd. Geen externe account gebruikt.\\n'; exit 0; fi
if [ "$1" = logout ]; then rm -f "$config/werk-test-login"; exit 0; fi
printf '%s' "$WERK_SESSION_TOKEN" > "$WERK_LAUNCH_FILE.test-token"
printf '%s' "$config" > "$WERK_LAUNCH_FILE.account-dir"
printf '%s' "$@" > "$WERK_LAUNCH_FILE.arguments"
printf 'Testassistent voor de geautomatiseerde controle. Geen model aangeroepen.\\n'
exec /bin/cat
`;
for (const provider of ["claude", "codex"])
  await writeFile(join(dotdir, provider), fakeCLI, { mode: 0o755 });
// Account fixtures point only at temporary configuration, never personal credentials.
await writeFile(
  join(dataDir, "preferences.json"),
  JSON.stringify({
    profile: {},
    accounts: ["claude", "codex"].map((provider) => ({
      id: `fixture-${provider}`,
      provider,
      label: `Test ${provider}`,
      configDir: join(root, `fixture-${provider}`),
      companyIds: [],
      globalDefault: true,
      status: "unknown",
      email: "",
      checkedAt: "",
    })),
  }),
);
// The fake CLI records injected arguments; it never launches this fixture MCP.
const fixtureHome = join(root, "fixture-codex");
const plugin = join(
  fixtureHome,
  "plugins/cache/openai-bundled/unified-computer-use/26.1.0",
);
await mkdir(join(plugin, ".codex-plugin"), { recursive: true });
await writeFile(
  join(plugin, ".codex-plugin/plugin.json"),
  JSON.stringify({ name: "unified-computer-use" }),
);
await writeFile(join(plugin, "launch.mjs"), "// test fixture\n");
await writeFile(
  join(plugin, ".mcp.json"),
  JSON.stringify({
    mcpServers: {
      cua_repl: {
        command: process.execPath,
        args: [join(plugin, "launch.mjs")],
        env: {
          CUA_REPL_NODE_REPL_PATH: process.execPath,
          SKY_CUA_SERVICE_PATH: plugin,
          CODEX_HOME: fixtureHome,
        },
      },
    },
  }),
);
const app = await electron.launch({
  ...(process.env.WERK_TEST_EXECUTABLE
    ? { executablePath: process.env.WERK_TEST_EXECUTABLE, args: [] }
    : { args: [resolve(".")] }),
  cwd: resolve("."),
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "",
    WERK_DATA_DIR: dataDir,
    WERK_WORKSPACE: workspace,
    WERK_TEST_HIDDEN: "1",
    ZDOTDIR: dotdir,
    SHELL: "/bin/zsh",
  },
});
const errors = [];
let runnerPid,
  passed = false,
  page;
async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error("Testvoorwaarde niet bereikt");
}
const shot = async (name) => {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: join(shots, name + ".png"),
    animations: "disabled",
    scale: "css",
  });
};
const call = (method, params = {}) =>
  page.evaluate(({ method, params }) => window.werk.call(method, params), {
    method,
    params,
  });
const snapshot = () => call("snapshot");
const agent = async (sessionId, method, params) => {
  const token = await until(async () => {
    try {
      return await readFile(
        join(dataDir, "sessions", sessionId, "launch.json.test-token"),
        "utf8",
      );
    } catch {
      return false;
    }
  });
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(join(dataDir, "runner.sock"));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () =>
      socket.write(
        JSON.stringify({
          id: randomUUID(),
          channel: "agent",
          sessionId,
          token,
          method,
          params,
        }) + "\n",
      ),
    );
    socket.on("data", (data) => {
      buffer += data;
      if (buffer.includes("\n")) {
        const result = JSON.parse(buffer.split("\n")[0]);
        socket.end();
        if (result.error) reject(new Error(result.error));
        else resolve(result.result);
      }
    });
    socket.on("error", reject);
  });
};
let mcp;
try {
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (e) => errors.push(e.message));
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1440, 1000),
  );
  await page
    .getByLabel("Bedrijfsnaam", { exact: true })
    .fill("Computerbediening test");
  await page
    .getByLabel(/Wat doet je bedrijf/)
    .fill("Geïsoleerde test zonder echte schermbediening of modelaanroepen.");
  await page
    .getByRole("button", { name: "Bedrijf aanmaken", exact: true })
    .click();
  await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
  const companyId = (await snapshot()).companies[0].id;
  const sessionId = await call("session.start", {
    companyId,
    provider: "codex",
    mode: "work",
    accountId: "fixture-codex",
  });
  const token = await until(async () =>
    readFile(
      join(dataDir, "sessions", sessionId, "launch.json.test-token"),
      "utf8",
    ).catch(() => false),
  );
  await page
    .locator('[data-test="sidebar"]')
    .getByRole("button", { name: /Aan het werk/ })
    .click();
  await page
    .locator(
      `[data-test="pro-conversation-item"][data-session-id="${sessionId}"]`,
    )
    .click();
  await page.getByRole("button", { name: "Computer", exact: true }).click();
  await page
    .getByRole("heading", { name: "Computerbediening", exact: true })
    .waitFor();
  const status = await until(async () => {
    const value = await call("computer.get", { sessionId });
    return value.configured ? value : false;
  });
  assert.equal(status.available, true);
  assert.equal(status.version, "26.1.0");
  const argumentsText = await readFile(
    join(dataDir, "sessions", sessionId, "launch.json.arguments"),
    "utf8",
  );
  assert.match(argumentsText, /mcp_servers\.cua_repl=/);
  assert.ok(argumentsText.includes(fixtureHome));
  await page.getByRole("button", { name: "Controleren", exact: true }).click();
  await page.getByText("Koppeling ingesteld", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", {
        name: "Computer delen met dit gesprek",
        exact: true,
      })
      .count(),
    0,
  );
  await shot("01-computer-instellen");
  await assert.rejects(call("computer.enable", { sessionId }), /vervangen/);
  const appRoot = await app.evaluate(({ app }) => app.getAppPath());
  mcp = new Client({ name: "computer-integration-test", version: "1.0" });
  await mcp.connect(
    new StdioClientTransport({
      command: process.env.WERK_TEST_EXECUTABLE || electronPath,
      args: [join(appRoot, "dist/runtime/mcp.cjs")],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        WERK_SOCKET: join(dataDir, "runner.sock"),
        WERK_SESSION_ID: sessionId,
        WERK_SESSION_TOKEN: token,
      },
    }),
  );
  const names = (await mcp.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("get_task_context"));
  for (const name of [
    "computer_status",
    "computer_screenshot",
    "computer_action",
  ])
    assert.ok(!names.includes(name), "No legacy cursor tools");
  await rm(join(dataDir, "sessions", sessionId, "launch.json.cua.json"));
  await page.getByRole("button", { name: "Controleren", exact: true }).click();
  await page
    .getByText("Nieuw of hervat gesprek nodig", { exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Donker thema", exact: true }).click();
  await page.getByRole("button", { name: "Computer", exact: true }).click();
  await shot("02-computer-donker");
  assert.equal(
    await page
      .getByRole("heading", { name: "Computerbediening", exact: true })
      .isVisible(),
    true,
  );
  await call("session.stop", { id: sessionId });
  assert.equal((await call("computer.get", { sessionId })).configured, false);
  assert.deepEqual(errors, []);
  passed = true;
  console.log(
    "PASS: official cua_repl injection in an isolated account; light/dark Computer modal; old-session restart guidance; legacy physical cursor API disabled and absent from MCP; no model or desktop-input calls.",
  );
} catch (e) {
  if (page) {
    await shot("failure").catch(() => {});
    console.error(
      (
        await page
          .locator("body")
          .innerText()
          .catch(() => "")
      ).slice(-6000),
    );
  }
  throw e;
} finally {
  await mcp?.close().catch(() => {});
  try {
    runnerPid = Number(await readFile(join(dataDir, "runner.pid"), "utf8"));
  } catch {}
  await app.close();
  if (runnerPid) {
    try {
      process.kill(runnerPid, "SIGTERM");
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 450));
  if (passed) await rm(root, { recursive: true, force: true });
  else console.error("Isolated fixture retained for inspection:", root);
}
