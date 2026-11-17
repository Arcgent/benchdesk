import net from "node:net";
import { randomUUID } from "node:crypto";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
const root = await mkdtemp(join(tmpdir(), "benchdesk-recurring-ui-"));
const dataDir = join(root, "data"),
  workspace = join(root, "workspace");
await mkdir(dataDir);
await mkdir(workspace);
const shots = resolve("docs/rustig/screenshots/smoke-recurring");
await mkdir(shots, { recursive: true });
const app = await electron.launch({
  ...(process.env.WERK_TEST_EXECUTABLE
    ? { executablePath: process.env.WERK_TEST_EXECUTABLE, args: [] }
    : { args: [resolve(".")] }),
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "",
    WERK_DATA_DIR: dataDir,
    WERK_WORKSPACE: workspace,
    WERK_TEST_HIDDEN: "1",
  },
});
const page = await app.firstWindow();
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const call = (method, params = {}) =>
  page.evaluate(({ method, params }) => window.werk.call(method, params), {
    method,
    params,
  });
const snapshot = () => call("snapshot");
async function runnerCall(method, params = {}) {
  const token = await readFile(join(dataDir, "control-token"), "utf8");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(join(dataDir, "runner.sock"));
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("RPC timeout"));
    }, 10000);
    socket.setEncoding("utf8");
    socket.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    socket.on("connect", () =>
      socket.write(
        JSON.stringify({
          id: randomUUID(),
          channel: "app",
          token,
          method,
          params,
        }) + "\n",
      ),
    );
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\n")) {
        clearTimeout(timer);
        socket.end();
        const result = JSON.parse(data.split("\n")[0]);
        result.error ? reject(new Error(result.error)) : resolve(result.result);
      }
    });
  });
}

const day = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const now = new Date(),
  today = day(now),
  tomorrow = day(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1),
  ),
  yesterday = day(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1),
  );
async function until(fn) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const r = await fn();
    if (r) return r;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error("Recurring test timed out");
}
const shot = (name) => page.screenshot({ path: join(shots, name + ".png") });
let passed = false;
try {
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1440, 1000),
  );
  await page.getByLabel("Bedrijfsnaam", { exact: true }).fill("Planningstest");
  await page
    .getByLabel(/Wat doet je bedrijf/)
    .fill("Test van dagelijks, wekelijks en eenmalig plannen.");
  await page
    .getByRole("button", { name: "Bedrijf aanmaken", exact: true })
    .click();
  await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
  const companyId = (await snapshot()).companies[0].id;
  await call("project.save", { value: { companyId, name: "Acquisitie" } });
  await page.reload();
  await page.getByRole("button", { name: /Nieuwe taak/ }).click();
  await page.getByRole("button", { name: "Verder", exact: true }).click();
  await page.getByLabel("Titel", { exact: true }).fill("25 DM’s per dag");
  await page.getByLabel("Herhalen", { exact: true }).selectOption("daily");
  assert.equal(
    await page.getByLabel("Startdatum", { exact: true }).inputValue(),
    today,
  );
  await page.getByLabel("Criterium toevoegen").fill("25 berichten verstuurd");
  await page.getByLabel("Criterium toevoegen").press("Enter");
  await shot("01-dagelijks-instellen");
  await page.getByRole("button", { name: /Verder/ }).click();
  await page.getByRole("button", { name: "Opslaan", exact: true }).click();
  const daily = await until(async () =>
    (await snapshot()).tasks.find((t) => t.title === "25 DM’s per dag"),
  );
  await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
  const row = () =>
    page.locator(
      `[data-test="kanban-task"][data-task-id="${daily.id}"]`,
    );
  await row().getByRole("combobox").selectOption("done");
  await until(
    async () =>
      (await snapshot()).tasks.find((t) => t.id === daily.id).status === "done",
  );
  assert.equal(
    (await snapshot()).tasks.find((t) => t.id === daily.id).nextOccurrenceDate,
    tomorrow,
  );
  assert.equal((await call("task.history", { id: daily.id })).length, 1);
  await page.locator(`[data-status="done"] [data-task-id="${daily.id}"]`).waitFor();
  await row().waitFor();
  await shot("02-vandaag-afgerond");
  // Reproduce reopening after the app was closed at a day boundary using only
  // isolated persisted data, never the computer clock or the user's database.
  const backup = await runnerCall("backup.export");
  const task = backup.data.tasks.find((t) => t.id === daily.id);
  task.scheduledDate = yesterday;
  task.nextOccurrenceDate = today;
  task.criteria[0].checked = true;
  task.criteria[0].comment = "Gisteren uitgevoerd";
  const completion = backup.data.taskCompletions.find(
    (t) => t.taskId === daily.id,
  );
  completion.occurrenceDate = yesterday;
  completion.completedAt = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - 1,
    12,
  ).toISOString();
  await runnerCall("backup.restore", { backup });
  await page.reload();
  await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
  await row().waitFor();
  const reopened = (await snapshot()).tasks.find((t) => t.id === daily.id);
  assert.equal(reopened.status, "todo");
  assert.equal(reopened.criteria[0].checked, false);
  assert.equal(reopened.criteria[0].comment, "");
  assert.equal((await snapshot()).tasks.length, 1);
  await row().locator(".rz-dashboard__task-open").click();
  await page
    .locator('[data-test="task-info"]')
    .getByRole("button", { name: "Bewerken", exact: true })
    .click();
  await page.getByLabel("Herhalen", { exact: true }).selectOption("weekly");
  await page.getByRole("button", { name: "Opslaan", exact: true }).click();
  await until(
    async () =>
      (await snapshot()).tasks.find((t) => t.id === daily.id).recurrence ===
      "weekly",
  );
  await page.getByText("Uitvoeringsgeschiedenis", { exact: true }).click();
  await page.locator('[data-test="task-completion"]').waitFor();
  await shot("03-geschiedenis");
  await page
    .locator('[data-test="sidebar"]')
    .getByRole("button", { name: "Dashboard", exact: true })
    .click();
  await page.getByRole("button", { name: /Nieuwe taak/ }).click();
  await page.getByRole("button", { name: "Verder", exact: true }).click();
  await page
    .getByLabel("Titel", { exact: true })
    .fill("Voorstel op geplande datum");
  await page.getByLabel("Plandatum", { exact: true }).fill(tomorrow);
  await page.getByRole("button", { name: /Verder/ }).click();
  await page
    .getByRole("button", { name: "Taak inplannen", exact: true })
    .click();
  const planned = await until(async () =>
    (await snapshot()).tasks.find(
      (t) => t.title === "Voorstel op geplande datum",
    ),
  );
  assert.equal(
    (await snapshot()).sessions.length,
    0,
    "Scheduling must not start a model",
  );
  assert.equal(
    await page
      .locator(
        `[data-test="kanban-task"][data-task-id="${planned.id}"]`,
      )
      .count(),
    1,
  );
  await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
  await page
    .locator(`[data-test="kanban-task"][data-task-id="${planned.id}"]`)
    .waitFor();
  await shot("04-later");
  await page.getByRole("button", { name: "Donker thema", exact: true }).click();
  await shot("05-later-donker");
  await assert.rejects(
    call("session.start", {
      companyId,
      taskId: planned.id,
      provider: "codex",
      mode: "work",
    }),
    /gepland/,
  );
  assert.deepEqual(errors, []);
  passed = true;
  console.log(
    "PASS: daily wizard and kanban completion; next-day persisted reopening with cleared criteria; weekly edit; history; future tasks visible on the board; no agent autostart; light/dark; no renderer errors.",
  );
} catch (e) {
  await shot("failure").catch(() => {});
  console.error((await page.locator("body").innerText()).slice(-4000));
  throw e;
} finally {
  const pid = Number(
    await readFile(join(dataDir, "runner.pid"), "utf8").catch(() => 0),
  );
  await app.close();
  if (pid)
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  if (passed) {
    await new Promise((r) => setTimeout(r, 400));
    await rm(root, { recursive: true, force: true });
  } else console.error("Fixture retained:", root);
}
