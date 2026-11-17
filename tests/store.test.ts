import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store, focusTasks } from "../src/core/store";

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "werk-store-"));
  const store = new Store(join(root, "state.sqlite"));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const companyId = store.saveCompany({
    name: "Testbedrijf",
    workspacePath: root,
  });
  const otherId = store.saveCompany({
    name: "Ander bedrijf",
    workspacePath: root,
  });
  const goalId = store.saveGoal({
    companyId,
    title: "Meer verkoopgesprekken",
    target: 10,
    primary: true,
  });
  const projectId = store.saveProject({
    companyId,
    name: "Cold email",
    goalId,
  });
  const taskId = store.saveTask({
    companyId,
    projectId,
    goalId,
    title: "Campagne schrijven",
  });
  const sessionId = store.createSession({
    companyId,
    taskId,
    provider: "codex",
    mode: "work",
    cwd: root,
    outputDir: root,
    token: "test-token",
  });
  return {
    root,
    store,
    companyId,
    otherId,
    goalId,
    projectId,
    taskId,
    sessionId,
  };
}

test("legacy sessions direct new results to the workspace and preserve the original result path", (t) => {
  const { root, store, sessionId, taskId } = fixture(t);
  const legacyOutput = join(root, ".werk-results", taskId);
  store.setSession(sessionId, { outputDir: legacyOutput });
  assert.equal(store.context(sessionId).outputDirectory, root);
  assert.equal(store.session(sessionId).outputDir, legacyOutput);
});

test("agentresultaat wacht op beoordeling; bedrijfsresultaat verandert alleen tijdens check-in", (t) => {
  const { root, store, companyId, otherId, goalId, taskId, sessionId } =
    fixture(t);
  const context = store.agentCall(sessionId, "get_task_context", {});
  assert.ok("company" in context);
  assert.equal(context.company.id, companyId);
  assert.ok(context.tasks.every((x: any) => x.companyId !== otherId));
  store.agentCall(sessionId, "report_progress", {
    summary: "Doelgroep uitgewerkt",
  });
  const file = join(root, "campagne.md");
  writeFileSync(file, "# Campagne");
  store.agentCall(sessionId, "submit_result", {
    summary: "Campagne klaar voor beoordeling",
    files: [file],
  });
  assert.equal(store.task(taskId).status, "review");
  assert.equal(store.snapshot().goals.find((g) => g.id === goalId)?.current, 0);
  assert.equal(store.snapshot().artifacts.length, 1);
  store.completeTask(taskId, "Akkoord");
  assert.equal(store.task(taskId).status, "done");
  assert.throws(
    () =>
      store.agentCall(sessionId, "report_progress", { summary: "Late update" }),
    /afgerond/,
  );
  store.checkin(companyId, "Twee gesprekken uit deze campagne", [
    { goalId, current: 2 },
  ]);
  assert.equal(store.snapshot().goals.find((g) => g.id === goalId)?.current, 2);
});

test("mislukte resultaatinzending slaat geen gedeeltelijke resultaten op", (t) => {
  const { root, store, taskId, sessionId } = fixture(t);
  const file = join(root, "voorstel.md");
  writeFileSync(file, "Voorstel");
  assert.throws(() =>
    store.agentCall(sessionId, "submit_result", {
      summary: "Resultaat",
      files: [file, join(root, "ontbreekt.md")],
    }),
  );
  assert.equal(store.snapshot().artifacts.length, 0);
  assert.equal(store.task(taskId).status, "todo");
});

test("een taakmodel blijft bewaard en verwijderen ruimt koppelingen op zonder gesprekken te wissen", (t) => {
  const { store, companyId, projectId, taskId, sessionId, root } = fixture(t);
  store.patchTask(taskId, { provider: "codex", model: "gpt-6-astra" });
  const dependent = store.saveTask({
    companyId,
    projectId,
    title: "Afhankelijke taak",
    dependencies: [taskId],
  });
  const file = join(root, "resultaat.md");
  writeFileSync(file, "resultaat");
  store.addArtifact(taskId, file, sessionId);
  store.event(companyId, taskId, sessionId, "progress", "Bezig");
  assert.equal(store.task(taskId).model, "gpt-6-astra");
  store.removeTask(taskId);
  assert.throws(() => store.task(taskId), /niet gevonden/i);
  assert.equal(store.session(sessionId).taskId, null);
  assert.deepEqual(store.task(dependent).dependencies, []);
  assert.equal(store.snapshot().artifacts.length, 0);
  assert.ok(
    store.snapshot().events
      .filter((event) => event.summary === "Bezig")
      .every((event) => event.taskId === null),
  );
  assert.doesNotThrow(() => store.restore(store.export()));
});

test("afhankelijkheden blokkeren uitvoering en mogen geen cirkel of ander bedrijf bevatten", (t) => {
  const { store, companyId, otherId, projectId, taskId } = fixture(t);
  const next = store.saveTask({
    companyId,
    projectId,
    title: "Campagne versturen",
    dependencies: [taskId],
  });
  assert.throws(
    () => store.patchTask(next, { status: "in_progress" }),
    /afhankelijkheden/,
  );
  assert.throws(
    () => store.patchTask(taskId, { dependencies: [next] }),
    /cirkel/,
  );
  const otherProject = store.saveProject({
    companyId: otherId,
    name: "Ander project",
  });
  assert.throws(
    () => store.patchTask(taskId, { projectId: otherProject }),
    /dit bedrijf/,
  );
  assert.ok(
    !focusTasks(store.snapshot().tasks, companyId).some((x) => x.id === next),
  );
  store.completeTask(taskId, "Goedgekeurd");
  store.patchTask(next, { status: "in_progress" });
  assert.equal(store.task(next).status, "in_progress");
});

test("prioriteiten blijven voorstellen en verouderen na een wijziging", (t) => {
  const { store, companyId, projectId, taskId, sessionId } = fixture(t);
  const pinned = store.saveTask({
    companyId,
    projectId,
    title: "Klant terugbellen",
    pinned: true,
  });
  store.context(sessionId);
  const proposal = store.agentCall(sessionId, "propose_priorities", {
    summary: "Campagne eerst",
    items: [
      {
        taskId,
        reason: "Ondersteunt het verkoopdoel",
        evidence: ["Bedrijfsdoel"],
        confidence: "medium",
      },
    ],
  });
  assert.ok(
    "proposalId" in proposal && typeof proposal.proposalId === "string",
  );
  assert.equal(store.snapshot().proposals[0].status, "pending");
  store.decideProposal(proposal.proposalId, true);
  assert.equal(focusTasks(store.snapshot().tasks, companyId)[0].id, pinned);
  store.context(sessionId);
  const stale = store.agentCall(sessionId, "propose_priorities", {
    summary: "Eerder advies",
    items: [],
  });
  assert.ok("proposalId" in stale && typeof stale.proposalId === "string");
  store.patchTask(taskId, { title: "Aangepaste campagne" });
  assert.throws(
    () => store.decideProposal(stale.proposalId, true),
    /verouderd/,
  );
});

test("acceptatie van prioriteiten maakt een concurrerend ouder voorstel verouderd", (t) => {
  const { store, sessionId } = fixture(t);
  store.context(sessionId);
  const first = store.agentCall(sessionId, "propose_priorities", {
    summary: "A",
    items: [],
  });
  const second = store.agentCall(sessionId, "propose_priorities", {
    summary: "B",
    items: [],
  });
  assert.ok("proposalId" in first && typeof first.proposalId === "string");
  assert.ok("proposalId" in second && typeof second.proposalId === "string");
  store.decideProposal(first.proposalId, true);
  assert.throws(
    () => store.decideProposal(second.proposalId, true),
    /verouderd/,
  );
});

test("een ongeldige check-in rolt alle meetwaarden terug", (t) => {
  const { store, companyId, otherId, goalId } = fixture(t);
  const otherGoal = store.saveGoal({ companyId: otherId, title: "Ander doel" });
  assert.throws(
    () =>
      store.checkin(companyId, "Update", [
        { goalId, current: 5 },
        { goalId: otherGoal, current: 99 },
      ]),
    /dit bedrijf/,
  );
  assert.equal(store.snapshot().goals.find((g) => g.id === goalId)?.current, 0);
  assert.equal(store.snapshot().checkins.length, 0);
});

test("dubbele en late hooks wijzigen de actuele status niet en voltooien geen taken", (t) => {
  const { store, sessionId, taskId } = fixture(t);
  const event = { id: randomUUID(), name: "PermissionRequest", at: 200 };
  store.hook(sessionId, event);
  store.hook(sessionId, { id: randomUUID(), name: "PreToolUse", at: 100 });
  store.hook(sessionId, event);
  assert.equal(store.session(sessionId).state, "waiting");
  store.hook(sessionId, {
    id: randomUUID(),
    name: "Stop",
    at: 300,
    stopHookActive: true,
  });
  assert.equal(store.session(sessionId).state, "idle");
  assert.equal(store.task(taskId).status, "todo");
});

test("back-up herstelt taken en resultaten maar geen actieve sessies of tokens", (t) => {
  const { root, store, companyId, taskId, sessionId } = fixture(t);
  const file = join(root, "resultaat.md");
  writeFileSync(file, "Resultaat");
  store.agentCall(sessionId, "submit_result", {
    summary: "Klaar",
    files: [file],
  });
  const backup = store.export();
  assert.ok(!JSON.stringify(backup).includes("test-token"));
  assert.ok(!JSON.stringify(backup).includes("tokenHash"));
  store.patchTask(taskId, { title: "Gewijzigd" });
  store.restore(backup);
  assert.equal(store.task(taskId).title, "Campagne schrijven");
  assert.equal(store.task(taskId).status, "review");
  assert.equal(store.session(sessionId).state, "interrupted");
  assert.throws(
    () => store.authenticate(sessionId, "test-token"),
    /sessietoegang/,
  );
  const invalid = structuredClone(backup);
  invalid.data.tasks[0].companyId = randomUUID();
  assert.throws(() => store.restore(invalid), /bedrijf/);
  assert.equal(store.company(companyId).name, "Testbedrijf");
  assert.equal(store.snapshot().artifacts.length, 1);
});

test("back-up weigert afhankelijkheidscirkels voordat huidige gegevens worden vervangen", (t) => {
  const { store, taskId } = fixture(t);
  const backup = store.export();
  backup.data.tasks[0].dependencies = [taskId];
  assert.throws(() => store.restore(backup), /cirkel/);
  assert.deepEqual(store.task(taskId).dependencies, []);
});

test("serviceherstel behoudt taakstatus en trekt eerdere sessietoegang in", (t) => {
  const { store, taskId, sessionId } = fixture(t);
  store.patchTask(taskId, { status: "in_progress" });
  store.setSession(sessionId, { state: "working" });
  store.recover();
  assert.equal(store.session(sessionId).state, "interrupted");
  assert.equal(store.task(taskId).status, "in_progress");
  assert.throws(() => store.authenticate(sessionId, "test-token"));
});

test("criteria behouden menselijke beoordeling bij agentbewijs, herinzending en back-up", (t) => {
  const { store, taskId, root, sessionId } = fixture(t);
  store.patchTask(taskId, {
    definitionDone: "Drie varianten\nVerzendmomenten onderbouwd",
  });
  const [first, second] = store.task(taskId).criteria;
  store.reviewCriterion(taskId, first.id, { checked: true });
  const file = join(root, "campagne.md");
  writeFileSync(
    file,
    "# Campagne\nVariant A\nVariant B\nVariant C\nPlanning nog aanvullen\n",
  );
  store.agentCall(sessionId, "submit_result", {
    summary: "Klaar",
    files: [file],
    criteria: [
      {
        id: first.id,
        note: "Drie varianten geschreven",
        evidence: { path: file, line: 2 },
        checked: false,
      },
      {
        id: second.id,
        note: "Planning ontbreekt",
        evidence: { path: file, line: 5 },
        checked: true,
      },
    ],
  });
  assert.equal(store.task(taskId).criteria[0].checked, true);
  assert.equal(store.task(taskId).criteria[1].checked, false);
  assert.equal(store.task(taskId).criteria[1].evidence?.line, 5);
  assert.throws(() => store.returnTask(taskId), /opmerking/);
  store.reviewCriterion(taskId, second.id, {
    comment: "Voeg een concreet verzendmoment toe.",
  });
  const backup = store.export();
  assert.match(store.returnTask(taskId), /concreet verzendmoment/);
  assert.equal(store.task(taskId).status, "in_progress");
  assert.equal(store.snapshot().events[0].kind, "review_feedback");
  store.restore(backup);
  assert.equal(store.task(taskId).status, "review");
  assert.equal(store.task(taskId).criteria[0].checked, true);
  assert.match(store.task(taskId).criteria[1].comment, /concreet/);
  assert.throws(
    () =>
      store.reviewCriterion(taskId, first.id, { agentNote: "Niet toegestaan" }),
    /unrecognized_keys/,
  );
});

test("taakvolgorde wordt volledig gevalideerd en overleeft opnieuw openen", (t) => {
  const { store, companyId, projectId, taskId } = fixture(t);
  const second = store.saveTask({ companyId, projectId, title: "Tweede taak" });
  const third = store.saveTask({ companyId, projectId, title: "Derde taak" });
  store.reorderTasks(projectId, [third, taskId, second]);
  assert.deepEqual(
    store
      .snapshot()
      .tasks.filter((t) => t.projectId === projectId)
      .sort((a, b) => a.rank - b.rank)
      .map((t) => t.id),
    [third, taskId, second],
  );
  assert.throws(
    () => store.reorderTasks(projectId, [taskId, taskId, second]),
    /gewijzigd/,
  );
  assert.throws(() => store.reorderTasks(projectId, [taskId]), /gewijzigd/);
  const reopened = new Store(store.path);
  assert.equal(reopened.task(third).rank, 0);
  reopened.close();
});

test("gedeeltelijk prioriteitsvoorstel accepteert alleen gekozen wijzigingen", (t) => {
  const { store, companyId, projectId, taskId, sessionId } = fixture(t);
  const second = store.saveTask({
    companyId,
    projectId,
    title: "Tweede taak",
    pinned: true,
  });
  const third = store.saveTask({ companyId, projectId, title: "Derde taak" });
  store.context(sessionId);
  const result: any = store.agentCall(sessionId, "propose_priorities", {
    summary: "Andere volgorde",
    items: [third, second, taskId].map((taskId) => ({
      taskId,
      reason: "Afhankelijkheid",
      evidence: ["bron: doel"],
      confidence: "high",
    })),
  });
  store.decidePriorityItem(result.proposalId, second, false);
  const pinnedRank = store.task(second).rank;
  store.decidePriorityItem(result.proposalId, third, true);
  assert.equal(store.task(second).rank, pinnedRank);
  assert.equal(store.task(second).pinned, true);
  store.decideProposal(result.proposalId, true);
  const proposal = store
    .snapshot()
    .proposals.find((p) => p.id === result.proposalId)!;
  assert.equal(proposal.status, "accepted");
  assert.equal(proposal.payload.decisions[second], "dismissed");
  assert.equal(store.task(second).priorityReason, "");
  assert.equal(store.task(third).priorityReason, "Afhankelijkheid");
  assert.throws(
    () => store.decidePriorityItem(result.proposalId, third, true),
    /beschikbaar/,
  );
});

test("oude back-ups krijgen criteria zonder sessies of accountconfiguratie te verliezen", (t) => {
  const { store, taskId, sessionId } = fixture(t);
  store.patchTask(taskId, { definitionDone: "Controleer het bestand" });
  store.setSession(sessionId, {
    accountId: "test-account",
    accountConfigDir: "/tmp/test-account",
  });
  const current = store.export();
  store.restore(current);
  assert.equal(store.session(sessionId).accountConfigDir, "/tmp/test-account");
  const legacy: any = structuredClone(current);
  delete legacy.data.tasks[0].criteria;
  delete legacy.data.tasks[0].provider;
  delete legacy.data.tasks[0].model;
  delete legacy.data.projects[0].dueDate;
  delete legacy.data.sessions[0].accountConfigDir;
  delete legacy.data.sessions[0].accountId;
  delete legacy.data.sessions[0].purpose;
  store.restore(legacy);
  assert.equal(store.task(taskId).criteria[0].text, "Controleer het bestand");
  assert.equal(store.task(taskId).criteria[0].checked, false);
});

test("migratie van versie 1 bewaart gegevens en zet oude klaar-als tekst om naar menselijke criteria", (t) => {
  const root = mkdtempSync(join(tmpdir(), "werk-migration-"));
  const path = join(root, "legacy.sqlite");
  let store = new Store(path);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const companyId = store.saveCompany({
    name: "Bestaand bedrijf",
    workspacePath: root,
  });
  const projectId = store.saveProject({ companyId, name: "Bestaand project" });
  const taskId = store.saveTask({
    companyId,
    projectId,
    title: "Bestaande taak",
    kind: "human",
    definitionDone: "- Eerste criterium\n- Tweede criterium",
  });
  const sessionId = store.createSession({
    companyId,
    taskId,
    provider: "shell",
    mode: "work",
    cwd: root,
    outputDir: root,
    token: "fixture",
  });
  for (const [table, column] of [
    ["tasks", "criteria"],
    ["tasks", "provider"],
    ["tasks", "model"],
    ["projects", "due_date"],
    ["sessions", "account_id"],
    ["sessions", "account_config_dir"],
    ["sessions", "purpose"],
  ])
    store.sql.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  store.sql.pragma("user_version = 1");
  store.close();
  store = new Store(path);
  assert.equal(store.company(companyId).name, "Bestaand bedrijf");
  assert.equal(store.session(sessionId).cwd, root);
  assert.deepEqual(
    store.task(taskId).criteria.map((c) => [c.text, c.checked]),
    [
      ["Eerste criterium", false],
      ["Tweede criterium", false],
    ],
  );
  assert.equal(store.task(taskId).provider, "shell");
  assert.equal(store.sql.pragma("user_version", { simple: true }), 9);
  const codex = store.saveTask({
    companyId,
    projectId,
    title: "Codex zonder criteria",
    provider: "codex",
  });
  store.close();
  store = new Store(path);
  assert.equal(store.task(codex).provider, "codex");
});
