import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import {
  nextOccurrence,
  localDate,
  availableToday,
} from "../src/shared/task-schedule";

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "benchdesk-recurring-"));
  let date = new Date(2030, 2, 30, 12);
  const path = join(root, "test.sqlite");
  const store = new Store(path, () => date);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const companyId = store.saveCompany({ name: "Test", workspacePath: root });
  const projectId = store.saveProject({ companyId, name: "Taken" });
  const make = (values: any = {}) =>
    store.saveTask({
      companyId,
      projectId,
      title: "25 DM’s",
      kind: "human",
      recurrence: "daily",
      scheduledDate: "2030-03-30",
      definitionDone: "25 berichten verstuurd",
      ...values,
    });
  return {
    store,
    make,
    path,
    companyId,
    projectId,
    setDay: (day: string) => {
      date = new Date(`${day}T12:00:00`);
    },
  };
}

test("dagelijks: vandaag klaar, morgen dezelfde taak met lege criteria; geschiedenis en backups behouden", (t) => {
  const f = fixture(t),
    id = f.make();
  const criterion = f.store.task(id).criteria[0];
  f.store.reviewCriterion(id, criterion.id, {
    checked: true,
    comment: "Uitgevoerd",
  });
  f.store.completeTask(id, "25 verzonden");
  f.store.completeTask(id, "dubbele klik");
  assert.equal(f.store.task(id).nextOccurrenceDate, "2030-03-31");
  assert.equal(f.store.snapshot().tasks[0].status, "done");
  assert.equal(f.store.taskHistory(id).length, 1);
  assert.equal(f.store.taskHistory(id)[0].summary, "25 verzonden");
  f.setDay("2030-03-31");
  assert.equal(f.store.snapshot().tasks[0].status, "todo");
  assert.equal(f.store.task(id).criteria[0].checked, false);
  assert.equal(f.store.task(id).criteria[0].comment, "");
  assert.equal(f.store.task(id).resultSummary, "");
  assert.equal(f.store.taskHistory(id)[0].criteria[0].checked, true);
  assert.equal(f.store.refreshRecurringTasks(), 0);
  f.store.completeTask(id, "Nogmaals 25");
  const backup = f.store.export();
  f.store.restore(backup);
  assert.equal(f.store.taskHistory(id).length, 2);
  assert.equal(f.store.task(id).nextOccurrenceDate, "2030-04-01");
});

test("wekelijks blijft op de gekozen weekdag; gemiste dagen maken geen stapel taken", (t) => {
  const f = fixture(t),
    id = f.make({ recurrence: "weekly" });
  f.store.completeTask(id, "Week klaar");
  assert.equal(f.store.task(id).nextOccurrenceDate, "2030-04-06");
  f.setDay("2030-04-05");
  assert.equal(f.store.snapshot().tasks[0].status, "done");
  f.setDay("2030-04-20");
  assert.equal(f.store.snapshot().tasks[0].status, "todo");
  assert.equal(f.store.snapshot().tasks.length, 1);
  f.store.completeTask(id, "Later afgerond");
  assert.equal(f.store.task(id).nextOccurrenceDate, "2030-04-27");
  assert.equal(f.store.taskHistory(id).length, 2);
});

test("daggrenzen, zomer-/wintertijd, schrikkeldag en jaareinde volgen kalenderdagen", () => {
  assert.equal(localDate(new Date(2030, 0, 1, 0, 5)), "2030-01-01");
  assert.equal(
    nextOccurrence("2028-02-28", "daily", "2028-02-28"),
    "2028-02-29",
  );
  assert.equal(
    nextOccurrence("2028-12-31", "daily", "2028-12-31"),
    "2029-01-01",
  );
  assert.equal(
    nextOccurrence("2030-03-30", "daily", "2030-03-30"),
    "2030-03-31",
  );
  assert.equal(
    nextOccurrence("2030-10-26", "weekly", "2030-10-26"),
    "2030-11-02",
  );
  assert.equal(
    nextOccurrence("2030-04-10", "weekly", "2030-04-01"),
    "2030-04-17",
  );
});

test("eenmalige plandatum wordt niet heropend; ongeldige datums en backups worden geweigerd", (t) => {
  const f = fixture(t),
    id = f.make({ recurrence: "none", scheduledDate: "2030-04-02" });
  assert.equal(availableToday(f.store.task(id), "2030-04-01"), false);
  assert.equal(availableToday(f.store.task(id), "2030-04-02"), true);
  assert.throws(() => f.make({ scheduledDate: "2030-02-30" }), /geldige datum/);
  f.store.completeTask(id, "Eenmalig klaar");
  f.setDay("2030-05-01");
  assert.equal(f.store.snapshot().tasks[0].status, "done");
  const bad = f.store.export();
  bad.data.taskCompletions[0].taskId = "00000000-0000-4000-8000-000000000000";
  assert.throws(() => f.store.restore(bad), /taakuitvoering/);
  assert.equal(f.store.taskHistory(id).length, 1);
});

test("planning wijzigen, handmatig heropenen en herhaling uitschakelen wissen eerdere uitvoeringen niet", (t) => {
  const f = fixture(t),
    id = f.make();
  f.store.completeTask(id, "Klaar");
  f.store.patchTask(id, { status: "todo" });
  assert.equal(f.store.task(id).nextOccurrenceDate, "");
  f.store.completeTask(id, "Herzien");
  assert.equal(f.store.taskHistory(id).length, 1);
  f.store.patchTask(id, { recurrence: "weekly" });
  assert.equal(f.store.task(id).nextOccurrenceDate, "2030-04-06");
  f.store.patchTask(id, { recurrence: "none" });
  f.setDay("2030-04-06");
  assert.equal(f.store.snapshot().tasks[0].status, "done");
  assert.equal(f.store.taskHistory(id).length, 1);
});

test("schema 6 migreert zonder oude taken opnieuw in te plannen; oude backup blijft importeerbaar", (t) => {
  const f = fixture(t),
    id = f.make({ recurrence: "none", scheduledDate: "" });
  const old = f.store.export() as any;
  old.version = 5;
  delete old.data.taskCompletions;
  for (const task of old.data.tasks) {
    delete task.recurrence;
    delete task.scheduledDate;
    delete task.nextOccurrenceDate;
  }
  f.store.restore(old);
  assert.equal(f.store.task(id).recurrence, "none");
  f.store.sql.exec(
    "DROP TABLE task_completions; ALTER TABLE tasks DROP COLUMN recurrence; ALTER TABLE tasks DROP COLUMN scheduled_date; ALTER TABLE tasks DROP COLUMN next_occurrence_date; PRAGMA user_version=6;",
  );
  const migrated = new Store(f.path);
  try {
    assert.equal(migrated.task(id).recurrence, "none");
    assert.equal(migrated.sql.pragma("user_version", { simple: true }), 9);
  } finally {
    migrated.close();
  }
});

test("oude agents kunnen de volgende uitvoering niet overschrijven", (t) => {
  const f = fixture(t),
    id = f.make({ kind: "ai" });
  const sid = f.store.createSession({
    companyId: f.companyId,
    taskId: id,
    provider: "codex",
    mode: "work",
    cwd: tmpdir(),
    outputDir: tmpdir(),
    token: "fixture",
  });
  f.store.completeTask(id, "klaar");
  f.setDay("2030-03-31");
  f.store.snapshot();
  assert.throws(
    () => f.store.agentCall(sid, "report_progress", { summary: "late update" }),
    /afgeronde uitvoering/,
  );
  assert.throws(
    () => f.store.agentCall(sid, "submit_result", { summary: "late update" }),
    /afgeronde uitvoering/,
  );
  assert.equal(f.store.task(id).status, "todo");
});

test("statuswijzigingen via bewerken plannen ook een volgende uitvoering; verplaatsen naar een toekomstige startdatum maakt die uitvoering weer leeg", (t) => {
  const f = fixture(t),
    id = f.make();
  const criterion = f.store.task(id).criteria[0];
  f.store.reviewCriterion(id, criterion.id, { checked: true });
  f.store.patchTask(id, { status: "done" });
  assert.equal(f.store.task(id).nextOccurrenceDate, "2030-03-31");
  assert.equal(f.store.taskHistory(id).length, 1);
  f.store.patchTask(id, { scheduledDate: "2030-04-10" });
  assert.equal(f.store.task(id).status, "todo");
  assert.equal(f.store.task(id).scheduledDate, "2030-04-10");
  assert.equal(f.store.task(id).criteria[0].checked, false);
  assert.equal(f.store.taskHistory(id)[0].criteria[0].checked, true);
});

test("een nieuwe service heropent een verlopen herhaling zonder dubbele uitvoeringen", (t) => {
  const f = fixture(t),
    id = f.make();
  f.store.completeTask(id, "Vandaag klaar");
  const restarted = new Store(f.path, () => new Date(2030, 3, 3, 12));
  try {
    assert.equal(
      restarted.snapshot().tasks.find((t) => t.id === id)?.status,
      "todo",
    );
    assert.equal(restarted.refreshRecurringTasks(), 0);
    assert.equal(restarted.taskHistory(id).length, 1);
  } finally {
    restarted.close();
  }
});
