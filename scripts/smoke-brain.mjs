import assert from "node:assert/strict";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";
import electron from "electron";
import { chromium } from "playwright";

const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "benchdesk-brain-ui-"));
const dataDir = join(root, "data");
const seedFile = join(output, "seed-ui.cjs");
await build({
  stdin: {
    contents: `
  import { Store } from './src/core/store';
  import { mkdirSync, writeFileSync } from 'node:fs';
  import { join } from 'node:path';
  const root = process.argv[2]; mkdirSync(root,{recursive:true});
  const store = new Store(join(root,'werk.sqlite'));
  const companyId = store.saveCompany({name:'Wiki testbedrijf', workspacePath:root, product:'Ontwerpsoftware', audience:'Zelfstandige ontwerpers'});
  const other = store.saveCompany({name:'Ander testbedrijf', workspacePath:root});
  const projectId = store.saveProject({companyId,name:'Product'});
  store.saveProject({companyId,name:'Bron afwijzen',description:'Een kandidaat die we afkeuren.'});
  store.brain.capture(companyId,store.snapshot());
  const source = store.brain.pending(companyId).find(s=>s.kind==='company');
  const pages = [
    ['bedrijf','Bedrijfsprofiel','company','Wij bouwen ontwerpsoftware voor zelfstandige ontwerpers.',['doelgroep','besluit']],
    ['doelgroep','Doelgroep','topic','De doelgroep bestaat uit zelfstandige ontwerpers.',['bedrijf']],
    ['besluit','Productkeuze','decision','Voorstel: een eenvoudiger ontwerpproces onderzoeken. Nog niet besloten.',['bedrijf','doelgroep']]
  ];
  store.brain.commit(companyId,{changes:pages.map(([pageId,title,kind,body,links])=>({pageId,title,kind,expectedRevision:0,projectId,sections:[{id:'overzicht',title:'Overzicht',body,links,status:kind==='decision'?'proposal':'fact',sources:[source.id]}]})),processedSources:[source.id]},'assistant');
  for (const [pageId,title] of [['werkwijze','Werkwijze'],['later','Later onderzoeken']]) store.brain.commit(companyId,{changes:[{pageId,title,kind:'topic',expectedRevision:0,sections:[{id:'overzicht',title:'Overzicht',body:'Voorstel voor onze werkwijze.',status:'proposal',sources:[source.id],links:[]}]}]},'assistant',undefined,true);
  writeFileSync(join(root,'seed.json'),JSON.stringify({companyId,other})); store.close();
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
    const p = s.address().port;
    s.close(() => resolve(p));
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
  await page
    .getByRole("button", { name: "Bedrijfsbrein", exact: true })
    .click();
  await page.locator('[data-test="brain-page"]').waitFor();
  await page
    .locator(".brain-list-item")
    .filter({ hasText: "Doelgroep" })
    .click();
  await page.getByRole("heading", { name: "Doelgroep", exact: true }).waitFor();
  assert.match(
    await page.locator(".brain-detail").innerText(),
    /zelfstandige ontwerpers/,
  );
  await page.getByRole("button", { name: "Netwerk", exact: true }).click();
  assert.equal(await page.locator(".brain-node").count(), 3);
  assert.equal(await page.locator(".brain-edge").count(), 5);
  await page.screenshot({
    path: join(output, "brain-network.png"),
    fullPage: true,
  });
  const suggestions = page.locator('[data-test="wiki-suggestion"]');
  assert.equal(await suggestions.count(), 2);
  const review = suggestions.filter({
    has: page.locator("summary", { hasText: "Werkwijze" }),
  });
  await review.locator("summary").click();
  await review.locator(".brain-citations button").first().click();
  await review.locator(".brain-source pre").waitFor();
  await review.getByRole("button", { name: "Aanpassen", exact: true }).click();
  await review
    .getByRole("textbox", { name: "Werkwijze · Overzicht", exact: true })
    .fill("We onderzoeken ideeën eerst met ontwerpers.");
  await page.screenshot({
    path: join(output, "brain-suggestion.png"),
    fullPage: true,
  });
  await review.getByRole("button", { name: "Goedkeuren", exact: true }).click();
  await review.waitFor({ state: "detached" });
  await page
    .locator(".brain-list-item")
    .filter({ hasText: "Werkwijze" })
    .click();
  await page
    .getByText("We onderzoeken ideeën eerst met ontwerpers.", { exact: true })
    .waitFor();
  const skip = suggestions.filter({
    has: page.locator("summary", { hasText: "Later onderzoeken" }),
  });
  await skip.locator("summary").click();
  await skip.getByRole("button", { name: "Afkeuren", exact: true }).click();
  await skip.waitFor({ state: "detached" });
  assert.equal(await suggestions.count(), 0);
  const candidates = page.locator('[data-test="wiki-source-candidate"]');
  const sourceReview = candidates.filter({
    has: page.locator("summary", { hasText: /^Product/ }),
  });
  await sourceReview.locator("summary").click();
  await sourceReview
    .getByText("Dit wordt toegevoegd als nieuwe wikipagina", { exact: true })
    .waitFor();
  await sourceReview
    .getByRole("heading", { name: "Product", exact: true })
    .waitFor();
  await sourceReview
    .getByText(
      "Deze bron bevat nog geen artikeltekst. Voeg tekst toe via Aanpassen.",
      {
        exact: true,
      },
    )
    .waitFor();
  await sourceReview
    .getByRole("button", { name: "Aanpassen", exact: true })
    .click();
  await sourceReview
    .getByRole("textbox", { name: "Artikelinhoud", exact: true })
    .fill("Het Product-project verzamelt ons ontwerpwerk.");
  await sourceReview
    .getByRole("textbox", { name: "Artikeltitel", exact: true })
    .fill("Productproject");
  await sourceReview
    .getByRole("button", { name: "Goedkeuren", exact: true })
    .click();
  await sourceReview.waitFor({ state: "detached" });
  await page
    .locator(".brain-list-item")
    .filter({ hasText: "Productproject" })
    .click();
  await page
    .getByText("Het Product-project verzamelt ons ontwerpwerk.", {
      exact: true,
    })
    .waitFor();
  const sourceReject = candidates.filter({
    has: page.locator("summary", { hasText: "Bron afwijzen" }),
  });
  await sourceReject.locator("summary").click();
  await sourceReject
    .getByRole("button", { name: "Afkeuren", exact: true })
    .click();
  await sourceReject.waitFor({ state: "detached" });
  await page.reload();
  await page
    .getByRole("button", { name: "Bedrijfsbrein", exact: true })
    .click();
  await page.locator('[data-test="brain-page"]').waitFor();
  assert.equal(await sourceReject.count(), 0);
  const reviewSeed = JSON.parse(
    await readFile(join(dataDir, "seed.json"), "utf8"),
  );
  await page.evaluate(
    async (companyId) =>
      window.werk.call("project.save", {
        value: {
          companyId,
          name: "Nieuwe automatische kandidaat",
          description: "Nieuwe bron verschijnt in de beoordelingslijst.",
        },
      }),
    reviewSeed.companyId,
  );
  await candidates
    .filter({
      has: page.locator("summary", {
        hasText: "Nieuwe automatische kandidaat",
      }),
    })
    .waitFor();
  await page
    .getByRole("textbox", { name: "Zoek in beoordelingslijst" })
    .fill("automatische");
  assert.equal(await candidates.count(), 1);
  await page.screenshot({
    path: join(output, "brain-review-list.png"),
    fullPage: true,
  });
  await page
    .getByRole("textbox", { name: "Zoek in beoordelingslijst" })
    .fill("");
  await page
    .locator(".brain-list-item")
    .filter({ hasText: "Doelgroep" })
    .click();
  await page.getByRole("heading", { name: "Doelgroep", exact: true }).waitFor();
  const pageActions = page.getByRole("group", {
    name: "Wiki-acties",
    exact: true,
  });
  await pageActions
    .getByRole("button", { name: "Aanpassen", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Correctie", exact: true })
    .fill("De doelgroep bestaat uit onafhankelijke productontwerpers.");
  await page
    .getByRole("button", { name: "Correctie opslaan", exact: true })
    .click();
  await pageActions
    .getByRole("button", { name: "Mee chatten", exact: true })
    .click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  await page
    .getByText("De doelgroep bestaat uit onafhankelijke productontwerpers.", {
      exact: true,
    })
    .waitFor();
  await page
    .getByLabel("Versiegeschiedenis", { exact: true })
    .selectOption("1");
  await page
    .getByText("De doelgroep bestaat uit zelfstandige ontwerpers.", {
      exact: true,
    })
    .waitFor();
  await page
    .getByLabel("Versiegeschiedenis", { exact: true })
    .selectOption("2");
  await page
    .getByRole("textbox", { name: "Zoek in het bedrijfsbrein" })
    .fill("productontwerpers");
  await page.getByRole("button", { name: "Zoeken", exact: true }).click();
  await page.getByText(/Jev is niet verbonden/).waitFor();
  assert.equal(await page.locator(".brain-list-item").count(), 1);
  await page.locator(".brain-citations button").first().click();
  await page.locator(".brain-source pre").waitFor();
  await page.screenshot({
    path: join(output, "brain-source.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Wiki bijwerken", exact: true })
    .click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Koppelingen", exact: true }).click();
  const typeSafe = page.locator('[data-test="typesafe-connection"]');
  await typeSafe.waitFor();
  assert.equal(
    await typeSafe
      .getByRole("button", { name: "TypeSafe-instellingen", exact: true })
      .isDisabled(),
    true,
  );
  const ids = JSON.parse(await readFile(join(dataDir, "seed.json"), "utf8"));
  const other = await page.evaluate(
    async (companyId) => window.werk.call("brain.overview", { companyId }),
    ids.other,
  );
  assert.equal(other.pages.length, 0);
  await page
    .getByRole("button", { name: "Bedrijfsbrein", exact: true })
    .click();
  await page.setViewportSize({ width: 780, height: 900 });
  await page.screenshot({
    path: join(output, "brain-compact.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, "ui-results.json"),
    JSON.stringify(
      {
        passed: true,
        checks: [
          "navigation",
          "new-topic approval, source preview, edits and dismissal",
          "source candidates: edit and approve, persistent rejection, automatic arrival and search",
          "network and links",
          "source reader",
          "user correction",
          "revision history",
          "search and Jev fallback",
          "maintenance launcher",
          "TypeSafe setup",
          "company isolation",
          "compact viewport",
        ],
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: Company Brain UI, sources, corrections, search, graph and company isolation",
  );
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  try {
    const pid = Number(await readFile(join(dataDir, "runner.pid"), "utf8"));
    if (pid) process.kill(pid, "SIGTERM");
  } catch {}
  await writeFile(join(output, "ui-server.log"), logs);
  await rm(root, { recursive: true, force: true });
}
