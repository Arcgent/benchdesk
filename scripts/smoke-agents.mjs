import assert from "node:assert/strict";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";
import electron from "electron";
import { chromium } from "playwright";

const output = resolve(process.argv[2] || "tmp/agents-smoke");
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "benchdesk-agents-ui-"));
const dataDir = join(root, "data");
const seedFile = join(output, "seed.cjs");
await build({
  stdin: {
    contents: `
  import { Store } from './src/core/store';
  import { mkdirSync } from 'node:fs';
  import { join } from 'node:path';
  const root = process.argv[2]; mkdirSync(root,{recursive:true});
  const store = new Store(join(root,'werk.sqlite'));
  const companyId = store.saveCompany({name:'Agent testbedrijf',workspacePath:root});
  store.saveCompany({name:'Ander testbedrijf',workspacePath:root});
  const projectId = store.saveProject({companyId,name:'Content'});
  store.saveTask({companyId,projectId,title:'LinkedIn post schrijven'});
  store.close();
`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  outfile: seedFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["better-sqlite3"],
});
const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
for (const k of [
  "WERK_SOCKET",
  "WERK_SESSION_ID",
  "WERK_SESSION_TOKEN",
  "WERK_DATA_DIR",
  "WERK_LAUNCH_FILE",
])
  delete env[k];
const seed = spawn(electron, [seedFile, dataDir], { env, stdio: "inherit" });
assert.equal(await new Promise((r) => seed.on("exit", r)), 0);
const port = await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on("error", reject);
  s.listen(0, "127.0.0.1", () => {
    const port = s.address().port;
    s.close(() => resolve(port));
  });
});
const base = `http://127.0.0.1:${port}`;
const server = spawn(electron, [resolve("dist/web/server.cjs")], {
  env: {
    ...env,
    WERK_DATA_DIR: dataDir,
    WERK_WEB_PORT: String(port),
    WERK_WEB_PREVIEW: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "",
  browser;
server.stdout.on("data", (d) => (logs += d));
server.stderr.on("data", (d) => (logs += d));
const errors = [];
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, logs);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 980 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "Nieuwe agent", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Naam", exact: true })
    .fill("LinkedIn-schrijver");
  await page
    .getByRole("textbox", { name: "Rol", exact: true })
    .fill("Schrijft heldere posts met jouw stem.");
  await page
    .getByRole("textbox", { name: "Vaste briefing", exact: true })
    .fill("Schrijf concreet. Gebruik geen verzonnen voorbeelden.");
  await page.getByRole("button", { name: "Opslaan", exact: true }).click();
  await page
    .getByRole("heading", { name: "LinkedIn-schrijver", exact: true })
    .waitFor();
  await page.getByRole("complementary", { name: "Vaste agents" }).waitFor();
  // Policy: new agents ask before writes; a deny rule is saved and the tester uses it.
  await page.getByRole("tab", { name: "Regels", exact: true }).click();
  assert.equal(
    await page.getByRole("combobox", { name: "Schrijven" }).inputValue(),
    "ask",
  );
  await page.getByRole("button", { name: "Regel toevoegen", exact: true }).click();
  await page.getByRole("textbox", { name: "Tool (* mag)", exact: true }).fill("Bash");
  await page
    .getByRole("textbox", { name: "Commando (reguliere expressie)", exact: true })
    .fill("^rm ");
  await page.getByRole("textbox", { name: "Notitie", exact: true }).fill("Nooit verwijderen");
  await page.getByRole("button", { name: "Regel opslaan", exact: true }).click();
  await page.locator(".agent-policy__rules li").filter({ hasText: "Nooit verwijderen" }).waitFor();
  await page.getByRole("textbox", { name: "Commando, pad of URL", exact: true }).fill("rm -rf oud");
  await page.getByRole("status").filter({ hasText: "Nooit verwijderen" }).waitFor();
  await page.screenshot({ path: join(output, "agent-policy.png"), fullPage: true });
  await page.getByRole("tab", { name: "Logboek", exact: true }).click();
  await page.getByText("Nog niets vastgelegd met deze filters.").waitFor();
  await page.screenshot({ path: join(output, "agent-audit.png") });
  await page.getByRole("tab", { name: "Skills", exact: true }).click();
  await page.getByRole("button", { name: "Nieuwe skill", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Naam", exact: true })
    .fill("Post controleren");
  await page
    .getByRole("textbox", { name: "Wanneer gebruiken?", exact: true })
    .fill("Voor het opleveren van een LinkedIn-post");
  await page
    .getByRole("textbox", { name: "Stappen en controle", exact: true })
    .fill("Controleer feiten en bronnen. Lees hardop. Lever een concept op.");
  await page.getByRole("button", { name: "Opslaan", exact: true }).click();
  await page
    .getByRole("heading", { name: "Post controleren", exact: true })
    .waitFor();
  await page.getByRole("tab", { name: "Instellingen", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Routines toestaan", exact: true })
    .check();
  await page
    .getByRole("checkbox", {
      name: "Overdracht tussen agents toestaan",
      exact: true,
    })
    .check();
  await page.getByRole("checkbox", { name: "GitHub", exact: true }).uncheck();
  await page
    .getByRole("button", { name: "Rechten opslaan", exact: true })
    .click();
  await page.getByRole("tab", { name: "Routines", exact: true }).click();
  await page
    .getByRole("button", { name: "Nieuwe routine", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Naam", exact: true })
    .fill("Wekelijkse contentideeën");
  await page
    .getByRole("textbox", { name: "Opdracht", exact: true })
    .fill(
      "Stel drie onderbouwde onderwerpen voor op basis van ons bedrijfsbrein.",
    );
  await page.getByLabel("Herhaling", { exact: true }).selectOption("weekly");
  await page.getByRole("button", { name: "Opslaan", exact: true }).click();
  await page
    .getByRole("heading", { name: "Wekelijkse contentideeën", exact: true })
    .waitFor();
  await page.getByText("Gepauzeerd", { exact: true }).waitFor();
  await page.screenshot({
    path: join(output, "agent-routines.png"),
    fullPage: true,
  });
  await page.getByRole("tab", { name: "Zoeken", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Zoekterm", exact: true })
    .fill("onderwerp");
  await page.getByRole("button", { name: "Zoeken", exact: true }).click();
  await page.getByText("Geen berichten gevonden.", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "Geheugen", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Agentgeheugen", exact: true })
    .fill("Gebruik korte zinnen en Nederlandse voorbeelden.");
  await page
    .getByRole("button", { name: "Geheugen opslaan", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Nieuw gesprek", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Gesprek openen", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Bericht aan je agent", exact: true })
    .fill("Bewaar dit conceptbericht.");
  await page.screenshot({
    path: join(output, "agent-chat.png"),
    fullPage: true,
  });
  await page.reload();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.locator(".agent-card").first().click();
  await page.locator(".agent-threads button").first().click();
  assert.equal(
    await page
      .getByRole("textbox", { name: "Bericht aan je agent", exact: true })
      .inputValue(),
    "Bewaar dit conceptbericht.",
  );
  // An agent conversation opens as a window on the canvas and leaves it without being stopped.
  await page
    .getByRole("button", { name: "Naast elkaar openen", exact: true })
    .click();
  const pane = page.locator(".rz-pane--agent");
  await pane.waitFor();
  assert.equal(
    await pane
      .getByRole("textbox", { name: "Bericht aan je agent", exact: true })
      .inputValue(),
    "Bewaar dit conceptbericht.",
  );
  await page.screenshot({ path: join(output, "agent-canvas.png") });
  // The canvas bar starts a new conversation with an agent right beside it.
  await page.getByRole("button", { name: "Agent openen", exact: true }).click();
  await page.getByRole("menuitem").first().click();
  await page.locator(".rz-pane--agent").nth(1).waitFor();
  await page.screenshot({ path: join(output, "agent-canvas-split.png") });
  for (let n = 2; n > 0; n--) {
    await page
      .locator(".rz-pane--agent")
      .first()
      .getByRole("button", { name: "Van canvas halen", exact: true })
      .click();
    await page.waitForFunction(
      (n) => document.querySelectorAll(".rz-pane--agent").length === n - 1,
      n,
    );
  }
  await page.reload();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.locator(".agent-card").first().click();
  await page.locator(".agent-threads button").first().click();
  await page
    .getByRole("button", { name: "Aan taak koppelen", exact: true })
    .click();
  await page.getByRole("button", { name: "Koppelen", exact: true }).click();
  await page
    .getByRole("button", { name: "Taak bekijken", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Werk overdragen", exact: true })
    .click();
  await page
    .getByText(
      "Kies eerst toegestane collega’s bij Instellingen → Rechten en samenwerking.",
      { exact: true },
    )
    .waitFor();
  await page.getByRole("button", { name: "Annuleren", exact: true }).click();
  await page.getByRole("tab", { name: "Geheugen", exact: true }).click();
  assert.equal(
    await page
      .getByRole("textbox", { name: "Agentgeheugen", exact: true })
      .inputValue(),
    "Gebruik korte zinnen en Nederlandse voorbeelden.",
  );
  await page.getByRole("tab", { name: "Instellingen", exact: true }).click();
  assert.equal(
    await page
      .getByRole("checkbox", { name: "Routines toestaan", exact: true })
      .isChecked(),
    true,
  );
  assert.equal(
    await page
      .getByRole("checkbox", { name: "GitHub", exact: true })
      .isChecked(),
    false,
  );
  await page
    .getByRole("button", { name: "Agent bewerken", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Vaste briefing", exact: true })
    .fill("Nieuwe briefing voor nieuwe gesprekken.");
  await page.getByRole("button", { name: "Opslaan", exact: true }).click();
  await page.getByRole("tab", { name: "Instellingen", exact: true }).click();
  await page.getByRole("button", { name: "Kopiëren", exact: true }).click();
  await page.getByRole("button", { name: "Archiveren", exact: true }).click();
  await page
    .getByRole("button", { name: "Agent herstellen", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Nieuw gesprek", exact: true })
      .isDisabled(),
    true,
  );
  await page
    .getByRole("button", { name: "Agent herstellen", exact: true })
    .click();
  await page.getByRole("button", { name: "Alle agents", exact: true }).click();
  await page.locator(".agent-card").nth(1).waitFor();
  assert.equal(await page.locator(".agent-card").count(), 2);
  await page.screenshot({
    path: join(output, "agent-profiles.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 800, height: 900 });
  await page.locator(".agent-card").first().click();
  await page.locator(".agent-threads button").first().click();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.screenshot({
    path: join(output, "agent-chat-compact.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 980 });
  await page
    .getByRole("button", { name: "Agent toevoegen", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Naam", exact: true })
    .fill("Onderzoeker");
  await page
    .getByRole("textbox", { name: "Rol", exact: true })
    .fill("Vindt bronnen en controleert feiten");
  await page.getByRole("button", { name: "Opslaan", exact: true }).click();
  await page
    .getByRole("heading", { name: "Onderzoeker", exact: true })
    .waitFor();
  assert.equal(await page.locator(".agent-roster nav > button").count(), 3);
  await page.locator(".agent-roster nav > button").first().click();
  await page
    .getByRole("textbox", { name: "Bericht aan je agent", exact: true })
    .waitFor();
  await page.screenshot({
    path: join(output, "agent-roster.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: roster switching, policy rules, audit log, skills, permissions, paused routine, search, handoff controls, memory, chat, drafts, canvas window, tasks, copy, archive and compact layout",
  );
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  try {
    const pid = Number(await readFile(join(dataDir, "runner.pid"), "utf8"));
    if (pid) process.kill(pid, "SIGTERM");
  } catch {}
  await writeFile(join(output, "server.log"), logs);
  await rm(root, { recursive: true, force: true });
}
