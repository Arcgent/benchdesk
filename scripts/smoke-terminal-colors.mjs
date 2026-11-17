import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const shots = resolve("docs/rustig/screenshots/smoke-terminal-colors");
for (const dir of [shots, resolve("tmp/terminal-colors")])
  await mkdir(dir, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "benchdesk-colors-"));
const dataDir = join(root, "data"),
  workspace = join(root, "workspace"),
  shell = join(root, "shell");
for (const dir of [dataDir, workspace, shell]) await mkdir(dir);
await writeFile(
  join(shell, ".zshrc"),
  `export PATH='${shell}':$PATH\nPS1='test % '\n`,
);
// Reproduce Codex's 100 ms startup deadline, including before xterm mounts.
// This fixture never contacts a model or reads a personal account.
await writeFile(
  join(shell, "codex"),
  `#!/usr/bin/python3
import os, sys, tty, select, time, json
if '--version' in sys.argv:
 print('codex 1.0 (color test)'); sys.exit()
fd=sys.stdin.fileno()
tty.setraw(fd)
sequence=0
while True:
 start=time.monotonic()
 os.write(1,b'\\x1b]10;?\\x1b\\\\\\x1b]11;?\\x1b\\\\')
 response=b''
 deadline=start+0.1
 while time.monotonic()<deadline:
  ready,_,_=select.select([fd],[],[],max(0,deadline-time.monotonic()))
  if ready: response+=os.read(fd,4096)
  if b']10;rgb:' in response and b']11;rgb:' in response: break
 elapsed=(time.monotonic()-start)*1000
 # Also catch late/duplicate replies, as when multiple canvas terminals mount.
 until=time.monotonic()+0.2
 while time.monotonic()<until:
  ready,_,_=select.select([fd],[],[],max(0,until-time.monotonic()))
  if ready: response+=os.read(fd,4096)
 result={'response':response.decode(), 'elapsedMs':elapsed, 'env':{k:os.environ.get(k) for k in ['NO_COLOR','FORCE_COLOR','COLORTERM','TERM']}}
 path=os.environ['WERK_LAUNCH_FILE']+'.colors-'+str(sequence)+'.json'
 with open(path,'w') as f: json.dump(result,f)
 dark=b'1a1a/1a1a/1a1a' in response
 bg='47;47;47' if dark else '236;236;236'
 os.write(1, ('\\r\\n\\x1b[32mKleurdetectie geslaagd\\x1b[0m\\r\\n\\x1b[38;2;131;170;255mconst\\x1b[0m greeting = \\x1b[32m"Hallo Benchdesk"\\x1b[0m\\r\\n\\r\\n\\x1b[48;2;'+bg+'m > Typ je bericht hier                               \\x1b[0m\\r\\n').encode())
 while os.read(fd,1)!=b'p': pass
 sequence+=1
`,
  { mode: 0o755 },
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
    ZDOTDIR: shell,
    SHELL: "/bin/zsh",
    NO_COLOR: "1",
    FORCE_COLOR: "1",
  },
});
let passed = false;
const results = [];
const page = await app.firstWindow();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const call = (method, params = {}) =>
  page.evaluate(({ method, params }) => window.werk.call(method, params), {
    method,
    params,
  });
async function until(fn) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error("Color test timed out");
}
async function probe(id, sequence, theme) {
  const result = await until(async () => {
    try {
      return JSON.parse(
        await readFile(
          join(dataDir, "sessions", id, `launch.json.colors-${sequence}.json`),
          "utf8",
        ),
      );
    } catch {
      return null;
    }
  });
  const fg = theme === "dark" ? "ffff/ffff/ffff" : "2b2b/2b2b/2b2b",
    bg = theme === "dark" ? "1a1a/1a1a/1a1a" : "fafa/fafa/fafa";
  assert.equal(
    result.response,
    `\x1b]10;rgb:${fg}\x1b\\\x1b]11;rgb:${bg}\x1b\\`,
  );
  assert.ok(
    result.elapsedMs < 100,
    `Missed startup deadline: ${result.elapsedMs}`,
  );
  assert.equal(result.env.NO_COLOR, null);
  assert.equal(result.env.FORCE_COLOR, null);
  assert.equal(result.env.TERM, "xterm-256color");
  assert.equal(result.env.COLORTERM, "truecolor");
  results.push({ theme, sequence, elapsedMs: result.elapsedMs });
}
try {
  await page
    .getByLabel("Bedrijfsnaam", { exact: true })
    .fill("Terminalcontrole");
  await page
    .getByLabel(/Wat doet je bedrijf/)
    .fill("Geïsoleerde test van terminalkleuren.");
  await page
    .getByRole("button", { name: "Bedrijf aanmaken", exact: true })
    .click();
  await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
  const companyId = (await call("snapshot")).companies[0].id;
  for (const theme of ["light", "dark"]) {
    const toggle = page.getByRole("button", {
      name: theme === "dark" ? "Donker thema" : "Licht thema",
      exact: true,
    });
    if (await toggle.count()) await toggle.click();
    await until(() =>
      page.evaluate(
        (theme) => document.documentElement.dataset.theme === theme,
        theme,
      ),
    );
    assert.equal(await page.locator('[data-test="terminal-host"]').count(), 0);
    const id = await call("session.start", {
      companyId,
      taskId: null,
      provider: "codex",
      mode: "work",
    });
    await probe(id, 0, theme);
    await page
      .locator('[data-test="sidebar"]')
      .getByRole("button", { name: /Aan het werk/ })
      .click();
    await page
      .locator('[data-test="pro-conversation-list"] section')
      .getByRole("button")
      .first()
      .click();
    await page.locator('[data-test="terminal-host"]').first().waitFor();
    await call("session.write", { id, data: "p" });
    await probe(id, 1, theme);
    const frame = await call("session.screen", { id });
    assert.ok(frame.screen.includes("Kleurdetectie geslaagd"));
    assert.ok(
      frame.screen.includes("48;2;"),
      "Input background must survive headless serialization",
    );
    await page.screenshot({
      path: join(shots, `${theme}.png`),
    });
    await call("session.stop", { id });
    await page
      .locator('[data-test="sidebar"]')
      .getByRole("button", { name: /Dashboard/ })
      .click();
  }
  assert.deepEqual(errors, []);
  await writeFile(
    resolve("tmp/terminal-colors/ui-result.json"),
    JSON.stringify(results, null, 2),
  );
  console.log(
    JSON.stringify({ passed: true, probes: results, rendererErrors: errors }),
  );
  passed = true;
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
  } else console.error("Test fixture retained:", root);
}
