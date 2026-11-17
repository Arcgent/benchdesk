import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "benchdesk-pro-"));
  const store = new Store(join(root, "state.sqlite"));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const companyId = store.saveCompany({
    name: "Studio",
    workspacePath: root,
    product: "Productcontext",
  });
  const other = store.saveCompany({
    name: "Ander bedrijf",
    workspacePath: root,
  });
  const projectId = store.saveProject({
    companyId,
    name: "Sales",
    description: "Projectcontext",
  });
  const goalId = store.saveGoal({
    companyId,
    title: "Gesprekken",
    current: 5,
    target: 12,
    unit: "gesprekken",
  });
  const foreignGoal = store.saveGoal({
    companyId: other,
    title: "Ander doel",
    current: 1,
    target: 10,
  });
  const taskId = store.saveTask({
    companyId,
    projectId,
    title: "Campagne",
    description: "Opdrachtcontext",
    definitionDone: "Criterium",
    criteria: [
      {
        id: "criterion",
        text: "Drie varianten",
        checked: false,
        comment: "",
        agentNote: "",
        evidence: null,
      },
    ],
  });
  store.saveTask({ companyId, projectId, title: "Andere taak" });
  const start = (contextOptions?: any, resumeFrom?: string) =>
    store.createSession({
      companyId,
      taskId,
      provider: "codex",
      mode: "work",
      cwd: root,
      outputDir: root,
      token: "test",
      contextOptions,
      resumeFrom,
    });
  return { store, root, companyId, goalId, foreignGoal, taskId, start };
}

test("selected context is persisted, applied to work, and retained on resume", (t) => {
  const { store, start, taskId } = fixture(t);
  const sid = start({ assignment: true, criteria: false, business: false });
  const context = store.context(sid);
  assert.equal(context.task?.description, "Opdrachtcontext");
  assert.deepEqual(context.task?.criteria, []);
  assert.equal(context.task?.definitionDone, "");
  assert.equal(context.company.product, "");
  assert.deepEqual(context.goals, []);
  assert.deepEqual(
    context.tasks.map((t) => t.id),
    [taskId],
  );
  assert.equal(context.projects[0].description, "");
  const resumed = start(undefined, sid);
  assert.deepEqual(store.session(resumed).contextOptions, {
    assignment: true,
    criteria: false,
    business: false,
  });
  store.restore(store.export());
  assert.equal(store.context(resumed).company.product, "");
  const noAssignment = store.context(
    start({ assignment: false, criteria: true, business: true }),
  );
  assert.equal(noAssignment.task?.description, "");
  assert.equal(noAssignment.task?.criteria.length, 1);
  assert.equal(noAssignment.company.product, "Productcontext");
  const full = store.context(start());
  assert.equal(full.tasks.length, 2);
  assert.equal(full.task?.criteria.length, 1);
});

test("check-ins preserve measurements at that moment and rollback invalid updates", (t) => {
  const { store, companyId, goalId, foreignGoal, start } = fixture(t);
  start();
  store.checkin(companyId, "Eerste week", [{ goalId, current: 7 }]);
  store.checkin(companyId, "Tweede week", [{ goalId, current: 9 }]);
  const snap = store.snapshot();
  assert.deepEqual(
    snap.checkins.find((c) => c.note === "Eerste week")?.measurements,
    [{ goalId, title: "Gesprekken", before: 5, after: 7, unit: "gesprekken" }],
  );
  assert.equal(
    snap.checkins.find((c) => c.note === "Tweede week")?.measurements?.[0]
      .before,
    7,
  );
  assert.throws(() =>
    store.checkin(companyId, "Ongeldig", [
      { goalId, current: 11 },
      { goalId: foreignGoal, current: 3 },
    ]),
  );
  assert.equal(store.snapshot().goals.find((g) => g.id === goalId)?.current, 9);
  assert.equal(store.snapshot().checkins.length, 2);
  const backup = store.export();
  store.restore(backup);
  assert.deepEqual(store.snapshot().checkins, snap.checkins);
  const bad = structuredClone(backup);
  bad.data.checkins[0].measurements![0].goalId = foreignGoal;
  assert.throws(() => store.restore(bad), /check-indoel/);
  assert.deepEqual(store.snapshot().checkins, snap.checkins);
  const legacy: any = structuredClone(backup);
  legacy.version = 4;
  for (const c of legacy.data.checkins) delete c.measurements;
  for (const s of legacy.data.sessions) delete s.contextOptions;
  store.restore(legacy);
  assert.deepEqual(store.snapshot().checkins[0].measurements, []);
  assert.deepEqual(store.snapshot().sessions[0].contextOptions, {
    assignment: true,
    criteria: true,
    business: true,
  });
});

test("schema 5 upgrades existing sessions and check-ins without fabricated history", (t) => {
  const { store, root, companyId, goalId, start } = fixture(t);
  const sid = start();
  store.checkin(companyId, "Oude notitie", [{ goalId, current: 6 }]);
  store.sql.exec(
    "ALTER TABLE sessions DROP COLUMN context_options; ALTER TABLE checkins DROP COLUMN measurements; PRAGMA user_version = 5;",
  );
  const migrated = new Store(join(root, "state.sqlite"));
  try {
    assert.equal(migrated.sql.pragma("user_version", { simple: true }), 9);
    assert.deepEqual(migrated.session(sid).contextOptions, {
      assignment: true,
      criteria: true,
      business: true,
    });
    assert.equal(migrated.snapshot().checkins[0].note, "Oude notitie");
    assert.deepEqual(migrated.snapshot().checkins[0].measurements, []);
    assert.equal(
      migrated.snapshot().goals.find((g) => g.id === goalId)?.current,
      6,
    );
  } finally {
    migrated.close();
  }
});
