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

const root = await mkdtemp(join(tmpdir(), "werk-redesign-ui-"));
const dataDir = join(root, "data"),
  workspace = join(root, "workspace"),
  dotdir = join(root, "shell");
for (const dir of [dataDir, workspace, dotdir]) await mkdir(dir);
const shots = resolve("docs/rustig/screenshots/smoke-pro");
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
// The split guard (README: 560px next to / 360px below) only lets a wide enough ACTIVE pane take a neighbour.
// Placing a conversation from the list therefore starts by focusing the widest pane on the canvas.
const focusWidestPane = async () => {
  const panes = page.locator('[data-test="pro-canvas-pane"]');
  let widest,
    width = 0;
  for (let i = 0; i < (await panes.count()); i++) {
    const box = await panes.nth(i).boundingBox();
    if (box && box.width > width) [widest, width] = [panes.nth(i), box.width];
  }
  assert.ok(width >= 560, `a pane wide enough to split next to (${width}px)`);
  await widest.click({ position: { x: Math.min(width / 2, 200), y: 26 } });
  return widest;
};
// Pane tools that moved into the ⋯ menu of the focused pane ("Meer" → menu "Gespreksopties").
const paneMenuItem = async (pane, name) => {
  await pane.getByRole("button", { name: "Meer", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
};
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
try {
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (e) => errors.push(e.message));
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1440, 1000),
  );
  await page
    .getByLabel("Bedrijfsnaam", { exact: true })
    .fill("Noorderlicht Studio");
  await page
    .getByLabel(/Wat doet je bedrijf/)
    .fill(
      "Wij helpen dienstverleners hun merk en aanbod helder neer te zetten.",
    );
  await page
    .getByRole("button", { name: "Bedrijf aanmaken", exact: true })
    .click();
  await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
  assert.equal(
    (await call("app.info")).version,
    JSON.parse(await readFile(resolve("package.json"), "utf8")).version,
  );
  const companyId = (await snapshot()).companies[0].id;
  const sales = await call("department.save", {
    value: { companyId, name: "Sales" },
  });
  const operations = await call("department.save", {
    value: { companyId, name: "Operations" },
  });
  const goalId = await call("goal.save", {
    value: {
      companyId,
      title: "12 klantgesprekken per maand",
      current: 5,
      target: 12,
      unit: "gesprekken",
      primary: true,
      dueDate: "2026-09-30",
    },
  });
  const projectId = await call("project.save", {
    value: {
      companyId,
      name: "Cold email",
      departmentId: sales,
      goalId,
      description:
        "Een herhaalbare acquisitieroute die maandelijks passende klantgesprekken oplevert.",
      dueDate: "2026-09-30",
    },
  });
  const otherProject = await call("project.save", {
    value: { companyId, name: "Klantvoorstellen", departmentId: sales, goalId },
  });
  const onboarding = await call("project.save", {
    value: { companyId, name: "Onboarding", departmentId: operations },
  });
  const tasks = [];
  for (const [title, status, provider, pid] of [
    ["Doelgroep aanscherpen", "done", "claude", projectId],
    ["Campagne-opzet uitwerken", "todo", "codex", projectId],
    ["Verzenddomein controleren", "todo", "shell", projectId],
    ["Voorstel Noordlicht afronden", "todo", "claude", otherProject],
    ["Welkomstdocument schrijven", "todo", "codex", onboarding],
  ]) {
    tasks.push(
      await call("task.save", {
        value: {
          companyId,
          projectId: pid,
          title,
          status,
          provider,
          kind: provider === "shell" ? "human" : "ai",
          dueDate: "2026-09-30",
          description:
            "Maak een helder resultaat dat we samen kunnen beoordelen.",
          criteria: [
            {
              id: randomUUID(),
              text: "Resultaat is concreet en bruikbaar",
              checked: false,
              comment: "",
              agentNote: "",
              evidence: null,
            },
          ],
        },
      }),
    );
  }
  await page.reload();
  await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
  await shot("01-vandaag-light");
  await page.getByRole("button", { name: "Donker thema", exact: true }).click();
  await shot("02-vandaag-dark");
  await page.getByRole("button", { name: "Licht thema", exact: true }).click();
  await page
    .locator('[data-test="sidebar"]')
    .getByRole("button", { name: "Projecten", exact: true })
    .click();
  await shot("03-projecten");
  await page.getByRole("button", { name: "Kaarten", exact: true }).click();
  await page.locator('[data-test="project-overview-card"]').first().waitFor();
  await shot("03b-projectkaarten");
  // The chosen view is remembered under the Rustig key and restored after a reload.
  assert.equal(
    await page.evaluate(() => localStorage.getItem("projectenrustig.view")),
    "cards",
  );
  await page.reload();
  await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
  await page
    .locator('[data-test="sidebar"]')
    .getByRole("button", { name: "Projecten", exact: true })
    .click();
  await page.locator('[data-test="project-overview-card"]').first().waitFor();
  assert.equal(
    await page.locator('[data-test="project-overview-row"]').count(),
    0,
  );
  await page.getByRole("button", { name: "Lijst", exact: true }).click();
  await page.locator('[data-test="project-overview-row"]').first().waitFor();
  assert.equal(
    await page.evaluate(() => localStorage.getItem("projectenrustig.view")),
    "list",
  );
  await page
    .locator('[data-test="sidebar-projects"]')
    .getByRole("button", { name: /Cold email/ })
    .click();
  await shot("04-project");
  await page.getByRole("button", { name: "Donker thema", exact: true }).click();
  await until(() =>
    page.evaluate(() => document.documentElement.dataset.theme === "dark"),
  );
  await shot("04-project-dark");
  await page.getByRole("button", { name: "Licht thema", exact: true }).click();
  await page.getByRole("button", { name: "Bord", exact: true }).click();
  assert.equal(await page.locator('[data-test="pro-board-card"]').count(), 3);
  await shot("04b-projectbord");
  await page.getByLabel("Taken zoeken").fill("Verzenddomein");
  assert.equal(await page.locator('[data-test="pro-board-card"]').count(), 1);
  await page.getByLabel("Taken zoeken").fill("");
  await page.getByRole("button", { name: "Lijst", exact: true }).click();
  await page
    .locator(`[data-task-id="${tasks[2]}"] [data-test="pro-task-name"]`)
    .press("Alt+ArrowUp");
  await until(
    async () =>
      (await snapshot()).tasks
        .filter((t) => t.projectId === projectId)
        .sort((a, b) => a.rank - b.rank)[1].id === tasks[2],
  );
  // D7: the header pill focuses the docked composer; the full wizard opens through its expand button and
  // arrives with the draft already in "Titel".
  await page.getByRole("button", { name: "Nieuwe taak", exact: true }).click();
  const projectComposer = page.getByRole("textbox", {
    name: "Geef een taak in Cold email",
  });
  await until(() =>
    projectComposer.evaluate((el) => el === document.activeElement),
  );
  await projectComposer.fill("Nieuwe proefcampagne");
  await page
    .getByRole("button", { name: "Uitgebreide taak", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Nieuwe taak", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("Titel", { exact: true }).inputValue(),
    "Nieuwe proefcampagne",
  );
  await page
    .getByLabel("Opdracht", { exact: true })
    .fill("Schrijf drie passende berichten voor de doelgroep.");
  await page.getByLabel("Criterium toevoegen").fill("Drie heldere varianten");
  await page.getByLabel("Criterium toevoegen").press("Enter");
  await shot("05-nieuwe-taak");
  await page.getByRole("button", { name: /Verder/ }).click();
  await page
    .getByRole("progressbar", { name: "5 uur over", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("progressbar", { name: "5 uur over", exact: true })
      .getAttribute("aria-valuenow"),
    "75",
  );
  await shot("06-uitvoering");
  await page.getByRole("button", { name: "Opslaan", exact: true }).click();
  await until(async () =>
    (await snapshot()).tasks.some((t) => t.title === "Nieuwe proefcampagne"),
  );
  assert.equal(
    (await snapshot()).tasks.find((t) => t.title === "Nieuwe proefcampagne")
      .criteria.length,
    1,
  );
  // The wizard's "Opslaan" lands on Vandaag (as before). Back on the project: quick add through the composer,
  // a "Zelf" task lands in this project, the page stays put and the draft clears.
  await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
  await page
    .locator('[data-test="sidebar-projects"]')
    .getByRole("button", { name: /Cold email/ })
    .click();
  await page.locator('[data-test="project-page"]').waitFor();
  await until(async () => (await projectComposer.inputValue()) === "");
  await projectComposer.fill("Snelle taak via composer");
  await page.getByRole("button", { name: /^Uitvoerder kiezen: / }).click();
  await page.getByRole("menuitemradio", { name: "Zelf", exact: true }).click();
  await projectComposer.press("Enter");
  const quickTask = await until(async () =>
    (await snapshot()).tasks.find(
      (t) => t.title === "Snelle taak via composer",
    ),
  );
  assert.equal(quickTask.projectId, projectId);
  assert.equal(quickTask.kind, "human");
  await page
    .locator(`[data-test="project-page"] [data-task-id="${quickTask.id}"]`)
    .waitFor();
  await until(async () => (await projectComposer.inputValue()) === "");
  await page
    .locator('[data-test="sidebar"]')
    .getByRole("button", { name: "Je bedrijf", exact: true })
    .click();
  await shot("07-bedrijf");
  await page.getByRole("button", { name: "Donker thema", exact: true }).click();
  await until(() =>
    page.evaluate(() => document.documentElement.dataset.theme === "dark"),
  );
  await shot("07-bedrijf-dark");
  await page.getByRole("button", { name: "Licht thema", exact: true }).click();
  await call("checkin.save", {
    companyId,
    note: "Campagne gestart, twee nieuwe gesprekken gevoerd.",
    values: [{ goalId, current: 7 }],
  });
  await page.getByRole("tab", { name: "Check-ins", exact: true }).click();
  await page.locator('[data-test="pro-checkin"]').waitFor();
  assert.ok(
    (await page.locator('[data-test="pro-checkin"]').innerText()).includes("5"),
  );
  assert.ok(
    (await page.locator('[data-test="pro-checkin"]').innerText()).includes("7"),
  );
  await shot("07b-checkins");
  await page.getByRole("tab", { name: "Profiel", exact: true }).click();
  await shot("07c-bedrijfsprofiel");
  await page
    .locator('[data-test="sidebar"]')
    .getByRole("button", { name: "Accounts & gebruik", exact: true })
    .click();
  await page
    .getByRole("progressbar", { name: "5 uur over", exact: true })
    .waitFor();
  await shot("08-accounts");
  await page.getByRole("button", { name: "Donker thema", exact: true }).click();
  await until(() =>
    page.evaluate(() => document.documentElement.dataset.theme === "dark"),
  );
  await shot("08-accounts-dark");
  await page.getByRole("button", { name: "Licht thema", exact: true }).click();
  await page
    .getByRole("button", { name: "Account toevoegen", exact: true })
    .click();
  await shot("08b-account-toevoegen");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Codex", exact: true })
    .click();
  await page.getByLabel("Naam", { exact: true }).fill("Zakelijk testaccount");
  await page.getByText("Geavanceerde instellingen", { exact: true }).click();
  await page
    .getByLabel("Configuratiemap", { exact: true })
    .fill(join(root, "new-account"));
  await page
    .getByRole("button", { name: "Inloggen bij Codex", exact: true })
    .click();
  const addedAccount = await until(async () =>
    (await call("preferences.get")).accounts.find(
      (a) => a.label === "Zakelijk testaccount" && a.status === "logged_in",
    ),
  );
  assert.deepEqual(addedAccount.companyIds, [companyId]);
  await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 20000 });
  const otherCompany = await call("company.save", {
    value: {
      name: "Bakkerij Vermeer",
      workspacePath: workspace,
      product: "Alleen voor de bakkerij",
    },
  });
  await call("project.save", {
    value: { companyId: otherCompany, name: "Bakkerij algemeen" },
  });
  // Rustig shell: no app header and no company tabs. Companies are switched through the sidebar menu and with
  // ⌘⇧] / ⌘⇧[ (all companies); ⌘W outside "Aan het werk" closes nothing; ⌘⇧S collapses the sidebar.
  assert.equal(await page.locator('[data-test="app"] > header').count(), 0);
  const switcher = (name) =>
    page.getByRole("button", {
      name: `Ander bedrijf kiezen: ${name}`,
      exact: true,
    });
  const companyMenu = page.getByRole("menu", { name: "Bedrijven" });
  // A quick-task draft belongs to its company. Switching away hides it; switching back restores it.
  await page
    .locator('[data-test="sidebar"]')
    .getByRole("button", { name: "Dashboard", exact: true })
    .click();
  const quickDraft = () =>
    page.getByRole("textbox", { name: "Geef een taak", exact: true });
  await quickDraft().fill("Concept voor Noorderlicht");
  await switcher("Noorderlicht Studio").click();
  await companyMenu
    .getByRole("menuitemradio", { name: /Bakkerij Vermeer/ })
    .click();
  assert.equal(await quickDraft().inputValue(), "");
  await quickDraft().fill("Concept voor Bakkerij");
  await switcher("Bakkerij Vermeer").click();
  await companyMenu
    .getByRole("menuitemradio", { name: /Noorderlicht Studio/ })
    .click();
  assert.equal(await quickDraft().inputValue(), "Concept voor Noorderlicht");
  await quickDraft().fill("");
  await until(async () => {
    if (!(await companyMenu.isVisible()))
      await switcher("Noorderlicht Studio").click();
    if ((await companyMenu.getByRole("menuitemradio").count()) === 2)
      return true;
    await page.keyboard.press("Escape");
    return false;
  });
  assert.equal(
    await companyMenu
      .getByRole("menuitemradio", { name: /Noorderlicht Studio/ })
      .getAttribute("aria-checked"),
    "true",
  );
  await companyMenu
    .getByRole("menuitem", { name: "Bedrijf toevoegen", exact: true })
    .waitFor();
  await shot("08c-bedrijfswisselaar");
  await companyMenu
    .getByRole("menuitemradio", { name: /Bakkerij Vermeer/ })
    .click();
  await switcher("Bakkerij Vermeer").waitFor();
  await page.keyboard.press("Meta+Shift+BracketRight");
  await switcher("Noorderlicht Studio").waitFor();
  await page.keyboard.press("Meta+Shift+BracketLeft");
  await switcher("Bakkerij Vermeer").waitFor();
  await page.keyboard.press("Meta+w");
  assert.equal(await page.getByRole("dialog").count(), 0);
  await switcher("Bakkerij Vermeer").waitFor();
  await page.keyboard.press("Meta+Shift+BracketRight");
  await switcher("Noorderlicht Studio").waitFor();
  await page.getByRole("button", { name: "Meldingen", exact: true }).click();
  await page.getByRole("menu", { name: "Meldingen" }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("menu", { name: "Meldingen" }).waitFor({
    state: "hidden",
  });
  await page.keyboard.press("Meta+Shift+s");
  await page.locator('[data-test="sidebar"]').waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "Zijbalk tonen", exact: true })
    .click();
  await page.locator('[data-test="sidebar"]').waitFor({ state: "visible" });
  const sessions = [];
  for (let i = 0; i < 4; i++)
    sessions.push(
      await call("session.start", {
        companyId,
        taskId: i ? null : tasks[1],
        provider: i % 2 ? "claude" : "codex",
        mode: "work",
        accountId: i % 2 ? "fixture-claude" : "fixture-codex",
      }),
    );
  await page
    .locator('[data-test="sidebar"]')
    .getByRole("button", { name: /Aan het werk/ })
    .click();
  await page
    .locator('[data-test="pro-conversation-list"]')
    .getByRole("button")
    .filter({ hasText: "Campagne-opzet" })
    .click();
  await until(async () =>
    (await call("session.screen", { id: sessions[0] })).screen.includes(
      "Testassistent",
    ),
  );
  // The session header edits the linked task title inline; every view derives the conversation title from it.
  const editableTitle = page
    .locator(`[data-session-id="${sessions[0]}"]`)
    .locator('[data-test="session-title"]');
  await editableTitle.click();
  const titleInput = page.locator('[data-test="session-title-input"]');
  await titleInput.fill("Campagne-opzet aanscherpen");
  await titleInput.press("Enter");
  await until(
    async () =>
      (await snapshot()).tasks.find((task) => task.id === tasks[1]).title ===
      "Campagne-opzet aanscherpen",
  );
  await page
    .locator(`[data-test="pro-canvas-pane"][data-session-id="${sessions[0]}"]`)
    .locator('[data-test="session-title"]')
    .filter({ hasText: "Campagne-opzet aanscherpen" })
    .waitFor();
  await editableTitle.click();
  await titleInput.fill("Deze wijziging wordt geannuleerd");
  await titleInput.press("Escape");
  assert.equal(
    (await snapshot()).tasks.find((task) => task.id === tasks[1]).title,
    "Campagne-opzet aanscherpen",
  );
  // Files appear before submission and update without remounting the CLI.
  const fileSession = (await snapshot()).sessions.find(
    (s) => s.id === sessions[0],
  );
  const liveFile = join(fileSession.outputDir, "live-concept.md");
  const livePanel = page.locator('[data-test="pro-conversation-main"]');
  await livePanel.locator('[data-test="session-files-toggle"]').click();
  await livePanel.getByText("Nog geen bestanden", { exact: true }).waitFor();
  const terminalElement = await livePanel.locator(".xterm").elementHandle();
  await writeFile(
    liveFile,
    "# Live concept\n\nEen **leesbaar** document, vóór indienen.\n",
  );
  await livePanel
    .getByRole("heading", { name: "Live concept" })
    .waitFor({ timeout: 15000 });
  assert.equal(
    (await snapshot()).artifacts.some((a) => a.path === liveFile),
    false,
  );
  await livePanel.getByRole("button", { name: "Bron", exact: true }).click();
  await livePanel.locator('[data-test="source-file"]').waitFor();
  await livePanel
    .getByRole("button", { name: "Leesweergave", exact: true })
    .click();
  await writeFile(
    liveFile,
    "# Live concept\n\nDe nieuwste versie verschijnt automatisch.\n",
  );
  await livePanel
    .getByText("De nieuwste versie verschijnt automatisch.", { exact: true })
    .waitFor({ timeout: 15000 });
  const workspaceFile = join(workspace, "sessienotitie.markdown");
  await writeFile(
    workspaceFile,
    "# Notitie in de werkmap\n\nOok zonder resultaat indienen.\n",
  );
  await livePanel.locator('[data-test="session-files-picker"] summary').click();
  await livePanel
    .locator('[data-test="session-files-list"]')
    .getByRole("button", { name: /sessienotitie.markdown/ })
    .waitFor({ timeout: 15000 });
  // A new file must not steal the document currently being read.
  assert.equal(
    await livePanel.getByRole("heading", { name: "Live concept" }).count(),
    1,
  );
  await livePanel
    .locator('[data-test="session-files-list"]')
    .getByRole("button", { name: /sessienotitie.markdown/ })
    .click();
  await livePanel
    .getByRole("heading", { name: "Notitie in de werkmap" })
    .waitFor();
  await shot("13-session-files");
  await livePanel
    .getByRole("button", { name: "Bestanden sluiten", exact: true })
    .click();
  assert.equal(
    await terminalElement.evaluate((element) => element.isConnected),
    true,
  );
  assert.equal(
    (await snapshot()).sessions.find((s) => s.id === sessions[0]).alive,
    true,
  );
  await assert.rejects(
    page.evaluate(
      (path) => window.werk.preview(path),
      join(root, "outside.md"),
    ),
    /Koppel dit bestand/,
  );
  await agent(sessions[0], "hook", {
    id: randomUUID(),
    name: "SessionStart",
    at: Date.now(),
    providerSessionId: randomUUID(),
  });
  await agent(sessions[0], "hook", {
    id: randomUUID(),
    name: "Stop",
    at: Date.now(),
  });
  const memory = {
    summary:
      "Drie varianten voorbereid. De doelgroep is gekozen; verzending wacht op akkoord.",
    completed: ["Drie e-mailvarianten geschreven"],
    decisions: ["Starten met zakelijke dienstverleners"],
    blockers: [],
    nextSteps: ["Verzendmoment met de klant afstemmen"],
  };
  await agent(sessions[0], "tool", {
    name: "save_session_memory",
    arguments: { ...memory, expectedRevision: 0 },
  });
  await paneMenuItem(livePanel, "Activiteit");
  await page.getByLabel("Gespreksactiviteit").waitFor();
  await shot("09-gesprek");
  await page.getByRole("button", { name: "Notities", exact: true }).click();
  await page.getByText(memory.summary, { exact: true }).last().waitFor();
  await shot("09b-notities");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Bewerken", exact: true })
    .click();
  await page
    .getByLabel("Besluiten 1", { exact: true })
    .fill("Eerst 40 bedrijven handmatig controleren");
  await page
    .getByRole("button", { name: "Notities opslaan", exact: true })
    .click();
  await until(
    async () =>
      (await snapshot()).sessions.find((s) => s.id === sessions[0]).memory
        ?.revision === 2,
  );
  await page.getByRole("button", { name: "Als taak", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Nieuwe taak", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("Titel", { exact: true }).inputValue(),
    memory.nextSteps[0],
  );
  await page
    .getByRole("button", { name: "Verder: uitvoering", exact: true })
    .click();
  await page.getByRole("button", { name: /Zelf doen/ }).click();
  await page
    .getByRole("button", { name: "Op Vandaag zetten", exact: true })
    .click();
  await until(async () =>
    (await snapshot()).tasks.some(
      (t) => t.title === memory.nextSteps[0] && t.kind === "human",
    ),
  );
  await page
    .locator('[data-test="sidebar"]')
    .getByRole("button", { name: /Aan het werk/ })
    .click();
  // One model (D8): the canvas is the only mode. "Ernaast" / "Eronder" place the next open conversation next to /
  // below the focused pane: 1180 → 590 → 295px wide.
  await page.getByRole("button", { name: "Ernaast", exact: true }).click();
  await page.getByRole("button", { name: "Eronder", exact: true }).click();
  const companyFilter = page.getByRole("group", { name: "Bedrijfsfilter" });
  await companyFilter
    .getByRole("button", { name: "Bakkerij Vermeer", exact: true })
    .click();
  await page.keyboard.press("Meta+d");
  await page
    .locator('[data-test="launcher-task-title"]')
    .fill("Nieuwe terminal controleren");
  await page.getByRole("button", { name: "Starten met Codex" }).click();
  await until(async () =>
    (await snapshot()).tasks.some(
      (task) => task.title === "Nieuwe terminal controleren",
    ),
  );
  const launchedSnapshot = await snapshot();
  const launchedTask = launchedSnapshot.tasks.find(
    (task) => task.title === "Nieuwe terminal controleren",
  );
  const launchedSession = launchedSnapshot.sessions.find(
    (session) => session.taskId === launchedTask.id,
  );
  assert.equal(launchedTask.companyId, otherCompany);
  assert.equal(launchedSession.companyId, otherCompany);
  await until(
    async () =>
      (await page.locator('[data-test="pro-canvas-pane"]').count()) === 4,
  );
  // README 560/360: the focused pane is 295px wide now, so another split is refused with a toast and nothing
  // changes (no launcher either).
  await page.getByRole("button", { name: "Ernaast", exact: true }).click();
  await page.locator('[data-test="canvas-refused"]').waitFor();
  assert.equal(await page.locator('[data-test="pro-canvas-pane"]').count(), 4);
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page
    .locator('[data-test="canvas-refused"]')
    .waitFor({ state: "hidden", timeout: 4000 });
  // Rustig shell: the company filter of the canvas lives in the top bar of "Aan het werk" (no app header).
  assert.equal(
    await page
      .locator('[data-test="pro-canvas-pane"][style*="opacity: 0.35"]')
      .count(),
    3,
  );
  await companyFilter
    .getByRole("button", { name: "Alle", exact: true })
    .click();
  assert.equal(
    await page
      .locator('[data-test="pro-canvas-pane"][style*="opacity: 0.35"]')
      .count(),
    0,
  );
  // The sidebar also collapses on the canvas; "Zijbalk tonen" then sits in the top bar, right of the macOS
  // traffic lights (no top bar of the app to hold them any more).
  await page
    .getByRole("button", { name: "Zijbalk verbergen", exact: true })
    .click();
  await page.locator('[data-test="sidebar"]').waitFor({ state: "hidden" });
  const showSidebar = page.getByRole("button", {
    name: "Zijbalk tonen",
    exact: true,
  });
  if (process.platform === "darwin")
    assert.ok((await showSidebar.boundingBox()).x >= 84);
  assert.equal(await page.locator('[data-test="pro-canvas-pane"]').count(), 4);
  await showSidebar.click();
  await page.locator('[data-test="sidebar"]').waitFor({ state: "visible" });
  await shot("10-canvas");
  await page.getByRole("button", { name: "Donker thema", exact: true }).click();
  await until(() =>
    page.evaluate(() => document.documentElement.dataset.theme === "dark"),
  );
  await shot("10-canvas-dark");
  await page.getByRole("button", { name: "Licht thema", exact: true }).click();
  assert.equal(await page.locator('[data-test="pro-canvas-pane"]').count(), 4);
  await page.reload();
  await page
    .locator('[data-test="sidebar"]')
    .getByRole("button", { name: /Aan het werk/ })
    .click();
  await page.locator('[data-test="pro-canvas-pane"]').first().waitFor();
  assert.equal(await page.locator('[data-test="pro-canvas-pane"]').count(), 4);
  // Closing removes a pane only; terminal processes stay alive.
  const beforeClose = (await snapshot()).sessions.filter((s) => s.alive).length;
  const closedSessionId = await page
    .locator('[data-test="pro-canvas-pane"]')
    .last()
    .getAttribute("data-session-id");
  await page
    .getByRole("button", { name: "Paneel sluiten", exact: true })
    .last()
    .click();
  await until(
    async () =>
      (await page.locator('[data-test="pro-canvas-pane"]').count()) === 3,
  );
  await until(
    async () =>
      (await snapshot()).sessions.filter((s) => s.alive).length ===
      beforeClose - 1,
  );
  assert.equal(
    await page
      .locator(
        `[data-test="pro-conversation-item"][data-session-id="${closedSessionId}"]`,
      )
      .count(),
    0,
  );
  const separator = page
    .getByRole("separator", { name: "Paneelverdeling" })
    .last();
  const beforeLayout = await page.evaluate(() =>
    localStorage.getItem("werk-workspace-v2"),
  );
  await separator.press("ArrowLeft");
  await until(
    async () =>
      (await page.evaluate(() => localStorage.getItem("werk-workspace-v2"))) !==
      beforeLayout,
  );
  await page
    .getByRole("button", { name: "Vergroten", exact: true })
    .first()
    .click();
  assert.equal(await page.locator('[data-test="pro-canvas-pane"]').count(), 1);
  await page
    .getByRole("button", { name: "Terug naar indeling", exact: true })
    .click();
  assert.equal(await page.locator('[data-test="pro-canvas-pane"]').count(), 3);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1100, 800),
  );
  await shot("10b-canvas-1100");
  const filePane = page.locator(
    `[data-test="pro-canvas-pane"][data-session-id="${sessions[0]}"]`,
  );
  await filePane.locator('[data-test="session-files-toggle"]').click();
  await filePane.locator('[data-test="session-files-panel"]').waitFor();
  await filePane.locator('[data-test="session-files-picker"] summary').click();
  await filePane
    .locator('[data-test="session-files-list"]')
    .getByRole("button", { name: /live-concept.md/ })
    .click();
  await filePane.getByRole("heading", { name: "Live concept" }).waitFor();
  const panelBox = await filePane
    .locator('[data-test="session-files-panel"]')
    .boundingBox();
  const paneBox = await filePane.boundingBox();
  assert.ok(
    panelBox.x >= paneBox.x &&
      panelBox.x + panelBox.width <= paneBox.x + paneBox.width + 1,
  );
  await shot("13b-session-files-canvas");
  await page.getByRole("button", { name: "Donker thema", exact: true }).click();
  await shot("13c-session-files-dark");
  await page.getByRole("button", { name: "Licht thema", exact: true }).click();
  await filePane
    .getByRole("button", { name: "Bestanden sluiten", exact: true })
    .click();

  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1440, 1000),
  );
  const file = join(workspace, "campagne-opzet.md");
  await writeFile(
    file,
    "# Campagne-opzet\n\n## Drie varianten\n- Een concreet proces verbeteren\n- Een herkenbaar knelpunt\n- De volgende groeistap\n\n**Advies:** start met veertig bedrijven.\n",
  );
  const review = (await snapshot()).tasks.find((t) => t.id === tasks[1]);
  await agent(sessions[0], "tool", {
    name: "submit_result",
    arguments: {
      summary: "Drie e-mailvarianten opgeleverd voor de gekozen doelgroep.",
      files: [file],
      criteria: review.criteria.map((c) => ({
        id: c.id,
        note: "Drie concrete varianten klaar.",
        evidence: { path: file, line: 4 },
      })),
    },
  });
  await page.keyboard.press("Meta+Shift+BracketLeft");
  await page
    .locator('[data-test="sidebar"]')
    .getByRole("button", { name: "Dashboard", exact: true })
    .click();
  await page.getByRole("button", { name: "Beoordelen", exact: true }).click();
  await page.locator('[data-test="markdown-preview"]').waitFor();
  await shot("11-beoordelen");
  await page.getByRole("button", { name: "Donker thema", exact: true }).click();
  await until(() =>
    page.evaluate(() => document.documentElement.dataset.theme === "dark"),
  );
  await shot("11-beoordelen-dark");
  await page.getByRole("button", { name: "Licht thema", exact: true }).click();
  // The highlight follows a click in the text; the evidence chip ("r. 4", named file:line) brings it back.
  await page.locator('[data-test="markdown-preview"] [data-line="1"]').click();
  await page.locator('[data-line="1"][data-test="highlighted"]').waitFor();
  assert.equal(
    await page.locator('[data-line="4"][data-test="highlighted"]').count(),
    0,
  );
  await page
    .getByRole("button", { name: "campagne-opzet.md:4", exact: true })
    .click();
  await page.locator('[data-line="4"][data-test="highlighted"]').waitFor();
  assert.equal(
    await page.locator('[data-line="1"][data-test="highlighted"]').count(),
    0,
  );
  await shot("11b-bronregel");
  await page
    .getByLabel("Akkoord: Resultaat is concreet en bruikbaar", { exact: true })
    .check();
  await page
    .getByRole("button", { name: "Goedkeuren en afronden", exact: true })
    .click();
  await until(
    async () =>
      (await snapshot()).tasks.find((t) => t.id === review.id).status ===
      "done",
  );
  // Start a new task through the wizard with deliberately restricted start context.
  await page
    .locator('[data-test="sidebar"]')
    .getByRole("button", { name: "Dashboard", exact: true })
    .click();
  await page.getByRole("button", { name: "Nieuwe taak", exact: true }).click();
  await page.getByRole("button", { name: "Verder", exact: true }).click();
  await page
    .getByLabel("Titel", { exact: true })
    .fill("Beperkte startcontext testen");
  await page
    .getByLabel("Opdracht", { exact: true })
    .fill("Een korte opdracht.");
  await page
    .getByRole("button", { name: "Verder: uitvoering", exact: true })
    .click();
  // The composer remembers the last executor ("Zelf" from the quick add above); this task is for Codex.
  await page
    .getByRole("dialog", { name: "Nieuwe taak", exact: true })
    .locator('[data-test="task-wizard-executor"][data-provider="codex"]')
    .click();
  await page
    .getByRole("button", { name: "Bedrijfscontext", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Starten met Codex", exact: true })
    .click();
  const newSession = await until(async () =>
    (await snapshot()).sessions.find(
      (s) => s.contextOptions?.business === false,
    ),
  );
  const context = await agent(newSession.id, "tool", {
    name: "get_task_context",
    arguments: {},
  });
  assert.equal(context.company.product, "");
  assert.deepEqual(context.goals, []);
  assert.equal(context.task.title, "Beperkte startcontext testen");
  // The minimal dashboard is only a global task board; loading it must not start AI work.
  await page.locator('[data-test="sidebar"]').getByRole("button", { name: "Dashboard", exact: true }).click();
  const beforeDashboard = (await snapshot()).sessions.length;
  await page.reload();
  await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
  assert.equal((await snapshot()).sessions.length, beforeDashboard);
  await page.locator('[data-test="dashboard"]').waitFor();
  await shot("12-dashboard");
  // Closing stops the PTY and moves the retained conversation to history.
  const overviewSession = await call("session.start", {
    companyId,
    taskId: null,
    provider: "codex",
    mode: "work",
    accountId: "fixture-codex",
  });
  await page
    .locator('[data-test="sidebar"]')
    .getByRole("button", { name: /Aan het werk/ })
    .click();
  const overviewRow = () =>
    page.locator(
      `[data-test="pro-conversation-item"][data-session-id="${overviewSession}"]`,
    );
  const overviewPane = page.locator(
    `[data-test="pro-canvas-pane"][data-session-id="${overviewSession}"]`,
  );
  // D1: a list row places the conversation next to the focused pane (split guard applies).
  await focusWidestPane();
  await overviewRow().click();
  await overviewPane.waitFor();
  assert.equal(await overviewRow().getAttribute("aria-pressed"), "true");
  await overviewPane
    .getByRole("button", { name: "Paneel sluiten", exact: true })
    .click();
  await until(
    async () =>
      !(await snapshot()).sessions.find((s) => s.id === overviewSession).alive,
  );
  await until(async () => (await overviewRow().count()) === 0);
  await until(async () => (await overviewPane.count()) === 0);
  await page.reload();
  await page
    .locator('[data-test="sidebar"]')
    .getByRole("button", { name: /Aan het werk/ })
    .click();
  assert.equal(await overviewRow().count(), 0);
  // Eén menu (28-09): the menu shows open conversations only; a stopped one is resumed through its task.
  const canvasStop = await call("session.start", {
    companyId,
    taskId: null,
    provider: "codex",
    mode: "work",
    accountId: "fixture-codex",
  });
  await focusWidestPane();
  await page
    .locator(
      `[data-test="pro-conversation-item"][data-session-id="${canvasStop}"]`,
    )
    .click();
  const stoppedPane = page.locator(
    `[data-test="pro-canvas-pane"][data-session-id="${canvasStop}"]`,
  );
  await stoppedPane
    .getByRole("button", { name: "Vergroten", exact: true })
    .click();
  assert.equal(await page.locator('[data-test="pro-canvas-pane"]').count(), 1);
  // "Stoppen" lives in the ⋯ menu of the pane (the ■ glyph is an icon now).
  await paneMenuItem(stoppedPane, "Stoppen");
  await until(async () => (await stoppedPane.count()) === 0);
  assert.equal(
    await page
      .locator(
        `[data-test="pro-conversation-item"][data-session-id="${canvasStop}"]`,
      )
      .count(),
    0,
  );
  await page.reload();
  await page
    .locator('[data-test="sidebar"]')
    .getByRole("button", { name: /Aan het werk/ })
    .click();
  assert.equal(await stoppedPane.count(), 0);
  assert.equal(
    await page
      .locator(
        `[data-test="pro-conversation-item"][data-session-id="${canvasStop}"]`,
      )
      .count(),
    0,
  );
  await shot("14b-open-sessions");
  console.log(
    "PASS: Closing stops the PTY and persists across reload; history retains stopped sessions; stopping removes conversation, canvas and maximized panes; historical output stays readable.",
  );
  assert.deepEqual(errors, []);
  passed = true;
  console.log(
    "PASS: Today per department; persistent manual AI suggestions; project list/board/cards/search/reordering; two-step task save/start and real context selection; account login and remaining quota; check-in measurements; editable notes to task; four-pane cross-company canvas, resize/maximize/reload without stopping processes; explicit close stops its session; live unsubmitted files, Markdown/source preview and automatic updates without remounting terminals; compact Canvas file panel; Markdown review and source evidence; light/dark themes; 1100px layout; no renderer errors. Isolated fixture CLIs only.",
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
