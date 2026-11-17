import { brainBackupFile } from "./brain";
import {
  agentProfile,
  agentConversation,
  chatItem,
  agentRoutine,
} from "../shared/agents";
import { sessionContextInput, checkinMeasurement } from "../shared/context";
import { nextActionsPayload } from "../shared/suggestions";
import { storedSessionMemory } from "../shared/memory";
import { z } from "zod";
import { calendarDate } from "../shared/task-schedule";
import {
  companyInput,
  projectInput,
  departmentInput,
  goalInput,
  taskInput,
  contextInput,
  priorityItem,
  taskStatuses,
  sessionStates,
} from "../shared/types";
const uuid = z.string().uuid(),
  timestamp = z.string().datetime(),
  text = z.string().max(30000);
const company = companyInput.extend({
  id: uuid,
  revision: z.number().int().nonnegative(),
  lastCheckinAt: z.union([z.literal(""), timestamp]),
  createdAt: timestamp,
  updatedAt: timestamp,
});
const project = projectInput.extend({
  id: uuid,
  companyId: uuid,
  createdAt: timestamp,
});
const goal = goalInput.extend({
  id: uuid,
  companyId: uuid,
  updatedAt: timestamp,
});
const task = taskInput.extend({
  nextOccurrenceDate: calendarDate.default(""),
  id: uuid,
  companyId: uuid,
  projectId: uuid,
  rank: z.number().int().nonnegative(),
  priorityReason: text,
  priorityEvidence: z.array(text).max(20),
  confidence: z.enum(["", "low", "medium", "high"]),
  resultSummary: text,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const session = z.object({
  agentId: uuid.nullable().default(null),
  conversationId: uuid.nullable().default(null),
  transport: z.enum(["pty", "chat"]).default("pty"),
  contextOptions: sessionContextInput,
  id: uuid,
  companyId: uuid,
  taskId: uuid.nullable(),
  provider: z.enum(["shell", "claude", "codex"]),
  memory: storedSessionMemory.nullable().default(null),
  memoryDirty: z.boolean().default(false),
  resumeFrom: uuid.nullable().default(null),
  accountId: z.string().nullable().default(null),
  accountConfigDir: z.string().max(8000).default(""),
  purpose: z.enum(["work", "login", "logout"]).default("work"),
  mode: z.enum(["work", "planning", "intake", "suggestions"]),
  state: z.enum(sessionStates),
  providerSessionId: z.string().max(500).nullable(),
  cwd: z.string().max(8000),
  outputDir: z.string().max(8000),
  createdAt: timestamp,
  updatedAt: timestamp,
  error: text,
  alive: z.boolean().optional(),
  agentRunning: z.boolean().optional(),
});
const event = z.object({
  id: uuid,
  companyId: uuid,
  taskId: uuid.nullable(),
  sessionId: uuid.nullable(),
  kind: z.string().max(100),
  summary: text,
  createdAt: timestamp,
});
const artifact = z.object({
  id: uuid,
  companyId: uuid,
  taskId: uuid,
  sessionId: uuid.nullable(),
  path: z.string().max(8000),
  name: z.string().max(8000),
  createdAt: timestamp,
});
const proposal = z.object({
  id: uuid,
  companyId: uuid,
  sessionId: uuid,
  basisRevision: z.number().int().nonnegative(),
  status: z.enum(["pending", "accepted", "dismissed"]),
  createdAt: timestamp,
});
const proposals = z.discriminatedUnion("kind", [
  proposal.extend({
    kind: z.literal("suggestions"),
    payload: nextActionsPayload,
  }),
  proposal.extend({
    kind: z.literal("priorities"),
    payload: z.object({
      summary: text,
      items: z.array(priorityItem).max(200),
      decisions: z.record(z.enum(["accepted", "dismissed"])).optional(),
    }),
  }),
  proposal.extend({
    kind: z.literal("tasks"),
    payload: z.object({
      summary: text,
      tasks: z.array(taskInput.omit({ companyId: true })).max(30),
    }),
  }),
  proposal.extend({ kind: z.literal("context"), payload: contextInput }),
]);
export const backupSchema = z.object({
  format: z.literal("werk-backup"),
  version: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
    z.literal(6),
    z.literal(7),
    z.literal(8),
    z.literal(9),
  ]),
  data: z.object({
    agents: z.array(agentProfile).max(10000).default([]),
    agentRoutines: z.array(agentRoutine).max(100000).default([]),
    agentConversations: z.array(agentConversation).max(100000).default([]),
    chatItems: z.array(chatItem).max(1000000).default([]),
    brainFiles: z.array(brainBackupFile).max(200000).default([]),
    companies: z.array(company).max(500),
    departments: z
      .array(
        departmentInput.extend({
          id: uuid,
          companyId: uuid,
          createdAt: timestamp,
        }),
      )
      .max(10000)
      .default([]),
    projects: z.array(project).max(10000),
    goals: z.array(goal).max(10000),
    tasks: z.array(task).max(50000),
    taskCompletions: z
      .array(
        z.object({
          id: uuid,
          taskId: uuid,
          occurrenceDate: calendarDate.refine(Boolean),
          completedAt: timestamp,
          summary: text,
          criteria: taskInput.shape.criteria,
        }),
      )
      .max(500000)
      .default([]),
    sessions: z.array(session).max(100000),
    events: z.array(event).max(300000),
    artifacts: z.array(artifact).max(100000),
    proposals: z.array(proposals).max(100000),
    checkins: z
      .array(
        z.object({
          id: uuid,
          companyId: uuid,
          note: text,
          measurements: z.array(checkinMeasurement).max(10000).default([]),
          createdAt: timestamp,
        }),
      )
      .max(100000),
  }),
});
export function validateBackup(input: unknown) {
  const { data: v } = backupSchema.parse(input);
  for (const [key, rows] of Object.entries(v)) {
    const seen = new Set();
    for (const row of rows) {
      const rowId =
        key === "chatItems"
          ? `${(row as z.infer<typeof chatItem>).conversationId}/${row.id}`
          : row.id;
      if (seen.has(rowId)) throw new Error("Dubbele ID in back-up.");
      seen.add(rowId);
    }
  }
  const companyIds = new Set(v.companies.map((c) => c.id)),
    departmentCompanies = new Map(
      v.departments.map((d) => [d.id, d.companyId]),
    ),
    projectCompanies = new Map(v.projects.map((p) => [p.id, p.companyId])),
    goalCompanies = new Map(v.goals.map((g) => [g.id, g.companyId])),
    taskCompanies = new Map(v.tasks.map((t) => [t.id, t.companyId])),
    sessionCompanies = new Map(v.sessions.map((s) => [s.id, s.companyId]));
  for (const rows of [
    v.agents,
    v.agentConversations,
    v.departments,
    v.projects,
    v.goals,
    v.tasks,
    v.sessions,
    v.events,
    v.artifacts,
    v.proposals,
    v.checkins,
  ])
    for (const row of rows)
      if (!companyIds.has(row.companyId))
        throw new Error("Back-up bevat een onbekend bedrijf.");
  const checkTask = (t: {
    companyId: string;
    projectId: string;
    goalId: string | null;
    dependencies: string[];
  }) => {
    if (
      projectCompanies.get(t.projectId) !== t.companyId ||
      (t.goalId && goalCompanies.get(t.goalId) !== t.companyId)
    )
      throw new Error("Back-up bevat ongeldige taakrelaties.");
    for (const dep of t.dependencies)
      if (taskCompanies.get(dep) !== t.companyId)
        throw new Error("Ongeldige afhankelijkheid in back-up.");
  };
  const agents = new Map(v.agents.map((a) => [a.id, a]));
  const conversations = new Map(v.agentConversations.map((c) => [c.id, c]));
  const sessions = new Map(v.sessions.map((s) => [s.id, s]));
  for (const a of v.agents) {
    if (new Set(a.skills.map((s) => s.id)).size !== a.skills.length)
      throw new Error("Dubbele skill in back-up.");
    for (const id of a.access.teammates)
      if (id === a.id || agents.get(id)?.companyId !== a.companyId)
        throw new Error("Ongeldige agentrechten in back-up.");
  }
  for (const r of v.agentRoutines)
    if (
      !agents.has(r.agentId) ||
      (r.lastConversationId &&
        conversations.get(r.lastConversationId)?.agentId !== r.agentId)
    )
      throw new Error("Ongeldige agentroutine in back-up.");
  for (const c of v.agentConversations) {
    const visited = new Set([c.id]);
    let origin = c.originConversationId;
    while (origin) {
      const parent = conversations.get(origin);
      if (!parent || parent.companyId !== c.companyId || visited.has(origin))
        throw new Error("Ongeldige agentoverdracht in back-up.");
      visited.add(origin);
      origin = parent.originConversationId;
    }
  }
  for (const task of v.tasks)
    if (task.agentId && agents.get(task.agentId)?.companyId !== task.companyId)
      throw new Error("Back-up bevat een ongeldige taakagent.");
  for (const agent of v.agents)
    if (
      agent.memory.sourceConversationId &&
      conversations.get(agent.memory.sourceConversationId)?.agentId !== agent.id
    )
      throw new Error("Back-up bevat een ongeldige geheugenbron.");
  for (const c of v.agentConversations) {
    const s = sessions.get(c.sessionId);
    if (
      agents.get(c.agentId)?.companyId !== c.companyId ||
      c.profile.id !== c.agentId ||
      c.profile.companyId !== c.companyId ||
      !s ||
      s.companyId !== c.companyId ||
      s.agentId !== c.agentId ||
      s.conversationId !== c.id ||
      s.transport !== "chat" ||
      s.taskId !== c.taskId ||
      s.provider !== c.profile.provider
    )
      throw new Error("Back-up bevat ongeldige agentgesprekken.");
  }
  for (const s of v.sessions) {
    if (
      s.transport === "chat"
        ? !s.conversationId ||
          conversations.get(s.conversationId)?.sessionId !== s.id
        : !!s.conversationId || !!s.agentId
    )
      throw new Error("Back-up bevat een ongeldige chatsessie.");
  }
  const sequences = new Set<string>(),
    orders = new Set<string>();
  const maxSequence = new Map<string, number>();
  for (const item of v.chatItems) {
    const c = conversations.get(item.conversationId),
      sequence = `${item.conversationId}/${item.sequence}`,
      order = `${item.conversationId}/${item.order}`;
    if (
      !c ||
      item.sequence < 1 ||
      item.order < 1 ||
      item.order > item.sequence ||
      item.sequence > c.sequence ||
      sequences.has(sequence) ||
      orders.has(order)
    )
      throw new Error("Back-up bevat ongeldige chatberichten.");
    sequences.add(sequence);
    orders.add(order);
    maxSequence.set(
      item.conversationId,
      Math.max(maxSequence.get(item.conversationId) || 0, item.sequence),
    );
  }
  for (const c of v.agentConversations)
    if ((maxSequence.get(c.id) || 0) !== c.sequence)
      throw new Error("Back-up mist chatberichten.");
  for (const p of v.projects)
    if (
      p.departmentId &&
      departmentCompanies.get(p.departmentId) !== p.companyId
    )
      throw new Error("Ongeldige afdeling in back-up.");
  for (const p of v.projects)
    if (p.goalId && goalCompanies.get(p.goalId) !== p.companyId)
      throw new Error("Ongeldig projectdoel in back-up.");
  for (const checkin of v.checkins)
    for (const measurement of checkin.measurements)
      if (
        goalCompanies.has(measurement.goalId) &&
        goalCompanies.get(measurement.goalId) !== checkin.companyId
      )
        throw new Error("Ongeldig check-indoel in back-up.");
  for (const t of v.tasks) checkTask(t);
  const completed = new Set<string>();
  for (const c of v.taskCompletions) {
    const key = `${c.taskId}/${c.occurrenceDate}`;
    if (!taskCompanies.has(c.taskId) || completed.has(key))
      throw new Error("Ongeldige taakuitvoering in back-up.");
    completed.add(key);
  }
  for (const t of v.tasks) {
    if (
      (t.recurrence !== "none" && !t.scheduledDate) ||
      (t.recurrence !== "none" &&
        t.status === "done" &&
        !t.nextOccurrenceDate) ||
      (t.nextOccurrenceDate &&
        (t.status !== "done" ||
          t.recurrence === "none" ||
          t.nextOccurrenceDate <= t.scheduledDate))
    )
      throw new Error("Ongeldige taakplanning in back-up.");
  }
  for (const p of v.proposals.filter((p) => p.kind === "suggestions")) {
    if (p.kind !== "suggestions") continue;
    for (const action of p.payload.actions)
      checkTask({ ...action.task, companyId: p.companyId });
    for (const [index, taskId] of Object.entries(p.payload.createdTasks)) {
      if (
        !["0", "1", "2"].includes(index) ||
        taskCompanies.get(taskId) !== p.companyId ||
        p.payload.decisions[index] !== "accepted"
      )
        throw new Error("Ongeldige voorgestelde taak in back-up.");
    }
    for (const index of Object.keys(p.payload.decisions))
      if (!["0", "1", "2"].includes(index))
        throw new Error("Ongeldig voorstelbesluit in back-up.");
  }

  for (const rows of [v.sessions, v.artifacts, v.events])
    for (const row of rows)
      if (row.taskId && taskCompanies.get(row.taskId) !== row.companyId)
        throw new Error("Back-up bevat een ongeldige taakverwijzing.");
  for (const rows of [v.artifacts, v.events, v.proposals])
    for (const row of rows)
      if (
        row.sessionId &&
        sessionCompanies.get(row.sessionId) !== row.companyId
      )
        throw new Error("Back-up bevat een ongeldige gesprekverwijzing.");
  const sessionsById = new Map(v.sessions.map((s) => [s.id, s]));
  const checkedSessions = new Set<string>();
  for (const session of v.sessions) {
    if (session.resumeFrom) {
      const parent = sessionsById.get(session.resumeFrom);
      if (
        !parent ||
        parent.companyId !== session.companyId ||
        parent.taskId !== session.taskId ||
        parent.provider !== session.provider ||
        parent.accountId !== session.accountId ||
        parent.accountConfigDir !== session.accountConfigDir
      )
        throw new Error("Back-up bevat een ongeldig hervat gesprek.");
    }
    const chain = new Set<string>();
    let cursor: string | null = session.id;
    while (cursor && !checkedSessions.has(cursor)) {
      if (chain.has(cursor))
        throw new Error("Back-up bevat een ongeldig hervat gesprek.");
      chain.add(cursor);
      cursor = sessionsById.get(cursor)?.resumeFrom || null;
    }
    for (const id of chain) checkedSessions.add(id);
  }
  for (const p of v.proposals) {
    if (p.kind === "priorities")
      for (const item of p.payload.items)
        if (taskCompanies.get(item.taskId) !== p.companyId)
          throw new Error("Ongeldige taak in voorstel.");
    if (p.kind === "tasks")
      for (const t of p.payload.tasks)
        checkTask({ ...t, companyId: p.companyId });
  }
  const all = new Map(v.tasks.map((t) => [t.id, t])),
    visited = new Set<string>(),
    visiting = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id))
      throw new Error("Back-up bevat een cirkel in afhankelijkheden.");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of all.get(id)!.dependencies) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const t of v.tasks) visit(t.id);
  return v;
}
