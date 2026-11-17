import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  rm,
  realpath,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionFiles } from "../src/core/session-files";
import type { Snapshot } from "../src/shared/types";

async function fixture(t: any, workspaceOutput = false) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "benchdesk-files-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace"),
    output = workspaceOutput ? cwd : join(cwd, ".werk-results", "task");
  await mkdir(output, { recursive: true });
  const snap = {
    sessions: [
      {
        id: "session",
        companyId: "company",
        taskId: "task",
        cwd,
        outputDir: output,
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: new Date().toISOString(),
        alive: true,
      },
    ],
    artifacts: [],
  } as unknown as Snapshot;
  return { root, cwd, output, snap, service: new SessionFiles() };
}

test("discovers legacy result files and modified workspace files, excluding dependencies, hidden files and old documents", async (t) => {
  const { cwd, output, snap, service } = await fixture(t);
  await writeFile(join(output, "draft.md"), "# Draft");
  await writeFile(join(output, "data.csv"), "test");
  await writeFile(join(cwd, "notes.markdown"), "# Notes");
  const old = join(cwd, "old.md");
  await writeFile(old, "old");
  await utimes(old, 1, 1);
  for (const dir of ["node_modules", ".git", ".werk-results/other-task"]) {
    await mkdir(join(cwd, dir), { recursive: true });
    await writeFile(join(cwd, dir, "unrelated.md"), "private");
  }
  await writeFile(join(cwd, ".private.md"), "private");
  const result = await service.list(snap, "session");
  assert.deepEqual(result.files.map((f) => f.name).sort(), [
    "data.csv",
    "draft.md",
    "notes.markdown",
  ]);
  assert.equal(
    result.files.find((f) => f.name === "draft.md")?.source,
    "output",
  );
  assert.equal(
    result.files.find((f) => f.name === "notes.markdown")?.source,
    "workspace",
  );
  assert.equal(result.truncated, false);
  assert.equal(result.unavailable, false);
  assert.equal(await service.authorizes(old), false);
  await assert.rejects(service.list(snap, "missing"), /Gesprek niet gevonden/);
});

test("limits links to the chosen session and exposes shared output honestly, also for free work", async (t) => {
  const { cwd, output, snap, service } = await fixture(t);
  const linked = join(cwd, "submitted.txt");
  await writeFile(linked, "submitted");
  await utimes(linked, 1, 1);
  await writeFile(join(output, "shared.md"), "shared");
  snap.sessions.push({ ...snap.sessions[0], id: "other", taskId: null });
  snap.artifacts.push({
    id: "artifact",
    companyId: "company",
    taskId: "task",
    sessionId: "session",
    path: linked,
    name: "submitted.txt",
    createdAt: new Date().toISOString(),
  });
  assert.equal(
    (await service.list(snap, "session")).files.find((f) => f.path === linked)
      ?.source,
    "linked",
  );
  const free = (await service.list(snap, "other")).files;
  assert.equal(
    free.some((f) => f.path === linked),
    false,
  );
  assert.equal(free.find((f) => f.name === "shared.md")?.source, "output");
});

test("workspace output discovers assets in project folders without including old or later files", async (t) => {
  const { cwd, snap, service } = await fixture(t, true);
  await mkdir(join(cwd, "assets"));
  for (const name of ["image.png", "report.pdf", "video.mp4", "data.csv", "page.html"]) {
    await writeFile(join(cwd, "assets", name), "result");
  }
  const old = join(cwd, "old.pdf");
  await writeFile(old, "old");
  await utimes(old, 1, 1);
  const result = await service.list(snap, "session");
  assert.deepEqual(result.files.map((f) => f.name).sort(), [
    "data.csv", "image.png", "page.html", "report.pdf", "video.mp4",
  ]);
  assert.ok(result.files.every((f) => f.source === "workspace" && f.relativePath.startsWith("assets/")));
  assert.equal(result.unavailable, false);
  assert.equal(await service.authorizes(old), false);
  snap.sessions[0].alive = false;
  snap.sessions[0].updatedAt = new Date(Date.now() - 30_000).toISOString();
  assert.deepEqual((await service.list(snap, "session")).files, []);
});

test("cannot preview arbitrary paths or escape via symlinks, including a replacement after discovery", async (t) => {
  const { root, cwd, output, snap, service } = await fixture(t);
  const outside = join(root, "secret.md");
  await writeFile(outside, "secret");
  await symlink(outside, join(output, "escape.md"));
  await symlink(root, join(cwd, "escape-directory"));
  const safe = join(output, "safe.md");
  await writeFile(safe, "safe");
  assert.deepEqual(
    (await service.list(snap, "session")).files.map((f) => f.name),
    ["safe.md"],
  );
  assert.equal(await service.authorizes(outside), false);
  assert.equal(await service.authorizes(safe), true);
  await rm(safe);
  await symlink(outside, safe);
  assert.equal(await service.authorizes(safe), false);
});

test("ended sessions exclude later workspace changes, missing directories return a usable empty result", async (t) => {
  const { cwd, output, snap, service } = await fixture(t);
  snap.sessions[0].alive = false;
  snap.sessions[0].updatedAt = new Date(Date.now() - 30_000).toISOString();
  await writeFile(join(cwd, "later.md"), "later");
  assert.equal((await service.list(snap, "session")).files.length, 0);
  await rm(cwd, { recursive: true });
  const result = await new SessionFiles().list(snap, "session");
  assert.equal(result.unavailable, true);
  assert.deepEqual(result.files, []);
});

test("an output directory replaced with an external symlink is not indexed", async (t) => {
  const { root, output, snap, service } = await fixture(t);
  const outside = join(root, "elsewhere");
  await mkdir(outside);
  await writeFile(join(outside, "private.md"), "private");
  await rm(output, { recursive: true });
  await symlink(outside, output);
  const result = await service.list(snap, "session");
  assert.equal(result.unavailable, true);
  assert.deepEqual(result.files, []);
});

test("large result lists are bounded and explicitly marked as incomplete", async (t) => {
  const { output, snap, service } = await fixture(t);
  await Promise.all(
    Array.from({ length: 205 }, (_, i) =>
      writeFile(join(output, `result-${i}.md`), "result"),
    ),
  );
  const result = await service.list(snap, "session");
  assert.equal(result.files.length, 200);
  assert.equal(result.truncated, true);
});
