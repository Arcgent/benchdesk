import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import net from "node:net";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import electron from "electron";
import { chromium } from "playwright";

const root = await mkdtemp(join(tmpdir(), "werk-web-test-"));
const dataDir = join(root, "data"),
  dotdir = join(root, "shell");
await mkdir(dotdir);
await writeFile(join(dotdir, ".zshrc"), "PS1='werk %~ % '\n");
const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const port = probe.address().port;
    probe.close(() => resolve(port));
  });
});
const base = `http://127.0.0.1:${port}`;
const server = spawn(electron, [resolve("dist/web/server.cjs")], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    WERK_DATA_DIR: dataDir,
    WERK_WEB_PREVIEW: "1",
    WERK_WEB_PORT: String(port),
    SHELL: "/bin/zsh",
    ZDOTDIR: dotdir,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "",
  browser,
  cookie,
  sessionId,
  passed = false;
server.stdout.on("data", (d) => (logs += d));
server.stderr.on("data", (d) => (logs += d));
async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Browsercontrole duurde te lang.");
}
const headers = () => ({
  "content-type": "application/json",
  origin: base,
  cookie,
});
async function call(method, params = {}) {
  const response = await fetch(base + "/api/call", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ method, params }),
  });
  const value = await response.json();
  assert.equal(response.status, 200, value.error);
  return value.result;
}
try {
  const response = await until(async () => {
    try {
      return await fetch(base);
    } catch {
      return false;
    }
  });
  assert.equal(response.status, 200);
  cookie = response.headers.get("set-cookie").split(";")[0];
  assert.match(response.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  const info = await call("app.info");
  assert.equal(info.preview, true);
  assert.equal(info.dataDir, dataDir);
  assert.equal((await call("snapshot")).companies.length, 2);
  for (const badHeaders of [
    { "content-type": "application/json", origin: base },
    { ...headers(), origin: "https://example.invalid" },
    { ...headers(), "sec-fetch-site": "cross-site" },
    { ...headers(), host: "example.invalid" },
  ]) {
    const status = await new Promise((resolve, reject) => {
      const request = http.request(
        base + "/api/call",
        {
          method: "POST",
          headers: badHeaders,
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on("error", reject);
      request.end(JSON.stringify({ method: "snapshot" }));
    });
    assert.equal(status, 403);
  }
  const forbiddenFile = await fetch(base + "/api/preview", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ path: "/etc/passwd" }),
  });
  assert.equal(forbiddenFile.status, 400);
  console.log("PASS: localhost-toegang, sessiecookie en bestandsbegrenzing");

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  const errors = [];
  context.on("page", (page) =>
    page.on("pageerror", (e) => errors.push(e.message)),
  );
  const page = await context.newPage();
  await page.goto(base);
  // Rustig Vandaag: sr-only h1 "Vandaag" + the visible headline sentence. The preview data holds one review task
  // and two blocked tasks (mixed kinds, two projects), so the honest headline is the "acties" sentence without
  // a project clause (todayHeadline, F3 decision 4).
  await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
  await page
    .getByRole("heading", { name: "3 acties wachten op jou.", exact: true })
    .waitFor();
  assert.equal(
    await page.getByText("Voorbeeldgegevens", { exact: true }).count(),
    1,
  );
  await page.evaluate(() => document.fonts.ready);
  const shots = resolve("docs/rustig/screenshots/smoke-web");
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: join(shots, "14-localhost.png") });
  await page.getByRole("button", { name: "Beoordelen", exact: true }).click();
  await page
    .getByText("Voorbeeldgegevens voor het ontwerp van Benchdesk.", { exact: true })
    .waitFor();
  const criterion = "Akkoord: Verzendmomenten onderbouwd";
  const second = await context.newPage();
  await second.goto(base);
  await second.getByRole("button", { name: "Beoordelen", exact: true }).click();
  const secondCheck = second.getByRole("checkbox", { name: criterion });
  await secondCheck.waitFor();
  assert.equal(await secondCheck.isChecked(), false);
  await page.getByRole("checkbox", { name: criterion }).check();
  await until(() => secondCheck.isChecked(), 4000);
  await page.reload();
  await page.getByRole("button", { name: "Beoordelen", exact: true }).click();
  await page.getByRole("checkbox", { name: criterion }).waitFor();
  assert.equal(
    await page.getByRole("checkbox", { name: criterion }).isChecked(),
    true,
  );
  console.log(
    "PASS: echte Chrome-interface, bestandsvoorbeeld, opslaan en live updates tussen tabs",
  );

  const snap = await call("snapshot");
  sessionId = await call("session.start", {
    companyId: snap.companies[0].id,
    provider: "shell",
  });
  // The conversation list lives in the sidebar of "Aan het werk"; a row places the conversation on the canvas
  // (D1 toggle), and the canvas layout survives a reload, so the row is only clicked while the pane is absent.
  const openConversation = async () => {
    await page
      .locator('[data-test="sidebar"]')
      .getByRole("button", { name: /Aan het werk/ })
      .click();
    const pane = page.locator(
      `[data-test="pro-canvas-pane"][data-session-id="${sessionId}"]`,
    );
    if (!(await pane.count()))
      await page
        .locator(
          `[data-test="pro-conversation-item"][data-session-id="${sessionId}"]`,
        )
        .click();
    await pane.waitFor();
  };
  await openConversation();
  const terminal = page.locator(".xterm-helper-textarea");
  await terminal.waitFor({ state: "attached" });
  await terminal.focus();
  await page.keyboard.type("printf 'WERK_%s_OK\\n' 'LOCALHOST'");
  await page.keyboard.press("Enter");
  await page
    .locator(".xterm-rows")
    .getByText("WERK_LOCALHOST_OK", { exact: true })
    .waitFor();
  await page.reload();
  await openConversation();
  await page
    .locator(".xterm-rows")
    .getByText("WERK_LOCALHOST_OK", { exact: true })
    .waitFor();
  assert.equal(
    (await call("snapshot")).sessions.find((s) => s.id === sessionId).alive,
    true,
  );
  await call("session.stop", { id: sessionId });
  console.log(
    "PASS: echte PTY, toetsenbordinvoer, live terminaluitvoer en herstel na herladen",
  );
  assert.deepEqual(errors, []);
  passed = true;
  console.log(
    "PASS: geen JavaScript-fouten; bestaande desktopgegevens niet gebruikt",
  );
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  if (sessionId) await call("session.stop", { id: sessionId }).catch(() => {});
  await browser?.close();
  server.kill("SIGTERM");
  try {
    process.kill(
      Number(await readFile(join(dataDir, "runner.pid"), "utf8")),
      "SIGTERM",
    );
  } catch {}
  if (passed) {
    await until(async () => {
      try {
        const pid = Number(await readFile(join(dataDir, "runner.pid"), "utf8"));
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      } catch {
        return true;
      }
    });
    await rm(root, { recursive: true, force: true });
  } else console.error(`Testgegevens: ${root}`);
}
