import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "benchdesk-departments-"));
  const store = new Store(join(root, "state.sqlite"));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const companyId = store.saveCompany({ name: "A", workspacePath: root });
  const other = store.saveCompany({ name: "B", workspacePath: root });
  const projectId = store.saveProject({ name: "Cold email", companyId });
  const taskId = store.saveTask({ title: "Campagne", companyId, projectId });
  const sid = store.createSession({
    companyId,
    taskId,
    provider: "claude",
    mode: "work",
    cwd: root,
    outputDir: root,
    token: "test",
  });
  store.saveSessionMemory(
    sid,
    {
      summary: "Doelgroep gekozen",
      completed: [],
      decisions: ["Dienstverleners"],
      blockers: [],
      nextSteps: ["Copy schrijven"],
    },
    0,
    "assistant",
  );
  return { store, root, companyId, other, projectId, taskId, sid };
}

test("departments belong to a company and have unique names within it", (t) => {
  const { store, companyId, other, sid } = fixture(t);
  const sales = store.saveDepartment({ companyId, name: " Sales " });
  assert.throws(
    () => store.saveDepartment({ companyId, name: "sales" }),
    /al een afdeling/,
  );
  store.saveDepartment({ companyId: other, name: "Sales" });
  assert.throws(
    () => store.saveDepartment({ companyId: other, name: "Marketing" }, sales),
    /niet gevonden/,
  );
  store.saveDepartment(
    { companyId, name: "Acquisitie", description: "Nieuwe klanten" },
    sales,
  );
  assert.deepEqual(
    store.context(sid).departments.map((d) => d.name),
    ["Acquisitie"],
  );
});

test("moving projects between departments preserves tasks and session memory", (t) => {
  const { store, companyId, other, projectId, taskId, sid } = fixture(t);
  const before = store.snapshot();
  const sales = store.saveDepartment({ companyId, name: "Sales" });
  const marketing = store.saveDepartment({ companyId, name: "Marketing" });
  const foreign = store.saveDepartment({ companyId: other, name: "Sales" });
  const move = (departmentId: string | null) =>
    store.saveProject(
      { companyId, name: "Cold email", departmentId },
      projectId,
    );
  assert.throws(() => move(foreign), /hoort niet bij dit bedrijf/);
  move(sales);
  assert.throws(() => store.removeDepartment(sales), /Verplaats eerst/);
  move(marketing);
  store.removeDepartment(sales);
  assert.equal(
    store.snapshot().projects.find((p) => p.id === projectId)?.departmentId,
    marketing,
  );
  move(null);
  store.removeDepartment(marketing);
  assert.deepEqual(
    store.task(taskId),
    before.tasks.find((t) => t.id === taskId),
  );
  assert.deepEqual(
    store.session(sid).memory,
    before.sessions.find((s) => s.id === sid)?.memory,
  );
  assert.equal(store.session(sid).taskId, taskId);
  assert.equal(
    store.snapshot().projects.find((p) => p.id === projectId)?.departmentId,
    null,
  );
});

test("department backups round-trip and reject invalid relations before replacing data", (t) => {
  const { store, companyId, other, projectId, sid } = fixture(t);
  const departmentId = store.saveDepartment({ companyId, name: "Sales" });
  store.saveProject({ companyId, name: "Cold email", departmentId }, projectId);
  const backup = store.export();
  assert.equal(backup.version, 9);
  store.restore(backup);
  assert.equal(store.snapshot().departments[0].id, departmentId);
  assert.equal(store.snapshot().projects[0].departmentId, departmentId);
  assert.equal(store.session(sid).memory?.summary, "Doelgroep gekozen");
  const bad = structuredClone(backup);
  bad.data.departments[0].companyId = other;
  assert.throws(() => store.restore(bad), /Ongeldige afdeling/);
  assert.equal(store.snapshot().departments[0].companyId, companyId);
  const legacy: any = structuredClone(backup);
  legacy.version = 2;
  delete legacy.data.departments;
  for (const p of legacy.data.projects) delete p.departmentId;
  store.restore(legacy);
  assert.deepEqual(store.snapshot().departments, []);
  assert.equal(store.snapshot().projects[0].departmentId, null);
  assert.equal(store.session(sid).memory?.summary, "Doelgroep gekozen");
});

test("schema 3 migrates existing projects without losing tasks or memory", (t) => {
  const { store, root, projectId, taskId, sid } = fixture(t);
  store.sql.exec(
    "ALTER TABLE projects DROP COLUMN department_id; DROP TABLE departments;",
  );
  store.sql.pragma("user_version = 3");
  const upgraded = new Store(join(root, "state.sqlite"));
  try {
    assert.equal(upgraded.sql.pragma("user_version", { simple: true }), 9);
    assert.deepEqual(upgraded.snapshot().departments, []);
    assert.equal(
      upgraded.snapshot().projects.find((p) => p.id === projectId)
        ?.departmentId,
      null,
    );
    assert.equal(upgraded.task(taskId).projectId, projectId);
    assert.equal(upgraded.session(sid).memory?.summary, "Doelgroep gekozen");
  } finally {
    upgraded.close();
  }
});
