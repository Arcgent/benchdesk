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

const root = await mkdtemp(join(tmpdir(), "benchdesk-language-ui-"));
const dataDir = join(root, "data"),
  workspace = join(root, "workspace"),
  dotdir = join(root, "shell");
for (const dir of [dataDir, workspace, dotdir]) await mkdir(dir);
const shots = resolve("docs/rustig/screenshots/smoke-language");
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
let app,
  page,
  runnerPid,
  passed = false;
const errors = [];
const call = (method, params = {}) =>
  page.evaluate(({ method, params }) => window.werk.call(method, params), {
    method,
    params,
  });
const snapshot = () => call("snapshot");
const until = async (fn) => {
  for (let n = 0; n < 200; n++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 75));
  }
  throw new Error("Condition timed out");
};
async function launch() {
  app = await electron.launch({
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
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (e) => errors.push(e.message));
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1440, 1000),
  );
}
async function shot(name) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: join(shots, name + ".png"),
    animations: "disabled",
  });
}
const side = () => page.locator('[data-test="sidebar"]');
try {
  await launch();
  await page
    .getByLabel("Bedrijfsnaam", { exact: true })
    .fill("Nederlands bedrijf");
  await page
    .getByRole("button", { name: "Bedrijf aanmaken", exact: true })
    .click();
  await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
  const companyId = (await snapshot()).companies[0].id;
  const departmentId = await call("department.save", {
    value: { companyId, name: "Sales" },
  });
  const goalId = await call("goal.save", {
    value: {
      companyId,
      title: "Meer gesprekken",
      current: 1250.5,
      target: 2500,
      unit: "gesprekken",
      primary: true,
    },
  });
  const projectId = await call("project.save", {
    value: {
      companyId,
      departmentId,
      goalId,
      name: "Profiel",
      description: "Eigen inhoud blijft in het Nederlands.",
    },
  });
  const taskId = await call("task.save", {
    value: {
      companyId,
      projectId,
      goalId,
      title: "Afgerond",
      description: "Een Nederlandse opdracht.",
      kind: "human",
      provider: "shell",
      recurrence: "daily",
      criteria: [
        {
          id: randomUUID(),
          text: "Controleer het resultaat",
          checked: false,
          comment: "",
          agentNote: "",
          evidence: null,
        },
      ],
    },
  });
  const sessionId = await call("session.start", {
    companyId,
    provider: "codex",
    mode: "work",
    accountId: "fixture-codex",
  });
  await until(
    async () =>
      (await snapshot()).sessions.find((s) => s.id === sessionId)?.alive,
  );
  runnerPid = Number(await readFile(join(dataDir, "runner.pid"), "utf8"));
  await side()
    .getByRole("button", { name: "Profiel en instellingen", exact: true })
    .click();
  await page.getByLabel("Taal", { exact: true }).selectOption("en");
  await page.getByLabel("Language", { exact: true }).waitFor();
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  await until(
    async () =>
      JSON.parse(await readFile(join(dataDir, "ui-language.json"), "utf8"))
        .language === "en",
  );
  assert.equal(
    await page.getByLabel("Language", { exact: true }).inputValue(),
    "en",
  );
  assert.ok(
    await side()
      .getByRole("button", { name: "Dashboard", exact: true })
      .isVisible(),
  );
  const menus = await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu().items.map((i) => ({
      label: i.label,
      children: i.submenu?.items.map((c) => c.label),
    })),
  );
  assert.ok(menus.some((m) => m.label === "Edit"));
  assert.ok(menus[0].children.includes("Quit Benchdesk"));
  await shot("01-profile-english");
  await side().getByRole("button", { name: "Dashboard", exact: true }).click();
  await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
  assert.ok((await page.locator('[data-test="main"]').innerText()).includes("All tasks. One overview."));
  await shot("02-today-english");
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Title", { exact: true }).fill("English draft");
  await page.getByLabel("Repeat", { exact: true }).selectOption("daily");
  await page.getByText("After completion, reopens tomorrow, including weekends. Your completions are saved.", { exact: true }).waitFor();
  await page.getByLabel("Repeat", { exact: true }).selectOption("weekly");
  await page.getByText("Every week on the weekday of the start date. Your completions are saved.", { exact: true }).waitFor();
  await shot("02b-task-planning-english");
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();

  await side().getByRole("button", { name: "Projects", exact: true }).click();
  await page.locator('[data-test="project-overview-row"]').first().waitFor();
  // Rustig tab rows are real tabs (role "tab", counters aria-hidden).
  await page.getByRole("tab", { name: "Completed", exact: true }).click();
  assert.equal(
    await page.locator('[data-test="project-overview-row"]').count(),
    0,
  );
  await page.locator('[data-test="pro-tabs"]').getByRole("tab", { name: "All", exact: true }).click();
  await page
    .locator("main")
    .getByRole("button", { name: "New project", exact: true })
    .waitFor();
  await shot("03-projects-english");
  await side()
    .getByRole("button", { name: "Your company", exact: true })
    .click();
  await page.getByRole("tab", { name: /^Profile$/ }).click();
  await page
    .getByText("The assistant reads this with every task", { exact: true })
    .waitFor();
  await side()
    .getByRole("button", { name: "Connections", exact: true })
    .click();
  // The page name is the H1 (the hero slogan is gone by design).
  await page
    .getByRole("heading", { name: "Connections", exact: true })
    .waitFor();
  await shot("04-connections-english");
  await side().getByRole("button", { name: "At work", exact: false }).click();
  // One menu (28-09): open conversations only, under the label "Conversations".
  await side().getByText("Conversations", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: /Free workspace/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await page
    .getByRole("heading", { name: "Notes for this conversation", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Write note", exact: true }).click();
  await page.getByText("Decisions", { exact: true }).waitFor();
  await shot("05-notes-english");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await side()
    .getByRole("button", { name: "Profile and settings", exact: true })
    .click();
  await page.getByLabel("Language", { exact: true }).selectOption("nl");
  await page.getByLabel("Taal", { exact: true }).waitFor();
  assert.equal(await page.locator("html").getAttribute("lang"), "nl");
  await page.getByLabel("Taal", { exact: true }).selectOption("en");
  await page.getByLabel("Language", { exact: true }).waitFor();
  await app.close();
  await launch();
  await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  const snap = await snapshot();
  assert.equal(snap.tasks.find((t) => t.id === taskId).title, "Afgerond");
  assert.equal(snap.projects.find((p) => p.id === projectId).name, "Profiel");
  assert.equal(snap.sessions.find((s) => s.id === sessionId).alive, true);
  assert.equal(
    Number(await readFile(join(dataDir, "runner.pid"), "utf8")),
    runnerPid,
  );
  await side()
    .getByRole("button", { name: "Profile and settings", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("Language", { exact: true }).inputValue(),
    "en",
  );
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await until(() =>
    page.evaluate(() => document.documentElement.dataset.theme === "dark"),
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Dark", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await shot("06-profile-dark");
  // The appearance chips follow the sidebar theme button as well (it saves the appearance; the chip follows the
  // refreshed preferences).
  await side().getByRole("button", { name: "Light theme", exact: true }).click();
  await until(() =>
    page.evaluate(() => document.documentElement.dataset.theme === "light"),
  );
  await until(
    async () =>
      (await page
        .getByRole("button", { name: "Light", exact: true })
        .getAttribute("aria-pressed")) === "true",
  );
  assert.deepEqual(errors, []);
  await call("session.stop", { id: sessionId });
  passed = true;
  console.log(
    "PASS: NL/EN switching, native menus, dates/numbers, all main navigation, project filters, company tabs, integration copy, session notes, dark theme, relaunch persistence, unchanged user content, same live session and runner, no renderer errors.",
  );
} catch (error) {
  if (page) {
    await shot("failure").catch(() => {});
    console.error(
      (
        await page
          .locator("body")
          .innerText()
          .catch(() => "")
      ).slice(-4500),
    );
  }
  throw error;
} finally {
  await app?.close().catch(() => {});
  if (!runnerPid)
    try {
      runnerPid = Number(await readFile(join(dataDir, "runner.pid"), "utf8"));
    } catch {}
  if (runnerPid)
    try {
      process.kill(runnerPid, "SIGTERM");
    } catch {}
  if (passed) await rm(root, { recursive: true, force: true });
  else console.error("Fixture retained:", root);
}
