import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "benchdesk-suggestions-"));
  const store = new Store(join(root, "state.sqlite"));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const companyId = store.saveCompany({ name: "A", workspacePath: root });
  const other = store.saveCompany({ name: "B", workspacePath: root });
  const projectId = store.saveProject({ name: "Cold email", companyId });
  const goalId = store.saveGoal({
    companyId,
    title: "12 gesprekken",
    target: 12,
    unit: "gesprekken",
  });
  const input = {
    companyId,
    taskId: null,
    provider: "codex" as const,
    mode: "suggestions" as const,
    cwd: root,
    outputDir: root,
    token: "test",
  };
  const sid = store.createSession(input);
  const payload = {
    summary: "Drie concrete vervolgstappen",
    actions: [
      "Doelgroep valideren",
      "Openingen vergelijken",
      "Reacties onderzoeken",
    ].map((title) => ({
      task: { title, projectId, goalId },
      reason: "Helpt passende gesprekken te krijgen.",
      evidence: ["Bedrijfsdoel: 12 gesprekken"],
    })),
  };
  return {
    store,
    root,
    companyId,
    other,
    projectId,
    goalId,
    sid,
    input,
    payload,
  };
}

test("three suggestions stay drafts; individual decisions persist and cannot create duplicate tasks", (t) => {
  const { store, root, sid, payload } = fixture(t);
  const { proposalId } = store.proposeNextActions(sid, payload);
  assert.equal(store.snapshot().tasks.length, 0);
  const result = store.decideSuggestion(proposalId, 0, true);
  assert.equal(store.task(result.taskId!).title, payload.actions[0].task.title);
  assert.equal(store.task(result.taskId!).status, "todo");
  assert.throws(
    () => store.decideSuggestion(proposalId, 0, true),
    /al verwerkt/,
  );
  store.decideSuggestion(proposalId, 1, false);
  const backup = store.export();
  assert.equal(backup.version, 9);
  store.restore(backup);
  const reopened = new Store(join(root, "state.sqlite"));
  try {
    const p = reopened.snapshot().proposals.find((p) => p.id === proposalId)!;
    assert.equal(p.status, "pending");
    assert.deepEqual(p.payload.decisions, { 0: "accepted", 1: "dismissed" });
    assert.equal(p.payload.createdTasks[0], result.taskId);
    assert.equal(reopened.snapshot().tasks.length, 1);
    reopened.decideSuggestion(proposalId, 2, false);
    assert.equal(reopened.snapshot().proposals[0].status, "accepted");
  } finally {
    reopened.close();
  }
});

test("suggestions require three distinct new tasks and company-scoped projects, goals and dependencies", (t) => {
  const f = fixture(t),
    { store, sid, payload, other, companyId, projectId } = f;
  assert.throws(() =>
    store.proposeNextActions(sid, {
      ...payload,
      actions: payload.actions.slice(0, 2),
    }),
  );
  assert.throws(
    () =>
      store.proposeNextActions(sid, {
        ...payload,
        actions: [payload.actions[0], payload.actions[0], payload.actions[2]],
      }),
    /verschillende/,
  );
  const foreignProject = store.saveProject({
    name: "Private",
    companyId: other,
  });
  const foreignGoal = store.saveGoal({
    title: "Private goal",
    companyId: other,
    target: 3,
    unit: "deals",
  });
  const foreignTask = store.saveTask({
    title: "Private task",
    companyId: other,
    projectId: foreignProject,
  });
  for (const replacement of [
    { projectId: foreignProject },
    { goalId: foreignGoal },
    { dependencies: [foreignTask] },
  ]) {
    const bad = structuredClone(payload);
    Object.assign(bad.actions[0].task, replacement);
    assert.throws(() => store.proposeNextActions(sid, bad));
  }
  store.saveTask({
    companyId,
    projectId,
    title: payload.actions[0].task.title.toUpperCase(),
  });
  assert.throws(() => store.proposeNextActions(sid, payload), /bestaat al/);
  assert.equal(store.snapshot().proposals.length, 0);
});

test("latest request wins and previous cards are preserved until a valid replacement arrives", (t) => {
  const { store, sid, input, payload } = fixture(t);
  const first = store.proposeNextActions(sid, payload);
  assert.throws(() => store.proposeNextActions(sid, payload), /al drie/);
  const newer = store.createSession(input);
  assert.throws(() => store.proposeNextActions(sid, payload), /nieuwere/);
  assert.equal(store.snapshot().proposals[0].status, "pending");
  assert.throws(() =>
    store.proposeNextActions(newer, { ...payload, actions: [] }),
  );
  assert.equal(store.snapshot().proposals[0].status, "pending");
  store.proposeNextActions(newer, payload);
  assert.equal(
    store.snapshot().proposals.find((p) => p.id === first.proposalId)!.status,
    "dismissed",
  );
  assert.throws(
    () => store.decideSuggestion(first.proposalId, 0, true),
    /beschikbaar/,
  );
});

test("AI receives the company's goals and session memories without another company's data", (t) => {
  const { store, input, sid, other, companyId, projectId } = fixture(t);
  const own = store.createSession({ ...input, mode: "work" });
  const foreign = store.createSession({
    ...input,
    companyId: other,
    mode: "work",
  });
  for (const [session, summary] of [
    [own, "Eigen inzichten"],
    [foreign, "Geheim van B"],
  ])
    store.saveSessionMemory(
      session,
      { summary, completed: [], decisions: [], blockers: [], nextSteps: [] },
      0,
      "assistant",
    );
  store.saveTask({ companyId, projectId, title: "Bestaand werk" });
  const context = store.context(sid);
  assert.equal(context.goals.length, 1);
  assert.equal(context.tasks.length, 1);
  assert.equal(context.companySessionMemories?.length, 1);
  assert.equal(
    context.companySessionMemories?.[0].memory?.summary,
    "Eigen inzichten",
  );
  assert.ok(!JSON.stringify(context).includes("Geheim van B"));
});

test("backup rejects foreign suggestion references before replacing stored data", (t) => {
  const { store, sid, payload, other } = fixture(t);
  store.proposeNextActions(sid, payload);
  const otherProject = store.saveProject({
    name: "B project",
    companyId: other,
  });
  const backup = store.export();
  const bad: any = structuredClone(backup);
  bad.data.proposals[0].payload.actions[0].task.projectId = otherProject;
  assert.throws(() => store.restore(bad));
  assert.deepEqual(store.export().data, backup.data);
});
