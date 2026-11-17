import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store";
import { PreferenceStore } from "../src/core/preferences";
import { validateBackup } from "../src/core/backup";
import { agentInput } from "../src/shared/agents";
import { agentRoutineInput } from "../src/shared/agents";
import { nextAgentRun } from "../src/core/agents";
import { ChatService } from "../src/runtime/chats";
import type {
  ChatDriver,
  ChatReply,
  DriverOptions,
} from "../src/runtime/chat-drivers";

class FakeDriver implements ChatDriver {
  options?: DriverOptions;
  reply?: ChatReply;
  finish!: () => void;
  fail!: (e: Error) => void;
  async run(options: DriverOptions) {
    this.options = options;
    options.thread("thread-test");
    await new Promise<void>((resolve, reject) => {
      this.finish = resolve;
      this.fail = reject;
      options.signal.addEventListener(
        "abort",
        () => reject(new Error("Aborted")),
        { once: true },
      );
    });
  }
  respond(_id: string, reply: ChatReply) {
    this.reply = reply;
  }
}
function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "benchdesk-agents-"));
  const store = new Store(join(root, "state.sqlite"));
  const preferences = new PreferenceStore(join(root, "prefs.json"));
  const companyId = store.saveCompany({
    name: "Agent test",
    workspacePath: root,
  });
  const otherId = store.saveCompany({ name: "Other", workspacePath: root });
  const projectId = store.saveProject({ name: "Work", companyId });
  const agentId = store.agents.save({
    name: "Writer",
    companyId,
    brief: "Write clearly",
  });
  const drivers: FakeDriver[] = [];
  const service: ChatService = new ChatService({
    store,
    preferences,
    runtimeDir: root,
    socketPath: join(root, "rpc.sock"),
    environment: (extra) => ({ ...extra }),
    broadcast: () => {},
    resetContext: () => {},
    sessionAccess: () => {},
    endAccess: () => {},
    executable: async () => "/fake/codex",
    driver: () => {
      const d = new FakeDriver();
      drivers.push(d);
      return d;
    },
    taskActive: (id, except) =>
      [...service.active.keys()].some(
        (sid) => sid !== except && store.session(sid).taskId === id,
      ),
  });
  t.after(async () => {
    for (const sid of service.active.keys()) await service.interrupt(sid);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const start = (taskId?: string) =>
    service.start({ companyId, agentId, taskId });
  const send = async (id: string, message = "Hello") => {
    const clientMessageId = randomUUID();
    service.send({ id, message, clientMessageId });
    await new Promise((r) => setImmediate(r));
    return clientMessageId;
  };
  return {
    store,
    root,
    companyId,
    otherId,
    projectId,
    agentId,
    service,
    drivers,
    start,
    send,
  };
}
test("agent output follows the company or project workspace, including resumed legacy chats", async (t) => {
  const { root, store, start, send, service, drivers, companyId, projectId } = fixture(t);
  const free = start();
  assert.equal(store.session(free.sessionId).outputDir, realpathSync(root));
  const fallbackTask = store.saveTask({ companyId, projectId, title: "Company folder" });
  const fallback = start(fallbackTask);
  assert.equal(store.session(fallback.sessionId).outputDir, realpathSync(root));
  const projectPath = join(root, "project");
  mkdirSync(projectPath);
  store.saveProject({ companyId, name: "Work", workspacePath: projectPath }, projectId);
  const taskId = store.saveTask({ companyId, projectId, title: "Project assets" });
  const c = start(taskId);
  assert.equal(store.session(c.sessionId).outputDir, realpathSync(projectPath));
  const legacyOutput = join(projectPath, ".werk-results", taskId);
  store.setSession(c.sessionId, { outputDir: legacyOutput, providerSessionId: "legacy-thread" });
  await send(c.id);
  assert.equal(drivers[0].options?.cwd, realpathSync(projectPath));
  assert.equal(drivers[0].options?.resumeId, "legacy-thread");
  assert.equal(store.context(c.sessionId).outputDirectory, realpathSync(projectPath));
  assert.equal(existsSync(legacyOutput), false);
  await service.interrupt(c.sessionId);
});

test("agent profile revisions, memory revisions and copies are independent", (t) => {
  const { store, companyId, otherId, agentId } = fixture(t);
  const p = store.agents.profile(agentId);
  store.agents.save(
    { ...agentInput.parse({ name: "Editor", companyId }) },
    agentId,
    p.revision,
  );
  assert.throws(
    () => store.agents.save({ name: "Stale", companyId }, agentId, p.revision),
    /gewijzigd/,
  );
  store.agents.memory(agentId, "Keep it short", 0, "user");
  assert.throws(
    () => store.agents.memory(agentId, "Overwrite", 0, "user"),
    /gewijzigd/,
  );
  const copy = store.agents.profile(store.agents.copy(agentId, otherId));
  assert.equal(copy.memory.content, "");
  assert.equal(copy.companyId, otherId);
  assert.equal(copy.accountId, null);
  store.agents.archive(agentId, true);
  assert.equal(store.agents.profile(agentId).archived, true);
});

test("history search isolates agents, excludes tool output and treats wildcard characters literally", (t) => {
  const { store, start, agentId, companyId } = fixture(t),
    c = start();
  const other = store.agents.save({ companyId, name: "Other" });
  store.agents.put(c.id, {
    id: "a",
    turnId: "t",
    kind: "assistant",
    status: "complete",
    text: "Afspraak: 10% korting op vrijdag",
  });
  store.agents.put(c.id, {
    id: "tool",
    turnId: "t",
    kind: "tool",
    status: "complete",
    text: "secret token",
  });
  assert.equal(store.agents.search(agentId, "10%").length, 1);
  assert.equal(store.agents.search(agentId, "secret").length, 0);
  assert.equal(store.agents.search(other, "korting").length, 0);
  assert.equal(store.agents.search(agentId, "_%").length, 0);
});

test("skills have independent revisions and tools cannot read another agent's skills", (t) => {
  const { store, service, agentId, companyId, start } = fixture(t),
    c = start();
  const skill = store.agents.saveSkill(agentId, {
    name: "Research",
    trigger: "Before writing",
    content: "Verify sources",
    enabled: false,
  });
  const changed = store.agents.saveSkill(
    agentId,
    { ...skill, enabled: true, content: "Verify primary sources" },
    skill.id,
    skill.revision,
    "assistant",
  );
  assert.equal(changed.enabled, false);
  assert.throws(
    () => store.agents.saveSkill(agentId, skill, skill.id, 1),
    /gewijzigd/,
  );
  const other = store.agents.save({ companyId, name: "Other" });
  const foreign = store.agents.saveSkill(other, {
    name: "Private",
    trigger: "Always",
    content: "Only for other",
  });
  assert.throws(
    () => service.agentTool(c.sessionId, "get_agent_skill", { id: foreign.id }),
    /beschikbaar/,
  );
  assert.throws(
    () => service.agentTool(c.sessionId, "get_agent_skill", { id: skill.id }),
    /beschikbaar/,
  );
  store.agents.saveSkill(
    agentId,
    { ...changed, enabled: true },
    changed.id,
    changed.revision,
  );
  assert.equal(
    (
      service.agentTool(c.sessionId, "get_agent_skill", { id: skill.id }) as {
        content: string;
      }
    ).content,
    "Verify primary sources",
  );
  store.agents.memory(agentId, "Preference", 0, "user");
  assert.equal(
    store.agents.profile(agentId).skills[0].content,
    "Verify primary sources",
  );
});

test("agent integration permissions are live and cannot be edited during active work", async (t) => {
  const { store, service, start, send, agentId } = fixture(t),
    c = start();
  const p = store.agents.profile(agentId);
  await service.app("agent.save", {
    id: agentId,
    expectedRevision: p.revision,
    value: {
      ...agentInput.strip().parse(p),
      access: { ...p.access, integrations: ["github"] },
    },
  });
  assert.equal(service.permitsIntegration(c.sessionId, "gmail"), false);
  assert.equal(service.permitsIntegration(c.sessionId, "github"), true);
  await send(c.id);
  const next = store.agents.profile(agentId);
  await assert.rejects(
    service.app("agent.save", {
      id: agentId,
      expectedRevision: next.revision,
      value: {
        ...agentInput.strip().parse(next),
        access: { ...next.access, integrations: [] },
      },
    }),
    /Stop eerst/,
  );
});

test("handoffs require both permissions, stay within company and prevent cycles", async (t) => {
  const { store, service, start, agentId, companyId, otherId, drivers } =
      fixture(t),
    c = start();
  const targetId = store.agents.save({
    companyId,
    name: "Reviewer",
    access: { messaging: true, teammates: [agentId] },
  });
  assert.throws(
    () => service.handoff(c.id, targetId, "Review the draft"),
    /niet toegestaan/,
  );
  const p = store.agents.profile(agentId);
  store.agents.save(
    {
      ...agentInput.strip().parse(p),
      access: { ...p.access, messaging: true, teammates: [targetId] },
    },
    p.id,
    p.revision,
  );
  const foreign = store.agents.save({ companyId: otherId, name: "Foreign" });
  assert.throws(
    () =>
      store.agents.save(
        {
          ...agentInput.strip().parse(store.agents.profile(agentId)),
          access: { teammates: [foreign] },
        },
        agentId,
        2,
      ),
    /bedrijf/,
  );
  const result = service.handoff(c.id, targetId, "Review the draft");
  await new Promise((r) => setImmediate(r));
  const target = store.agents.conversation(result.conversationId);
  assert.equal(target.originConversationId, c.id);
  assert.equal(target.taskId, null);
  assert.equal(
    store.agents.read(c.id).items.at(-1)?.detail?.conversationId,
    target.id,
  );
  assert.throws(
    () => service.handoff(target.id, agentId, "Send it back"),
    /kring/,
  );
  assert.throws(
    () => service.handoff(c.id, targetId, "Duplicate"),
    /aan het werk/,
  );
  const unrelated = start();
  assert.throws(
    () =>
      service.agentTool(unrelated.sessionId, "read_agent_handoff", {
        conversationId: target.id,
      }),
    /hoort niet/,
  );
  assert.equal(
    (
      service.agentTool(c.sessionId, "read_agent_handoff", {
        conversationId: target.id,
      }) as { conversationId: string }
    ).conversationId,
    target.id,
  );
  drivers[0].finish();
  await service.active.get(target.sessionId)!.done;
  const restored = validateBackup(store.export());
  assert.equal(
    restored.agentConversations.find((x) => x.id === target.id)
      ?.originConversationId,
    c.id,
  );
});

test("routines respect permissions, schedule in timezone, skip busy agents and restore paused", async (t) => {
  const { store, service, agentId, drivers } = fixture(t),
    p = store.agents.profile(agentId);
  const input = agentRoutineInput.parse({
    agentId,
    name: "Weekly report",
    prompt: "Summarize the week",
    schedule: "weekly",
    timezone: "Europe/Amsterdam",
    time: "09:00",
    weekday: 1,
    enabled: true,
  });
  assert.equal(
    nextAgentRun(input, new Date("2026-10-23T12:00:00Z")),
    "2026-10-26T08:00:00.000Z",
  );
  assert.throws(() => store.agents.saveRoutine(input), /Sta routines/);
  store.agents.save(
    { ...agentInput.strip().parse(p), access: { ...p.access, routines: true } },
    p.id,
    p.revision,
  );
  const r = store.agents.saveRoutine(input);
  store.agents.writeRoutine({ ...r, nextRunAt: "2026-01-01T00:00:00.000Z" });
  service.resetRoutineClock();
  assert.ok(Date.parse(store.agents.routine(r.id).nextRunAt) > Date.now());
  assert.equal(service.active.size, 0);
  store.agents.writeRoutine({
    ...store.agents.routine(r.id),
    nextRunAt: "2026-01-01T00:00:00.000Z",
  });
  service.tickRoutines();
  await new Promise((r) => setImmediate(r));
  assert.equal(service.active.size, 1);
  assert.throws(() => service.runRoutine(r.id), /aan het werk/);
  service.tickRoutines();
  assert.equal(service.active.size, 1);
  const conversation = store.agents.conversation(
    store.agents.routine(r.id).lastConversationId!,
  );
  assert.equal(conversation.title, "Weekly report");
  const done = service.active.get(conversation.sessionId)!.done;
  drivers[0].fail(new Error("Provider unavailable"));
  await done;
  assert.equal(store.agents.routine(r.id).error, "Provider unavailable");
  store.restore(store.export());
  assert.equal(store.agents.routine(r.id).enabled, false);
  assert.equal(store.agents.routine(r.id).lastConversationId, conversation.id);
});
test("conversation snapshots are fixed and cross-company assignment is rejected", (t) => {
  const { store, service, start, companyId, otherId, agentId, projectId } =
    fixture(t);
  const c = start();
  store.agents.save(
    { name: "New name", companyId, provider: "claude" },
    agentId,
    1,
  );
  assert.equal(store.agents.conversation(c.id).profile.name, "Writer");
  assert.equal(store.session(c.sessionId).provider, "codex");
  assert.equal(start().profile.provider, "claude");
  assert.throws(
    () => service.start({ companyId: otherId, agentId }),
    /bedrijf/,
  );
  const otherProject = store.saveProject({
    companyId: otherId,
    name: "Other work",
  });
  const otherTask = store.saveTask({
    companyId: otherId,
    projectId: otherProject,
    title: "Other task",
  });
  assert.throws(() => service.link({ id: c.id, taskId: otherTask }), /bedrijf/);
  assert.throws(
    () =>
      store.saveTask({
        companyId: otherId,
        projectId: otherProject,
        title: "Bad",
        agentId,
      }),
    /bedrijf/,
  );
  const taskId = store.saveTask({ companyId, projectId, title: "Local" });
  service.link({ id: c.id, taskId });
  assert.equal(store.session(c.sessionId).taskId, taskId);
  assert.equal(store.task(taskId).agentId, agentId);
  assert.throws(() => service.link({ id: c.id, taskId }), /al aan/);
});
test("streaming, idempotent sends, approval and persisted resume", async (t) => {
  const { store, service, drivers, start, send } = fixture(t);
  const c = start(),
    turnId = await send(c.id),
    d = drivers[0];
  assert.match(d.options!.instruction, /save_session_memory/);
  assert.match(d.options!.instruction, /save_brain_changes/);
  assert.match(d.options!.instruction, /submit_result/);
  assert.match(d.options!.instruction, /Write clearly/);
  assert.doesNotMatch(d.options!.prompt, /save_session_memory/);
  assert.equal(
    service.send({ id: c.id, message: "Hello", clientMessageId: turnId })
      .duplicate,
    true,
  );
  assert.throws(
    () =>
      service.send({
        id: c.id,
        message: "Again",
        clientMessageId: randomUUID(),
      }),
    /Wacht/,
  );
  const emit = d.options!.emit;
  emit({
    id: "text",
    turnId,
    kind: "assistant",
    text: "Hel",
    status: "running",
  });
  const after = store.agents.read(c.id).nextSequence;
  emit({
    id: "text",
    turnId,
    kind: "assistant",
    text: "Hello!",
    status: "complete",
  });
  const changes = store.agents.read(c.id, after);
  assert.equal(changes.items.length, 1);
  assert.equal(changes.items[0].text, "Hello!");
  emit({
    id: "approval",
    turnId,
    kind: "approval",
    text: "Write file",
    status: "pending",
  });
  assert.equal(store.session(c.sessionId).state, "waiting");
  service.respond({ id: c.id, requestId: `${turnId}:approval`, allow: false });
  assert.equal(d.reply?.allow, false);
  assert.throws(
    () =>
      service.respond({
        id: c.id,
        requestId: `${turnId}:approval`,
        allow: true,
      }),
    /niet meer actief/,
  );
  d.finish();
  await service.active.get(c.sessionId)!.done;
  assert.equal(store.session(c.sessionId).state, "idle");
  assert.equal(store.session(c.sessionId).tokenHash, "");
  await send(c.id, "Continue");
  assert.equal(drivers[1].options?.resumeId, "thread-test");
  await service.interrupt(c.sessionId);
  assert.equal(store.session(c.sessionId).state, "interrupted");
  assert.equal(service.active.size, 0);
});
test("pending questions expire on stop and task work is serialized", async (t) => {
  const { store, service, drivers, start, send, companyId, projectId } =
    fixture(t);
  const taskId = store.saveTask({ companyId, projectId, title: "Task" });
  const a = start(taskId),
    b = start(taskId),
    turnId = await send(a.id);
  assert.throws(
    () =>
      service.send({
        id: b.id,
        message: "Double",
        clientMessageId: randomUUID(),
      }),
    /al een agent/,
  );
  drivers[0].options!.emit({
    id: "q",
    turnId,
    kind: "question",
    text: "Choose",
    status: "pending",
    detail: { questions: [{ id: "one", question: "Which?" }] },
  });
  assert.throws(
    () => service.respond({ id: a.id, requestId: `${turnId}:q`, answers: {} }),
    /alle vragen/,
  );
  await service.interrupt(a.sessionId);
  assert.equal(store.agents.item(a.id, `${turnId}:q`)?.status, "interrupted");
  assert.throws(
    () =>
      service.respond({
        id: a.id,
        requestId: `${turnId}:q`,
        answers: { one: "Yes" },
      }),
    /niet meer actief/,
  );
  await send(b.id);
  drivers[1].fail(new Error("Provider failed"));
  await service.active.get(b.sessionId)!.done;
  assert.equal(store.session(b.sessionId).state, "error");
  assert.equal(store.session(b.sessionId).tokenHash, "");
});
test("archives and different workspaces cannot silently start or move conversations", async (t) => {
  const { root, store, service, start, companyId, projectId, agentId } =
    fixture(t);
  const c = start();
  const otherPath = join(root, "other");
  mkdirSync(otherPath);
  const project = store.saveProject({
    companyId,
    name: "Different",
    workspacePath: otherPath,
  });
  const taskId = store.saveTask({
    companyId,
    projectId: project,
    title: "Different directory",
  });
  assert.throws(() => service.link({ id: c.id, taskId }), /andere werkmap/);
  store.agents.archive(agentId, true);
  assert.throws(() => start(), /Herstel/);
  assert.throws(
    () =>
      service.send({
        id: c.id,
        message: "Start",
        clientMessageId: randomUUID(),
      }),
    /Herstel/,
  );
});
test("review feedback waits for an active turn and continues the same provider conversation", async (t) => {
  const { store, service, start, send, drivers, companyId, projectId } =
    fixture(t);
  const taskId = store.saveTask({ companyId, projectId, title: "Review task" });
  const c = start(taskId);
  await send(c.id);
  assert.equal(
    service.feedback(c.id, "Use the corrected criteria").queued,
    true,
  );
  const finished = service.active.get(c.sessionId)!.done;
  drivers[0].finish();
  await finished;
  await new Promise((r) => setImmediate(r));
  assert.equal(drivers.length, 2);
  assert.equal(drivers[1].options?.resumeId, "thread-test");
  assert.match(drivers[1].options!.prompt, /corrected criteria/);
  await service.interrupt(c.sessionId);
  assert.throws(
    () => store.authenticate(c.sessionId, "expired-token"),
    /sessietoegang/,
  );
});
test("agent backup roundtrip, legacy defaults, reference integrity and crash recovery", (t) => {
  const { store, start, agentId, otherId } = fixture(t);
  const c = start();
  store.agents.memory(agentId, "Remember", 0, "assistant", c.id);
  store.agents.put(c.id, {
    id: "pending",
    turnId: "turn",
    kind: "assistant",
    text: "Partial",
    status: "running",
  });
  const backup = store.export();
  validateBackup(backup);
  const invalid = structuredClone(backup) as any;
  invalid.data.agentConversations[0].companyId = otherId;
  assert.throws(() => validateBackup(invalid), /agentgesprekken/);
  const missing = structuredClone(backup) as any;
  missing.data.chatItems = [];
  assert.throws(() => validateBackup(missing), /mist chatberichten/);
  store.restore(backup);
  assert.equal(store.agents.profile(agentId).memory.content, "Remember");
  assert.equal(store.agents.item(c.id, "pending")?.status, "interrupted");
  assert.equal(store.agents.read(c.id).more, false);
  const legacy = structuredClone(store.export()) as any;
  legacy.version = 7;
  delete legacy.data.agents;
  delete legacy.data.agentConversations;
  delete legacy.data.chatItems;
  legacy.data.sessions = [];
  assert.equal(validateBackup(legacy).agents.length, 0);
});

test("policy gateway denies, asks in chat, records an audit trail and redacts secrets", async (t) => {
  const { store, service, start, send, drivers, agentId, companyId } = fixture(t);
  const p = store.agents.profile(agentId);
  assert.equal(p.access.policy.defaults.write, "ask");
  store.agents.save(
    {
      companyId: p.companyId,
      name: p.name,
      brief: p.brief,
      access: {
        ...p.access,
        policy: {
          mode: "enforce",
          defaults: { read: "allow", write: "ask", internal: "allow" },
          rules: [
            {
              id: randomUUID(),
              enabled: true,
              verdict: "deny",
              note: "Geen overdrachten",
              match: { tool: "handoff_*" },
            },
          ],
        },
      },
    },
    agentId,
    p.revision,
  );
  const c = start();
  const turnId = await send(c.id);
  assert.equal(typeof drivers[0].options?.policy, "function");
  let ran = 0;
  const exec = () => ++ran;
  await assert.rejects(
    service.gateway.run(
      c.sessionId,
      { source: "werk", tool: "handoff_agent_work", input: { message: "x" } },
      exec,
    ),
    /Geweigerd door het beleid/,
  );
  assert.equal(ran, 0);
  // Internal bookkeeping passes without a prompt.
  assert.equal(
    await service.gateway.run(c.sessionId, { source: "werk", tool: "save_session_memory" }, exec),
    1,
  );
  const asked = service.gateway.run(
    c.sessionId,
    { source: "werk", tool: "gmail_create_draft", input: { subject: "Hi", access_token: "s3cret" } },
    exec,
  );
  await new Promise((r) => setImmediate(r));
  const pending = store.agents
    .read(c.id)
    .items.find((i) => i.kind === "approval" && i.status === "pending")!;
  assert.equal(pending.detail?.source, "gateway");
  assert.equal(pending.turnId, turnId);
  assert.equal(store.session(c.sessionId).state, "waiting");
  service.respond({ id: c.id, requestId: pending.id, allow: true });
  assert.equal(await asked, 2);
  const declined = service.gateway.run(c.sessionId, { source: "werk", tool: "gmail_create_draft" }, exec);
  await new Promise((r) => setImmediate(r));
  const second = store.agents
    .read(c.id)
    .items.find((i) => i.kind === "approval" && i.status === "pending")!;
  service.respond({ id: c.id, requestId: second.id, allow: false });
  await assert.rejects(declined, /geweigerd/);
  assert.equal(ran, 2);
  // Built-in tools: writes ask, allowed reads skip the provider prompt, werk MCP is audited in the runner.
  assert.equal(service.gateway.builtin(c.sessionId, "Bash", { command: "ls" }), "ask");
  assert.equal(service.gateway.builtin(c.sessionId, "Read", { file_path: "/a" }), "allow");
  assert.equal(service.gateway.builtin(c.sessionId, "mcp__werk_task_context__get_task_context"), "allow");
  // An approval that is still open when the turn stops resolves as declined.
  const orphan = service.gateway.run(c.sessionId, { source: "werk", tool: "gmail_create_draft" }, exec);
  await new Promise((r) => setImmediate(r));
  await service.interrupt(c.sessionId);
  await assert.rejects(orphan, /geweigerd/);
  const log = store.agents.auditList(agentId, { limit: 50 }).items;
  assert.deepEqual(
    log.map((r) => [r.tool, r.verdict, r.outcome]).reverse(),
    [
      ["handoff_agent_work", "deny", "denied"],
      ["save_session_memory", "allow", "ok"],
      ["gmail_create_draft", "ask", "ok"],
      ["gmail_create_draft", "ask", "declined"],
      ["Bash", "ask", "pending"],
      ["Read", "allow", "ok"],
      ["gmail_create_draft", "ask", "declined"],
    ],
  );
  assert.ok(log.every((r) => r.companyId === companyId && r.initiator === "chat"));
  assert.ok(!JSON.stringify(log).includes("s3cret"));
  const page = store.agents.auditList(agentId, { limit: 3 });
  assert.equal(page.items.length, 3);
  const rest = store.agents.auditList(agentId, { limit: 50, before: page.next });
  assert.equal(rest.items.length, 4);
  assert.equal(store.agents.auditList(agentId, { verdict: "deny" }).items.length, 1);
});

test("ask_person and interactive components wait for a human after the turn and answer via a new turn", async (t) => {
  const { store, service, start, send, drivers } = fixture(t);
  const c = start();
  await send(c.id);
  const asked: any = service.agentTool(c.sessionId, "ask_person", {
    question: "Welke doelgroep?",
    why: "Bepaalt de toon",
    options: ["MKB", "Zzp"],
  });
  assert.equal(asked.status, "asked");
  const form: any = service.agentTool(c.sessionId, "show_component", {
    component: {
      type: "form",
      title: "Offerte",
      fields: [{ id: "budget", label: "Budget", kind: "number", required: true }],
    },
  });
  assert.equal(form.awaitsInput, true);
  const card: any = service.agentTool(c.sessionId, "show_component", {
    component: { type: "card", title: "Samenvatting", body: "Klaar" },
  });
  assert.equal(card.awaitsInput, false);
  assert.throws(() =>
    service.agentTool(c.sessionId, "show_component", { component: { type: "card", title: "X", links: [{ label: "x", url: "http://x.nl" }] } }),
  );
  // The turn ends: async requests stay pending and the session waits for the human.
  drivers[0].finish();
  await service.active.get(c.sessionId)?.done;
  const items = store.agents.read(c.id).items;
  assert.equal(items.find((i) => i.id === asked.itemId)?.status, "pending");
  assert.equal(items.find((i) => i.id === form.itemId)?.status, "pending");
  assert.equal(items.find((i) => i.id === card.itemId)?.status, "complete");
  assert.equal(items.find((i) => i.id === card.itemId)?.text, "**Samenvatting**\nKlaar");
  assert.equal(store.session(c.sessionId).state, "waiting");
  // Answering without a running turn starts a new one with the answer.
  assert.throws(() => service.respond({ id: c.id, requestId: asked.itemId, answers: {} }), /Beantwoord/);
  service.respond({ id: c.id, requestId: asked.itemId, answers: { answer: "MKB" } });
  await new Promise((r) => setImmediate(r));
  assert.equal(drivers.length, 2);
  assert.match(drivers[1].options!.prompt, /Welke doelgroep\?[\s\S]*MKB/);
  assert.throws(() => service.respond({ id: c.id, requestId: asked.itemId, answers: { answer: "Zzp" } }), /niet meer actief/);
  // A submission during a running turn is validated and queued as feedback.
  assert.throws(() => service.submitComponent({ id: c.id, itemId: form.itemId, values: {} }), /Budget is verplicht/);
  const queued = service.submitComponent({ id: c.id, itemId: form.itemId, values: { budget: "2500" } });
  assert.equal(queued.queued, true);
  assert.deepEqual(store.agents.item(c.id, form.itemId)?.detail?.values, { budget: 2500 });
  assert.throws(() => service.submitComponent({ id: c.id, itemId: card.itemId, values: {} }), /niet meer actief/);
  drivers[1].finish();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(drivers.length, 3);
  assert.match(drivers[2].options!.prompt, /Formulier "Offerte" ingevuld:[\s\S]*2500/);
  await service.interrupt(c.sessionId);
});
