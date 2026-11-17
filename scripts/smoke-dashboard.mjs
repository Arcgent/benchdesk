import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { checkTerminalFiles } from "./terminal-file-checks.mjs";

const root = await mkdtemp(join(tmpdir(), "benchdesk-dashboard-"));
const dataDir = join(root, "data"),
  workspace = join(root, "workspace"),
  shellDir = join(root, "shell");
for (const path of [dataDir, workspace, shellDir]) await mkdir(path);
await writeFile(join(shellDir, ".zshrc"), "# Isolated UI test\n");
const shots = resolve("docs/rustig/screenshots/smoke-dashboard");
await mkdir(shots, { recursive: true });
const app = await electron.launch({
  args: [resolve(".")],
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "",
    WERK_DATA_DIR: dataDir,
    WERK_WORKSPACE: workspace,
    WERK_TEST_HIDDEN: "1",
    ZDOTDIR: shellDir,
    SHELL: "/bin/zsh",
  },
});
let page,
  runnerPid,
  passed = false;
const errors = [];
const call = (method, params = {}) =>
  page.evaluate(({ method, params }) => window.werk.call(method, params), {
    method,
    params,
  });
const cards = () => page.locator('[data-test="kanban-task"]');
const card = (id) => page.locator(`[data-task-id="${id}"]`);
async function count(expected) {
  await page.waitForFunction(
    (expected) =>
      document.querySelectorAll('[data-test="kanban-task"]').length ===
      expected,
    expected,
  );
}
async function state(id, status) {
  await page
    .locator(`[data-status="${status}"] [data-task-id="${id}"]`)
    .waitFor();
  assert.equal(
    (await call("snapshot")).tasks.find((t) => t.id === id).status,
    status,
  );
}
try {
  page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByLabel("Bedrijfsnaam", { exact: true }).fill("Bakkerij Vermeer");
  await page
    .getByRole("button", { name: "Bedrijf aanmaken", exact: true })
    .click();
  await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
  runnerPid = Number(await readFile(join(dataDir, "runner.pid"), "utf8"));
  assert.equal(await cards().count(), 0);
  await page
    .getByText("Nog geen taken. Voeg je eerste taak toe.", { exact: true })
    .waitFor();
  const companyId = (await call("snapshot")).companies[0].id;
  const otherId = await call("company.save", {
    value: { name: "Noorderlicht Studio", workspacePath: workspace },
  });
  const projectId = await call("project.save", {
    value: { companyId, name: "Acquisitie" },
  });
  const otherProject = await call("project.save", {
    value: { companyId: otherId, name: "Content" },
  });
  const save = (title, patch = {}) =>
    call("task.save", {
      value: {
        companyId,
        projectId,
        title,
        kind: "human",
        provider: "shell",
        ...patch,
      },
    });
  const todo = await save("Investeerders opvolgen", { dueDate: "2026-01-01" });
  await save("Weekrapport maken", {
    status: "in_progress",
    provider: "codex",
    kind: "ai",
  });
  const blocked = await save("Offerte versturen", {
    status: "blocked",
    dependencies: [todo],
  });
  const review = await save("Campagne beoordelen", {
    status: "review",
    provider: "claude",
    kind: "ai",
  });
  await save("Briefing afronden", { status: "done" });
  const otherTask = await save("Reel publiceren", {
    companyId: otherId,
    projectId: otherProject,
  });
  const future = await save("Volgende campagne plannen", {
    scheduledDate: "2099-01-01",
  });
  await page.reload();
  await count(7);
  assert.equal(await page.locator(".rz-dashboard__column").count(), 5);
  await page
    .getByLabel("Filter op bedrijf", { exact: true })
    .selectOption(otherId);
  await count(1);
  assert.match(await cards().innerText(), /Noorderlicht Studio/);
  await page
    .getByLabel("Filter op project", { exact: true })
    .selectOption(otherProject);
  await page
    .getByLabel("Filter op bedrijf", { exact: true })
    .selectOption(companyId);
  assert.equal(
    await page.getByLabel("Filter op project", { exact: true }).inputValue(),
    "",
  );
  await count(6);
  await page.getByLabel("Filter op uitvoerder").selectOption("codex");
  await count(1);
  await page
    .getByRole("button", { name: "Filters wissen", exact: true })
    .click();
  await count(7);
  await page.getByLabel("Taken zoeken").fill("  noorderlicht  ");
  await count(1);
  await page.getByLabel("Taken zoeken").fill("onvindbare-taak");
  await count(0);
  await page
    .getByText("Geen taken gevonden. Pas je filters aan.", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Filters wissen", exact: true })
    .click();
  await page
    .getByLabel("Filter op project", { exact: true })
    .selectOption(otherProject);
  await count(1);
  await page
    .getByRole("button", { name: "Filters wissen", exact: true })
    .click();
  await count(7);
  assert.equal(
    await card(blocked).locator('option[value="done"]').isDisabled(),
    true,
  );
  assert.equal(
    await card(future).locator('option[value="done"]').isDisabled(),
    true,
  );
  await card(todo).locator("select").selectOption("in_progress");
  await state(todo, "in_progress");
  await card(todo).dragTo(
    page.locator('[data-status="todo"] .rz-dashboard__column-head'),
  );
  await state(todo, "todo");
  await card(otherTask).locator("select").selectOption("done");
  await state(otherTask, "done");
  await card(otherTask).locator("select").selectOption("todo");
  await state(otherTask, "todo");
  await app
    .browserWindow(page)
    .then((window) => window.evaluate((w) => w.setSize(1500, 950)));
  await page.screenshot({
    path: join(shots, "desktop.png"),
    animations: "disabled",
  });
  await app
    .browserWindow(page)
    .then((window) => window.evaluate((w) => w.setSize(860, 850)));
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  await page.screenshot({
    path: join(shots, "compact.png"),
    animations: "disabled",
  });
  await page
    .getByLabel("Filter op bedrijf", { exact: true })
    .selectOption(otherId);
  await page.getByRole("button", { name: "Nieuwe taak", exact: true }).click();
  assert.equal(
    await page.getByLabel("Bedrijf voor nieuwe taak").inputValue(),
    otherId,
  );
  assert.equal(
    await page.getByLabel("Project voor nieuwe taak").inputValue(),
    otherProject,
  );
  await page.getByRole("button", { name: "Verder", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  assert.equal(
    await page
      .getByRole("dialog")
      .locator(`option[value="${projectId}"]`)
      .count(),
    0,
  );
  await page.keyboard.press("Escape");
  await card(otherTask).locator(".rz-dashboard__task-open").click();
  await page.locator('[data-test="dashboard"]').waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await count(7);
  await card(review).locator("select").selectOption("done");
  await page.locator('[data-test="dashboard"]').waitFor({ state: "detached" });
  assert.equal(
    (await call("snapshot")).tasks.find((t) => t.id === review).status,
    "review",
  );
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await page
    .getByRole("button", { name: "Terminal openen", exact: true })
    .click();
  await page.locator('[data-test="terminal-host"] .xterm').first().waitFor();
  const terminal = (await call("snapshot")).sessions.find(
    (s) => s.provider === "shell" && !s.taskId,
  );
  assert.ok(terminal, "Free terminal created without a task");
  assert.equal(terminal.accountId, null);
  assert.equal((await call("snapshot")).tasks.length, 7);
  assert.equal(await page.locator('[data-test="launcher"]').count(), 0);
  await call("session.write", {
    id: terminal.id,
    data: "printf 'BENCHDESK_%s\\n' TERMINAL_OK\r",
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    const screen = await call("session.screen", { id: terminal.id });
    if (screen.screen.includes("BENCHDESK_TERMINAL_OK")) break;
    if (attempt === 99)
      throw new Error("Free terminal did not execute shell command");
    await new Promise((r) => setTimeout(r, 50));
  }
  await checkTerminalFiles({ app, page, call, root, sessionId: terminal.id });
  await page.screenshot({
    path: join(shots, "terminal.png"),
    animations: "disabled",
  });
  assert.equal(await page.locator('[data-test="sidebar"]').getByRole("button", { name: "Terminal openen", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await page
    .getByRole("button", { name: "Terminal openen", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-test="pro-conversation-item"]').length >=
      2,
  );
  assert.equal(
    (await call("snapshot")).sessions.filter(
      (s) => s.provider === "shell" && !s.taskId,
    ).length,
    2,
  );
  assert.deepEqual(errors, []);
  passed = true;
  console.log(
    "Dashboard passed: all companies, combined filters, empty states, status changes, drag/drop, dependency/schedule guards, cross-company creation/opening, review routing and compact layout. Free terminal opens directly, executes shell commands and supports multiple sessions without tasks or AI accounts.",
  );
} finally {
  if (!passed && page)
    await page.screenshot({ path: join(shots, "failure.png") }).catch(() => {});
  await app.close();
  if (runnerPid) {
    try {
      process.kill(runnerPid, "SIGTERM");
    } catch {}
  }
  if (passed) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  else console.error("Testgegevens bewaard:", root);
}
