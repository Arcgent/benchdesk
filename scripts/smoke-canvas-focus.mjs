import assert from "node:assert/strict";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = await mkdtemp(join(tmpdir(), "benchdesk-focus-"));
const dataDir = join(root, "data"),
  workspace = join(root, "work");
await mkdir(dataDir);
await mkdir(workspace);
const shots = resolve("tmp/canvas-focus");
await mkdir(shots, { recursive: true });
const env = { ...process.env, WERK_DATA_DIR: dataDir, WERK_TEST_HIDDEN: "1" };
for (const key of [
  "ELECTRON_RUN_AS_NODE",
  "WERK_SOCKET",
  "WERK_SESSION_ID",
  "WERK_SESSION_TOKEN",
  "WERK_LAUNCH_FILE",
])
  delete env[key];
const app = await electron.launch({
  ...(process.env.WERK_TEST_EXECUTABLE
    ? { executablePath: process.env.WERK_TEST_EXECUTABLE, args: [] }
    : { args: [resolve(".")] }),
  env,
});
const ids = [];
let call, pid;
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForFunction(() => !!window.werk);
  call = (method, params = {}) =>
    page.evaluate(({ method, params }) => window.werk.call(method, params), {
      method,
      params,
    });
  const companyId = await call("company.save", {
    value: { name: "Focus test", workspacePath: workspace },
  });
  for (let i = 0; i < 2; i++)
    ids.push(
      await call("session.start", {
        companyId,
        provider: "shell",
        mode: "work",
      }),
    );
  await page.evaluate(
    ({ companyId, ids }) => {
      localStorage.setItem(
        "werk-workspace-v2",
        JSON.stringify({
          activeCompanyId: companyId,
          panes: ids,
          split: true,
          workspaceMode: "canvas",
          canvasFocus: ids[0],
          canvas: {
            type: "split",
            dir: "row",
            ratio: 0.5,
            a: { type: "leaf", id: ids[0] },
            b: { type: "leaf", id: ids[1] },
          },
        }),
      );
      localStorage.setItem("benchdesk-conversation-view", "terminal");
    },
    { companyId, ids },
  );
  await page.reload();
  await page.getByRole("button", { name: /^(Aan het werk|At work)/ }).click();
  const panes = page.locator('[data-test="pro-canvas-pane"]');
  await panes.nth(1).waitFor();
  const initial = await panes.evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect()),
  );
  assert.equal(
    Math.round(initial[1].x - (initial[0].x + initial[0].width)),
    8,
    "There is an 8px gutter between terminals",
  );
  const focusId = () =>
    page.locator(".rz-pane[data-focused]").getAttribute("data-session-id");
  const geometry = () =>
    panes.evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height];
      }),
    );
  // Rustig ("standaard"): a light-green 2px frame and a green-tinted header. shadcn (the default design): the
  // 1px ring colour plus a 3px focus ring, a quiet grey header tint. Both: one frame, contours stay, no resize.
  const expected = {
    standaard: {
      frame: { light: "rgb(119, 201, 148)", dark: "rgb(119, 201, 148)", width: "2px" },
      radius: "9px",
      head: { light: "rgb(245, 245, 245)", dark: "rgb(42, 42, 42)" },
    },
    shadcn: {
      frame: { light: "rgb(161, 161, 161)", dark: "rgb(115, 115, 115)", width: "1px" },
      radius: "10px",
      head: { light: "rgb(255, 255, 255)", dark: "rgb(10, 10, 10)" },
    },
  };
  for (const design of ["standaard", "shadcn"])
  for (const theme of ["light", "dark"]) {
    const want = expected[design];
    await page.evaluate(({ theme, design }) => {
      localStorage.setItem("benchdesk-theme", theme);
      document.documentElement.dataset.theme = theme;
      document.body.dataset.theme = theme;
      document.documentElement.dataset.design = design;
      window.dispatchEvent(new Event("benchdesk-theme"));
    }, { theme, design });
    const inactivePane = page.locator(
      `.rz-pane[data-session-id="${ids[0]}"]`,
    );
    const activePane = page.locator(
      `.rz-pane[data-session-id="${ids[1]}"]`,
    );
    const before = await geometry();
    await inactivePane.locator(".xterm-helper-textarea").focus();
    assert.equal(
      await focusId(),
      ids[0],
      "Keyboard focus follows the actual terminal",
    );
    await activePane
      .locator(".xterm-screen")
      .click({ position: { x: 100, y: 25 } });
    assert.equal(await focusId(), ids[1], "Click moves the active frame");
    assert.equal(await page.locator(".rz-pane[data-focused]").count(), 1);
    await page.waitForTimeout(200); // let the 150ms header tint transition settle
    const frame = await activePane.evaluate((el) => {
      const s = getComputedStyle(el, "::after");
      return {
        color: s.borderTopColor,
        width: s.borderTopWidth,
        pointerEvents: s.pointerEvents,
      };
    });
    assert.deepEqual(frame, {
      color: want.frame[theme],
      width: want.frame.width,
      pointerEvents: "none",
    });
    assert.equal(
      await inactivePane
        .evaluate((el) => getComputedStyle(el, "::after").content),
      "none",
    );
    const inactive = await inactivePane.evaluate((el) => {
      const s = getComputedStyle(el, "::before");
      return { width: s.borderTopWidth, radius: s.borderTopLeftRadius };
    });
    assert.deepEqual(inactive, { width: "1px", radius: want.radius });
    const activeHead = await activePane
      .locator(".rz-pane__head")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    const inactiveHead = await inactivePane
      .locator(".rz-pane__head")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.equal(inactiveHead, want.head[theme]);
    assert.notEqual(
      activeHead,
      inactiveHead,
      "The active header gets a subtle tint",
    );
    assert.deepEqual(
      await geometry(),
      before,
      "The frame must not resize terminals",
    );
    await page.screenshot({ path: join(shots, `${design}-${theme}.png`) });
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS: 8px gutters, permanent pane contours and exactly one active frame (Rustig light-green, shadcn ring); mouse and keyboard focus, both themes, no resize or input interception",
  );
} finally {
  if (call)
    for (const id of ids) {
      try {
        await call("session.stop", { id });
      } catch {}
    }
  try {
    pid = Number(await readFile(join(dataDir, "runner.pid"), "utf8"));
  } catch {}
  await app.close();
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  await rm(root, { recursive: true, force: true });
}
