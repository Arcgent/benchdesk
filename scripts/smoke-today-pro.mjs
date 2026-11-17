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

const root = await mkdtemp(join(tmpdir(), "benchdesk-today-pro-"));
const dataDir = join(root, "data"),
  workspace = join(root, "workspace"),
  dotdir = join(root, "shell");
for (const dir of [dataDir, workspace, dotdir]) await mkdir(dir);
const shots = resolve("docs/rustig/screenshots/smoke-today-pro");
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
    .fill("Wij helpen dienstverleners met hun acquisitie.");
  await page
    .getByRole("button", { name: "Bedrijf aanmaken", exact: true })
    .click();
  await page.getByRole("heading", { name: "Vandaag", exact: true }).waitFor();
  await shot("00-leeg");
  const companyId = (await snapshot()).companies[0].id;
  const goalId = await call("goal.save", {
    value: {
      companyId,
      title: "12 klantgesprekken per maand",
      unit: "gesprekken",
      current: 5,
      target: 12,
      primary: true,
      dueDate: "2026-09-30",
    },
  });
  await call("goal.save", {
    value: {
      companyId,
      title: "€10.000 omzet per maand",
      unit: "euro",
      current: 0,
      target: 10000,
      dueDate: "2026-12-31",
    },
  });
  const projectId = await call("project.save", {
    value: { companyId, name: "Cold email", goalId },
  });
  await call("checkin.save", {
    companyId,
    note: "Vijf gesprekken gevoerd. Eerst de campagne beoordelen, dan kan de volgende stap door.",
    values: [],
  });
  const day = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const now = new Date(),
    today = day(now),
    tomorrow = day(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1),
    );
  const save = (title, patch = {}) =>
    call("task.save", {
      value: {
        companyId,
        projectId,
        goalId,
        title,
        provider: "codex",
        ...patch,
      },
    });
  const review = await save("Campagne-opzet cold email beoordelen", {
    status: "review",
  });
  await save("Eerste 40 mails versturen", { dependencies: [review] });
  const ongoing = await save("ICP-lijst van 40 bedrijven");
  const session = await call("session.start", {
    companyId,
    taskId: ongoing,
    provider: "codex",
    mode: "work",
    accountId: "fixture-codex",
  });
  const daily = await save("25 outreach DM’s per dag", {
    recurrence: "daily",
    scheduledDate: today,
    provider: "shell",
    kind: "human",
  });
  await save("Offerte opvolgen", {
    dueDate: "2026-09-01",
    provider: "shell",
    kind: "human",
  });
  const future = await save("Volgende week de nieuwe campagne plannen", {
    scheduledDate: tomorrow,
  });
  await page.reload();
  await page.locator('[data-test="today-pro-session"]').waitFor();
  assert.equal(await page.locator('[data-test="today-pro-waiting"]').count(), 2);
  assert.equal(
    await page.locator(`[data-test="today-pro-planned"][data-task-id="${future}"]`).count(),
    0,
  );
  assert.ok(
    (await page.locator('[data-test="today-pro-context"]').innerText()).includes(
      "Vijf gesprekken gevoerd",
    ),
  );
  assert.equal(
    await page
      .getByRole("progressbar", { name: "12 klantgesprekken per maand" })
      .getAttribute("aria-valuenow"),
    "42",
  );
  await shot("01-vandaag-light");
  await page.getByRole("button", { name: "Donker thema", exact: true }).click();
  await until(() =>
    page.evaluate(() => document.documentElement.dataset.theme === "dark"),
  );
  await shot("02-vandaag-dark");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1100, 900),
  );
  await writeFile(
    join(shots, "layout-1100.json"),
    JSON.stringify(
      await page
        .locator('[data-test="today-pro-session"]')
        .evaluate((el) =>
          [...el.querySelectorAll("*")].map((n) => ({
            tag: n.tagName,
            cls: n.className,
            text: n.textContent,
            box: n.getBoundingClientRect().toJSON(),
            display: getComputedStyle(n).display,
            color: getComputedStyle(n).color,
            opacity: getComputedStyle(n).opacity,
          })),
        ),
      null,
      2,
    ),
  );
  await page.locator('[data-test="today-pro-session-title"]').waitFor();
  await shot("03-vandaag-1100");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  await page.getByRole("button", { name: "Licht thema", exact: true }).click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1440, 1000),
  );
  await page
    .getByRole("button", {
      name: "Rond af: 25 outreach DM’s per dag",
      exact: true,
    })
    .click();
  await until(
    async () =>
      (await snapshot()).tasks.find((t) => t.id === daily).status === "done",
  );
  await until(async () =>
    (
      await page
        .locator(`[data-test="today-pro-planned"][data-task-id="${daily}"]`)
        .innerText()
    ).includes("volgende"),
  );
  assert.equal(
    (await snapshot()).tasks.find((t) => t.id === daily).nextOccurrenceDate,
    tomorrow,
  );
  await shot("04-dagelijks-afgerond");
  // The docked composer adds a "Zelf" task straight to today: a new planned row, the draft clears, the page stays.
  const composer = page.getByRole("textbox", { name: "Geef een taak", exact: true });
  await composer.fill("Belscript nalopen");
  await page.getByRole("button", { name: /^Uitvoerder kiezen: / }).click();
  await page.getByRole("menuitemradio", { name: "Zelf", exact: true }).click();
  await composer.press("Enter");
  const quickTask = await until(async () =>
    (await snapshot()).tasks.find((t) => t.title === "Belscript nalopen"),
  );
  assert.equal(quickTask.kind, "human");
  assert.equal(quickTask.scheduledDate, today);
  const quickRow = page.locator(
    `[data-test="today-pro-planned"][data-task-id="${quickTask.id}"]`,
  );
  await quickRow.waitFor();
  assert.ok((await quickRow.innerText()).includes("vandaag"));
  await until(async () => (await composer.inputValue()) === "");
  await page.getByRole("heading", { name: "Vandaag", exact: true }).waitFor();
  await page.getByRole("button", { name: "Alle taken", exact: true }).click();
  await page.getByRole("button", { name: "Later", exact: true }).click();
  await page
    .locator(`[data-test="department-task-row"][data-task-id="${future}"]`)
    .waitFor();
  await page.getByLabel("Taken zoeken").fill("geen resultaat");
  await page
    .getByRole("heading", { name: "Geen taken gevonden", exact: true })
    .waitFor();
  await page.getByLabel("Taken zoeken").fill("");
  await shot("05-later");
  await page
    .locator('[data-test="page-topbar"]')
    .getByRole("button", { name: /^Vandaag\b/ })
    .click();
  await page
    .getByRole("button", { name: "Prioriteitenadvies", exact: true })
    .click();
  await page.locator('[data-test="modal"]').waitFor();
  assert.equal(
    (await snapshot()).sessions.length,
    1,
    "Advice opens launcher, no automatic model invocation",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Wekelijkse check-in/ }).click();
  await page.locator('[data-test="modal"]').waitFor();
  await page.keyboard.press("Escape");
  await page
    .locator(`[data-test="today-pro-session"][data-session-id="${session}"]`)
    .click();
  await page
    .getByRole("button", { name: "Gesprek sluiten", exact: true })
    .click();
  await until(
    async () =>
      !(await snapshot()).sessions.find((s) => s.id === session).alive,
  );
  await page
    .locator('[data-test="sidebar"]')
    .getByRole("button", { name: /^Dashboard\b/ })
    .click();
  assert.equal(await page.locator('[data-test="today-pro-session"]').count(), 0);
  assert.ok(
    (await snapshot()).sessions.some((s) => s.id === session),
    "History remains",
  );
  await page.getByRole("button", { name: "Beoordelen", exact: true }).click();
  await page
    .getByRole("button", { name: "Goedkeuren zoals het is", exact: true })
    .waitFor();
  assert.deepEqual(errors, []);
  passed = true;
  console.log(
    "PASS: Today Pro live goals/check-in; review and blocked attention; live sessions; stopped sessions removed and retained in history; recurring complete/next date; future filtering/search; advice and check-in actions; light/dark and 1100px; no renderer errors.",
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
