import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const root = await mkdtemp(join(tmpdir(), "werk-schedules-ui-"));
const dataDir = join(root, "data");
await mkdir(dataDir);
const overview = JSON.parse(
  await readFile(
    process.env.WERK_TEST_SCHEDULE_OVERVIEW || "tests/fixtures/schedules.json",
    "utf8",
  ),
);
// A fresh, isolated cache keeps this UI check from calling external services.
if (!process.env.WERK_TEST_SCHEDULE_OVERVIEW)
  overview.inspectedAt = new Date().toISOString();
await writeFile(
  join(dataDir, "schedule-overview.json"),
  JSON.stringify(overview),
  { mode: 0o600 },
);
const executablePath = process.env.WERK_TEST_EXECUTABLE;
const app = await electron.launch({
  ...(executablePath ? { executablePath, args: [] } : { args: [resolve(".")] }),
  cwd: resolve("."),
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "",
    WERK_DATA_DIR: dataDir,
    WERK_WORKSPACE: root,
    WERK_TEST_HIDDEN: "1",
  },
});
const errors = [];
let runnerPid;
try {
  const page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1440, 1000);
  });
  await page
    .getByRole("heading", { name: "Begin met het bedrijf waar je aan werkt." })
    .waitFor();
  await page.evaluate(
    async (workspace) =>
      window.werk.call("company.save", {
        value: { name: "Herhalingen test", workspacePath: workspace },
      }),
    root,
  );
  await page.getByRole("button", { name: "Terugkerend", exact: true }).click();
  // Rustig copy: the H1 is the page name; "herhaling" → "terugkerende taak".
  await page
    .getByRole("heading", { name: "Terugkerend", exact: true })
    .waitFor();
  await page.locator('[data-test="schedule-row"]').first().waitFor();
  const count = await page.locator('[data-test="schedule-row"]').count();
  assert.equal(count, overview.jobs.filter((j) => !j.system).length);
  await page.getByLabel("Zoek een terugkerende taak").fill("nightly_report");
  assert.equal(await page.locator('[data-test="schedule-row"]').count(), 2);
  await page.locator('[data-test="schedule-row"] > summary').first().click();
  await page
    .locator('[data-test="schedule-row"][open]')
    .getByText("De ingestelde werkmap bestaat niet op deze Mac.", {
      exact: true,
    })
    .waitFor();
  await mkdir("docs/rustig/screenshots/smoke-schedules", { recursive: true });
  await page.screenshot({
    path: "docs/rustig/screenshots/smoke-schedules/terugkerend-aandacht.png",
  });
  await page.getByLabel("Zoek een terugkerende taak").fill("");
  await page.getByRole("button", { name: "Op tijd", exact: true }).click();
  const expectedTimed = overview.jobs.filter(
    (j) => !j.system && ["cron", "scheduled", "once"].includes(j.kind),
  ).length;
  assert.equal(
    await page.locator('[data-test="schedule-row"]').count(),
    expectedTimed,
  );
  await page
    .getByLabel("Filter op bron")
    .selectOption(overview.sources.find((s) => s.name === "instantly").id);
  assert.equal(
    await page.locator('[data-test="schedule-row"]').count(),
    overview.jobs.filter(
      (j) =>
        j.sourceId ===
          overview.sources.find((s) => s.name === "instantly").id &&
        j.kind === "scheduled",
    ).length,
  );
  await page.getByLabel("Filter op bron").selectOption("all");
  await page.screenshot({
    path: "docs/rustig/screenshots/smoke-schedules/terugkerend.png",
  });
  await page.locator('[data-test="schedule-sources"] > summary').click();
  assert.equal(
    await page.locator('[data-test="schedule-source"]').count(),
    overview.sources.length,
  );
  await page.screenshot({
    path: "docs/rustig/screenshots/smoke-schedules/terugkerend-bronnen.png",
  });
  await page.locator('[data-test="schedule-sources"] > summary').click();
  await page.getByRole("button", { name: "Alles", exact: true }).click();
  await page.getByLabel(/Ook ingebouwde macOS-taken/).check();
  assert.equal(
    await page.locator('[data-test="schedule-row"]').count(),
    overview.jobs.length,
  );
  await page
    .getByLabel("Zoek een terugkerende taak")
    .fill("niet-bestaande-zoekterm-werk");
  await page
    .getByRole("heading", { name: "Geen taken met deze filters" })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    `PASS: ${overview.jobs.length} items; bronnen, zoekfilter, typefilter, bronfilter, details, lege resultaten en macOS-filter; geen rendererfouten.`,
  );
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
  await rm(root, { recursive: true, force: true });
}
