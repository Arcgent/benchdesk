import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const root = await mkdtemp(join(tmpdir(), "benchdesk-integrations-ui-"));
const dataDir = join(root, "data"),
  workspace = join(root, "workspace"),
  shellDir = join(root, "shell");
for (const dir of [dataDir, workspace, shellDir]) await mkdir(dir);
await writeFile(join(shellDir, ".zshrc"), `export PATH='${shellDir}':$PATH\n`);
for (const provider of ["claude", "codex"])
  await writeFile(
    join(shellDir, provider),
    '#!/bin/sh\nif [ "$1" = --version ]; then echo "fixture 1.0"; exit 0; fi\nprintf "%s" "$WERK_SESSION_TOKEN" > "$WERK_LAUNCH_FILE.test-token"\nexec /bin/cat\n',
    { mode: 0o755 },
  );
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
    ZDOTDIR: shellDir,
    SHELL: "/bin/zsh",
  },
});
let page,
  runnerPid,
  passed = false;
const errors = [];
const call = (method, params) =>
  page.evaluate(({ method, params }) => window.werk.call(method, params), {
    method,
    params,
  });
async function until(fn) {
  for (let i = 0; i < 150; i++) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("Testvoorwaarde niet bereikt");
}
try {
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page
    .getByRole("heading", { name: "Begin met het bedrijf waar je aan werkt." })
    .waitFor();
  await page
    .getByLabel("Bedrijfsnaam", { exact: true })
    .fill("Noorderlicht Studio");
  await page
    .getByRole("button", { name: "Bedrijf aanmaken", exact: true })
    .click();
  await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
  runnerPid = Number(await readFile(join(dataDir, "runner.pid"), "utf8"));
  const companyId = (await call("snapshot")).companies[0].id;
  const other = await call("company.save", {
    value: { name: "Atelier Noord", workspacePath: workspace },
  });
  // A stale key without a Gmail vault must not make secure storage part of
  // the conversation startup path.
  await writeFile(join(dataDir, "integrations.key"), "not-an-encrypted-key", {
    mode: 0o600,
  });
  const keyOnlySession = await call("session.start", {
    companyId,
    provider: "shell",
    gmailAccess: "none",
  });
  await until(async () =>
    (await call("snapshot")).sessions.some(
      (s) => s.id === keyOnlySession && s.alive,
    ),
  );
  await call("session.stop", { id: keyOnlySession });
  // Even with a Gmail vault present, an unreadable key disables Gmail for
  // the session instead of blocking the session itself.
  await writeFile(join(dataDir, "integrations.vault"), "invalid-fixture", {
    mode: 0o600,
  });
  const unavailableStorageSession = await call("session.start", {
    companyId,
    provider: "shell",
    gmailAccess: "read",
  });
  await until(async () =>
    (await call("snapshot")).sessions.some(
      (s) => s.id === unavailableStorageSession && s.alive,
    ),
  );
  await call("session.stop", { id: unavailableStorageSession });
  await rm(join(dataDir, "integrations.key"));
  await rm(join(dataDir, "integrations.vault"));
  const key = randomBytes(32),
    iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  const accountId = randomUUID();
  const fixture = {
    config: {
      clientId: "fixture.apps.googleusercontent.com",
      clientSecret: "fixture-secret",
    },
    receipts: {},
    accounts: [
      {
        id: accountId,
        email: "info@noorderlicht.test",
        status: "connected",
        connectedAt: new Date().toISOString(),
        links: [{ companyId, drafts: true }],
        accessToken: "fixture-access",
        refreshToken: "fixture-refresh",
        expiresAt: Date.now() + 3600000,
        scopes: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.compose",
        ],
      },
    ],
  };
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(fixture)),
    cipher.final(),
  ]);
  const wrapped = await app.evaluate(({ safeStorage }, value) => {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error("OS-beveiligde opslag niet beschikbaar voor deze test.");
    return safeStorage.encryptString(value).toString("base64");
  }, key.toString("hex"));
  await writeFile(
    join(dataDir, "integrations.key"),
    Buffer.from(wrapped, "base64"),
    { mode: 0o600 },
  );
  await writeFile(
    join(dataDir, "integrations.vault"),
    JSON.stringify({
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: encrypted.toString("base64"),
    }),
    { mode: 0o600 },
  );
  await page.getByRole("button", { name: "Koppelingen", exact: true }).click();
  await page.locator('[data-test="typesafe-connection"]').waitFor();
  assert.equal(
    await page.locator(".rz-integrations__provider-card").count(),
    7,
  );
  for (const provider of ["fireflies", "pocket", "unipile", "github", "blotato"])
    await page.locator(`[data-test="${provider}-provider-card"]`).waitFor();
  for (const [provider, label] of [
    ["fireflies", "Fireflies"],
    ["pocket", "Pocket"],
    ["unipile", "Unipile"],
    ["github", "GitHub"],
    ["blotato", "Blotato"],
  ]) {
    await page
      .locator(`[data-test="${provider}-provider-card"]`)
      .getByRole("button", { name: `${label}-instellingen`, exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: `${label}-instellingen`,
    });
    await dialog.waitFor();
    await dialog.getByRole("textbox").last().waitFor();
    if (provider === "unipile")
      await dialog.getByLabel("DSN", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Sluiten", exact: true }).click();
  }
  await page
    .locator('[data-test="typesafe-connection"]')
    .getByRole("button", { name: "Verbinden", exact: true })
    .click();
  await page.getByRole("dialog", { name: "TypeSafe · Jev" }).waitFor();
  await page
    .getByRole("dialog", { name: "TypeSafe · Jev" })
    .getByRole("button", { name: "Sluiten", exact: true })
    .click();
  await page.getByRole("heading", { name: "info@noorderlicht.test" }).waitFor();
  assert.equal(
    await page
      .getByLabel("Mails lezen: info@noorderlicht.test, Noorderlicht Studio")
      .isChecked(),
    true,
  );
  assert.equal(
    await page
      .getByLabel("Mails lezen: info@noorderlicht.test, Atelier Noord")
      .isChecked(),
    false,
  );
  const otherRead = page.getByLabel(
    "Mails lezen: info@noorderlicht.test, Atelier Noord",
  );
  await otherRead.check();
  await until(async () =>
    (await call("integrations.get")).accounts[0].links.some(
      (l) => l.companyId === other,
    ),
  );
  const otherDraft = page.getByLabel(
    "Concepten maken: info@noorderlicht.test, Atelier Noord",
  );
  assert.equal(await otherDraft.isChecked(), false);
  await otherDraft.check();
  await until(
    async () =>
      (await call("integrations.get")).accounts[0].links.find(
        (l) => l.companyId === other,
      )?.drafts,
  );
  await otherRead.uncheck();
  await until(
    async () =>
      !(await call("integrations.get")).accounts[0].links.some(
        (l) => l.companyId === other,
      ),
  );
  assert.equal(await otherDraft.isDisabled(), true);
  await page
    .getByRole("button", { name: "Google-instellingen", exact: true })
    .click();
  await page.getByRole("heading", { name: "Gmail-instellingen" }).waitFor();
  assert.equal(
    await page.getByLabel("Client secret", { exact: true }).inputValue(),
    "",
  );
  const file = join(root, "client.json");
  await writeFile(
    file,
    JSON.stringify({
      installed: {
        client_id: fixture.config.clientId,
        client_secret: "replacement-fixture-secret",
      },
    }),
  );
  await page.getByLabel("Google-clientbestand importeren").setInputFiles(file);
  await page.getByRole("button", { name: "Instellingen opslaan" }).click();
  await page
    .getByRole("heading", { name: "Gmail-instellingen" })
    .waitFor({ state: "hidden" });
  const publicState = JSON.stringify(await call("integrations.get"));
  assert.doesNotMatch(
    publicState,
    /fixture-secret|fixture-access|fixture-refresh/,
  );
  await page
    .getByRole("button", { name: "Account verbinden", exact: true })
    .click();
  const consent = page.getByRole("dialog");
  assert.equal(await consent.getByRole("checkbox").isChecked(), false);
  await consent.getByRole("checkbox").check();
  await consent
    .getByText(/Google vraagt hiervoor ook verzendrechten/)
    .waitFor();
  await consent.getByRole("button", { name: "Annuleren" }).click();
  const id = await call("session.start", {
    companyId,
    provider: "claude",
    gmailAccess: "read",
  });
  await until(async () =>
    (await call("snapshot")).sessions.some((s) => s.id === id && s.alive),
  );
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await page.getByRole("button", { name: "Koppelingen", exact: true }).click();
  const shots = resolve("docs/rustig/screenshots/smoke-integrations");
  await mkdir(shots, { recursive: true });
  await page
    .getByRole("button", { name: "Google-instellingen", exact: true })
    .click();
  const choice = page.locator('[data-test="integration-sessions"] select');
  await choice.waitFor();
  assert.equal(await choice.inputValue(), "read");
  await choice.selectOption("none");
  await until(
    async () => (await call("integrations.get")).sessions[id] === "none",
  );
  await page.screenshot({ path: join(shots, "gmail-settings.png") });
  await page
    .getByRole("dialog", { name: "Gmail-instellingen" })
    .getByRole("button", { name: "Sluiten", exact: true })
    .click();
  await page.screenshot({ path: join(shots, "gmail-desktop.png") });
  // The always-available account actions live in the row's ⋯ menu (portalled: locate the item on the page).
  await page
    .getByRole("button", { name: "Opties voor info@noorderlicht.test" })
    .click();
  await page
    .getByRole("menuitem", { name: "Verbinding verwijderen", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Verbinding verwijderen", exact: true })
    .click();
  await until(
    async () => (await call("integrations.get")).accounts.length === 0,
  );
  await call("session.stop", { id });
  await page.getByRole("button", { name: "Aan het werk", exact: true }).click();
  await page.keyboard.press("Meta+t");
  await page.getByRole("dialog").waitFor();
  await page
    .locator('[data-test="gmail-session-choice"] select')
    .selectOption("read");
  assert.equal(
    await page
      .locator('[data-test="gmail-session-choice"] select')
      .inputValue(),
    "read",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Annuleren" })
    .click();
  assert.deepEqual(errors, []);
  passed = true;
  console.log(
    "Gmail desktop UI passed: encrypted OS storage, company permissions, credential import, consent copy, session controls, disconnect and launcher. No Google account accessed.",
  );
} finally {
  if (!passed && page) {
    await mkdir(resolve("docs/rustig/screenshots/smoke-integrations"), {
      recursive: true,
    });
    await page
      .screenshot({
        path: resolve("docs/rustig/screenshots/smoke-integrations/failure.png"),
      })
      .catch(() => {});
  }
  await app.close();
  if (runnerPid) {
    try {
      process.kill(runnerPid, "SIGTERM");
    } catch {}
  }
  if (passed) {
    await new Promise((r) => setTimeout(r, 400));
    await rm(root, { recursive: true, force: true });
  } else console.error("Testgegevens bewaard:", root);
}
