import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store";

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "benchdesk-memory-"));
  const store = new Store(join(root, "state.sqlite"));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const companyId = store.saveCompany({ name: "A", workspacePath: root });
  const other = store.saveCompany({ name: "B", workspacePath: root });
  const projectId = store.saveProject({ name: "Project", companyId });
  const taskId = store.saveTask({ title: "Campagne", companyId, projectId });
  const input = {
    companyId,
    taskId,
    provider: "claude" as const,
    mode: "work" as const,
    cwd: root,
    outputDir: root,
    token: "test",
  };
  const sid = store.createSession(input);
  return { store, root, companyId, other, taskId, sid, input };
}
const note = {
  summary: "Drie varianten geschreven; verzending nog niet ingepland.",
  completed: ["Varianten geschreven"],
  decisions: ["Eerst akkoord op de doelgroep"],
  nextSteps: ["Doelgroep bespreken"],
  blockers: ["Akkoord ontbreekt"],
};

test("session memory persists, is scoped, is resumable and does not complete a task", (t) => {
  const f = fixture(t);
  const memory: any = f.store.agentCall(f.sid, "save_session_memory", {
    ...note,
    expectedRevision: 0,
  });
  assert.equal(memory.revision, 1);
  assert.equal(f.store.task(f.taskId).status, "todo");
  assert.deepEqual(f.store.context(f.sid).sessionMemory, memory);
  const resumed = f.store.createSession({ ...f.input, resumeFrom: f.sid });
  assert.equal(f.store.session(resumed).resumeFrom, f.sid);
  assert.deepEqual(f.store.context(resumed).sessionMemory, memory);
  const unrelated = f.store.createSession({
    ...f.input,
    companyId: f.other,
    taskId: null,
  });
  assert.equal(f.store.context(unrelated).sessionMemory, null);
  assert.deepEqual(f.store.context(unrelated).relatedSessionMemories, []);
  const sameTask = f.store.createSession(f.input);
  assert.ok(
    f.store
      .context(sameTask)
      .relatedSessionMemories.some((s) => s.sessionId === f.sid),
  );
  assert.throws(
    () =>
      f.store.createSession({
        ...f.input,
        companyId: f.other,
        taskId: null,
        resumeFrom: f.sid,
      }),
    /notities/,
  );
  const reopened = new Store(join(f.root, "state.sqlite"));
  try {
    assert.deepEqual(reopened.session(resumed).memory, memory);
  } finally {
    reopened.close();
  }
});
test("manual corrections use revision checks and cannot silently be overwritten by the assistant", (t) => {
  const { store, sid } = fixture(t);
  store.saveSessionMemory(sid, note, 0, "assistant");
  store.saveSessionMemory(
    sid,
    { ...note, decisions: ["Gebruiker kiest doelgroep B"] },
    1,
    "user",
  );
  assert.throws(
    () =>
      store.agentCall(sid, "save_session_memory", {
        ...note,
        expectedRevision: 1,
      }),
    /ondertussen gewijzigd/,
  );
  assert.throws(() => store.confirmSessionMemory(sid, 1), /actuele/);
  assert.equal(store.session(sid).memory?.source, "user");
  assert.equal(
    store.session(sid).memory?.decisions[0],
    "Gebruiker kiest doelgroep B",
  );
  assert.throws(() =>
    store.saveSessionMemory(
      sid,
      { ...note, summary: "x".repeat(1201) },
      2,
      "assistant",
    ),
  );
});
test("Stop requests a missing checkpoint once, never loops, and no-change confirmation is cheap", (t) => {
  const { store, sid } = fixture(t);
  let at = Date.now();
  const hook = (name: string, extra = {}) =>
    store.hook(sid, { id: randomUUID(), name, at: ++at, ...extra });
  hook("UserPromptSubmit");
  assert.ok(hook("Stop")?.memoryReminder);
  assert.equal(store.session(sid).state, "working");
  assert.equal(hook("Stop")?.memoryReminder, undefined);
  assert.equal(store.session(sid).state, "idle");
  store.agentCall(sid, "save_session_memory", { ...note, expectedRevision: 0 });
  assert.equal(store.session(sid).memoryDirty, false);
  hook("PostToolUse", {
    toolName: "mcp__werk_task_context__save_session_memory",
  });
  assert.equal(store.session(sid).memoryDirty, false);
  hook("UserPromptSubmit");
  assert.equal(store.session(sid).memoryDirty, true);
  store.agentCall(sid, "confirm_session_memory", { expectedRevision: 1 });
  assert.equal(hook("Stop")?.memoryReminder, undefined);
  assert.equal(store.session(sid).memory?.revision, 1);
  hook("PostToolUse", { toolName: "Edit" });
  assert.equal(store.session(sid).memoryDirty, true);
  assert.equal(
    hook("Stop", { stopHookActive: true })?.memoryReminder,
    undefined,
  );
  hook("UserPromptSubmit");
  assert.ok(hook("Stop")?.memoryReminder);
});
test("interrupted turns retain the previous checkpoint and remain visibly pending", (t) => {
  const { store, sid } = fixture(t);
  store.saveSessionMemory(sid, note, 0, "assistant");
  store.hook(sid, {
    id: randomUUID(),
    name: "UserPromptSubmit",
    at: Date.now(),
  });
  store.recover();
  assert.equal(store.session(sid).memoryDirty, true);
  assert.equal(store.session(sid).memory?.summary, note.summary);
  assert.equal(store.session(sid).state, "interrupted");
});
test("memory survives backup and rejects cross-company or circular resume ancestry", (t) => {
  const { store, sid, input, other } = fixture(t);
  store.saveSessionMemory(sid, note, 0, "assistant");
  const resumed = store.createSession({ ...input, resumeFrom: sid });
  const otherSid = store.createSession({
    ...input,
    companyId: other,
    taskId: null,
  });
  const backup = store.export();
  store.restore(backup);
  assert.equal(store.session(resumed).memory?.summary, note.summary);
  const bad = structuredClone(backup);
  bad.data.sessions.find((s) => s.id === resumed)!.resumeFrom = otherSid;
  assert.throws(() => store.restore(bad), /ongeldig hervat/);
  bad.data.sessions.find((s) => s.id === resumed)!.resumeFrom = resumed;
  assert.throws(() => store.restore(bad), /ongeldig hervat/);
  assert.equal(store.session(resumed).memory?.revision, 1);
});
test("shell notes are supported; login sessions cannot become work memories", (t) => {
  const { store, input } = fixture(t);
  const shell = store.createSession({
    ...input,
    provider: "shell",
    taskId: null,
  });
  store.saveSessionMemory(shell, note, 0, "user");
  assert.equal(store.context(shell).sessionMemory?.source, "user");
  const login = store.createSession({ ...input, purpose: "login" });
  assert.throws(
    () => store.saveSessionMemory(login, note, 0, "assistant"),
    /Inloggesprekken/,
  );
  assert.equal(
    store.hook(login, { id: randomUUID(), name: "Stop", at: Date.now() })
      ?.memoryReminder,
    undefined,
  );
});

test("version 2 databases gain memory fields without losing existing work or inventing notes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "benchdesk-memory-migration-"));
  const path = join(root, "state.sqlite");
  let store = new Store(path);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const companyId = store.saveCompany({
    name: "Bestaand bedrijf",
    workspacePath: root,
  });
  const sid = store.createSession({
    companyId,
    taskId: null,
    provider: "claude",
    mode: "work",
    cwd: root,
    outputDir: root,
    token: "test",
    providerSessionId: "existing-conversation",
  });
  for (const column of [
    "memory",
    "memory_dirty",
    "memory_reminded",
    "resume_from",
  ])
    store.sql.exec(`ALTER TABLE sessions DROP COLUMN ${column}`);
  store.sql.pragma("user_version = 2");
  store.close();
  store = new Store(path);
  assert.equal(store.session(sid).providerSessionId, "existing-conversation");
  assert.equal(store.session(sid).memory, null);
  assert.equal(store.company(companyId).name, "Bestaand bedrijf");
  assert.equal(store.sql.pragma("user_version", { simple: true }), 9);
  const legacy = store.export();
  legacy.version = 1;
  for (const s of legacy.data.sessions as any[]) {
    delete s.memory;
    delete s.memoryDirty;
    delete s.resumeFrom;
  }
  store.restore(legacy);
  assert.equal(store.session(sid).memory, null);
});

test("resuming an older session row takes the newest checkpoint of that exact provider conversation", (t) => {
  const { store, input, sid } = fixture(t);
  store.setSession(sid, { providerSessionId: "same-conversation" });
  store.saveSessionMemory(sid, note, 0, "assistant");
  const child = store.createSession({
    ...input,
    providerSessionId: "same-conversation",
    resumeFrom: sid,
  });
  store.saveSessionMemory(
    child,
    { ...note, summary: "Nieuwe beslissing in het vervolg" },
    1,
    "assistant",
  );
  const resumed = store.createSession({
    ...input,
    providerSessionId: "same-conversation",
    resumeFrom: sid,
  });
  assert.equal(
    store.session(resumed).memory?.summary,
    "Nieuwe beslissing in het vervolg",
  );
  assert.equal(store.session(resumed).resumeFrom, child);
});
