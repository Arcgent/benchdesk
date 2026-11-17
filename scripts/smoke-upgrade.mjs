import { _electron as electron } from "playwright";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";
import assert from "node:assert/strict";

const root = await mkdtemp(join(tmpdir(), "werk-upgrade-ui-"));
const dataDir = join(root, "data");
await mkdir(dataDir);
await writeFile(join(dataDir, "control-token"), "isolated-upgrade-test-token", {
  mode: 0o600,
});
let live = true,
  stopped = 0,
  shutdowns = 0;
const sockets = new Set();
const server = net.createServer((socket) => {
  sockets.add(socket);
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  socket.on("data", (data) => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      let result, error;
      if (msg.token !== "isolated-upgrade-test-token") error = "Geen toegang";
      else if (msg.method === "ping") result = { version: 2 };
      else if (msg.method === "snapshot")
        result = {
          companies: [{ id: "c", name: "Bestaand bedrijf" }],
          tasks: [{ id: "t", title: "Lopende taak" }],
          sessions: [
            {
              id: "s",
              companyId: "c",
              taskId: "t",
              provider: "claude",
              alive: live,
            },
          ],
        };
      else if (msg.method === "session.stop") {
        stopped++;
        live = false;
        result = { ok: true };
      } else if (msg.method === "shutdown") {
        if (live) error = "Er zijn nog actieve gesprekken.";
        else {
          shutdowns++;
          result = { ok: true };
          setTimeout(() => {
            for (const s of sockets) s.destroy();
            server.close();
          }, 50);
        }
      } else error = "Onbekende opdracht";
      socket.write(JSON.stringify({ id: msg.id, result, error }) + "\n");
    }
  });
});
await new Promise((resolve) =>
  server.listen(join(dataDir, "runner.sock"), resolve),
);
let app;
try {
  app = await electron.launch({
    args: [resolve(".")],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "",
      WERK_DATA_DIR: dataDir,
      WERK_WORKSPACE: root,
      WERK_TEST_HIDDEN: "1",
    },
  });
  const page = await app.firstWindow();
  await page
    .getByRole("heading", { name: "Je nieuwe Benchdesk staat klaar." })
    .waitFor();
  await page.getByText("Lopende taak", { exact: true }).waitFor();
  assert.equal(stopped, 0);
  assert.equal(shutdowns, 0);
  assert.equal(
    await access(join(dataDir, "werk.sqlite")).then(
      () => true,
      () => false,
    ),
    false,
  );
  await page
    .getByRole("button", { name: "Opnieuw controleren", exact: true })
    .click();
  assert.equal(stopped, 0);
  await page
    .getByRole("button", { name: "Gesprek stoppen", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Begin met het bedrijf waar je aan werkt." })
    .waitFor({ timeout: 20000 });
  assert.equal(stopped, 1);
  assert.equal(shutdowns, 1);
  assert.equal(
    await access(join(dataDir, "werk.sqlite")).then(
      () => true,
      () => false,
    ),
    true,
  );
  assert.ok(
    (await page.evaluate(() => window.werk.call("preferences.get"))).accounts
      .length === 2,
  );
  console.log(
    "PASS: old live service remains untouched, database migration waits, explicit session stop enables clean upgrade, profile and welcome work after upgrade.",
  );
} finally {
  if (app) await app.close();
  for (const s of sockets) s.destroy();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  try {
    process.kill(
      Number(await readFile(join(dataDir, "runner.pid"), "utf8")),
      "SIGTERM",
    );
  } catch {}
  await new Promise((r) => setTimeout(r, 450));
  await rm(root, { recursive: true, force: true });
}
