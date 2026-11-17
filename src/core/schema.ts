import type { SessionContextOptions } from "../shared/context";
import type { SessionMemory } from "../shared/memory";
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import type { Criterion } from "../shared/types";
export const companies = sqliteTable("companies", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  workspacePath: text("workspace_path").notNull(),
  color: text("color").notNull(),
  product: text("product").notNull(),
  audience: text("audience").notNull(),
  stage: text("stage").notNull(),
  bottleneck: text("bottleneck").notNull(),
  sources: text("sources", { mode: "json" }).$type<string[]>().notNull(),
  revision: integer("revision").notNull(),
  lastCheckinAt: text("last_checkin_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
export const departments = sqliteTable("departments", {
  id: text("id").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id),
  name: text("name").notNull(),
  description: text("description").notNull(),
  createdAt: text("created_at").notNull(),
});
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id),
  name: text("name").notNull(),
  description: text("description").notNull(),
  departmentId: text("department_id").references(() => departments.id),
  workspacePath: text("workspace_path").notNull(),
  goalId: text("goal_id"),
  dueDate: text("due_date").notNull().default(""),
  createdAt: text("created_at").notNull(),
});
export const goals = sqliteTable("goals", {
  id: text("id").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id),
  title: text("title").notNull(),
  metric: text("metric").notNull(),
  unit: text("unit").notNull(),
  baseline: real("baseline").notNull(),
  current: real("current").notNull(),
  target: real("target").notNull(),
  dueDate: text("due_date").notNull(),
  primary: integer("is_primary", { mode: "boolean" }).notNull(),
  updatedAt: text("updated_at").notNull(),
});
export const tasks = sqliteTable("tasks", {
  agentId: text("agent_id"),
  recurrence: text("recurrence")
    .$type<"none" | "daily" | "weekly">()
    .notNull()
    .default("none"),
  scheduledDate: text("scheduled_date").notNull().default(""),
  nextOccurrenceDate: text("next_occurrence_date").notNull().default(""),
  id: text("id").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  goalId: text("goal_id"),
  title: text("title").notNull(),
  description: text("description").notNull(),
  definitionDone: text("definition_done").notNull(),
  criteria: text("criteria", { mode: "json" })
    .$type<Criterion[]>()
    .notNull()
    .default([]),
  provider: text("provider").notNull().default("claude"),
  model: text("model").notNull().default(""),
  dueDate: text("due_date").notNull(),
  estimateMinutes: integer("estimate_minutes").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  pinned: integer("pinned", { mode: "boolean" }).notNull(),
  mustDo: integer("must_do", { mode: "boolean" }).notNull(),
  dependencies: text("dependencies", { mode: "json" })
    .$type<string[]>()
    .notNull(),
  rank: integer("rank").notNull(),
  priorityReason: text("priority_reason").notNull(),
  priorityEvidence: text("priority_evidence", { mode: "json" })
    .$type<string[]>()
    .notNull(),
  confidence: text("confidence").notNull(),
  resultSummary: text("result_summary").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
export const taskCompletions = sqliteTable("task_completions", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id),
  occurrenceDate: text("occurrence_date").notNull(),
  completedAt: text("completed_at").notNull(),
  summary: text("summary").notNull(),
  criteria: text("criteria", { mode: "json" }).$type<Criterion[]>().notNull(),
});
export const sessions = sqliteTable("sessions", {
  agentId: text("agent_id"),
  conversationId: text("conversation_id"),
  transport: text("transport").$type<"pty" | "chat">().notNull().default("pty"),
  contextOptions: text("context_options", { mode: "json" })
    .$type<SessionContextOptions>()
    .notNull()
    .default({ assignment: true, criteria: true, business: true }),
  id: text("id").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id),
  taskId: text("task_id").references(() => tasks.id),
  provider: text("provider").notNull(),
  memory: text("memory", { mode: "json" }).$type<SessionMemory | null>(),
  memoryDirty: integer("memory_dirty", { mode: "boolean" })
    .notNull()
    .default(false),
  memoryReminded: integer("memory_reminded", { mode: "boolean" })
    .notNull()
    .default(false),
  resumeFrom: text("resume_from"),
  accountId: text("account_id"),
  accountConfigDir: text("account_config_dir").notNull().default(""),
  purpose: text("purpose").notNull().default("work"),
  mode: text("mode").notNull(),
  state: text("state").notNull(),
  providerSessionId: text("provider_session_id"),
  cwd: text("cwd").notNull(),
  outputDir: text("output_dir").notNull(),
  tokenHash: text("token_hash").notNull(),
  basisRevision: integer("basis_revision").notNull(),
  lastHookAt: real("last_hook_at").notNull(),
  error: text("error").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id),
  taskId: text("task_id"),
  sessionId: text("session_id"),
  kind: text("kind").notNull(),
  summary: text("summary").notNull(),
  createdAt: text("created_at").notNull(),
});
export const artifacts = sqliteTable("artifacts", {
  id: text("id").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id),
  sessionId: text("session_id"),
  path: text("path").notNull(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
});
export const proposals = sqliteTable("proposals", {
  id: text("id").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id),
  sessionId: text("session_id").notNull(),
  kind: text("kind").notNull(),
  payload: text("payload", { mode: "json" }).$type<any>().notNull(),
  basisRevision: integer("basis_revision").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
});
export const checkins = sqliteTable("checkins", {
  measurements: text("measurements", { mode: "json" })
    .$type<
      {
        goalId: string;
        title: string;
        before: number;
        after: number;
        unit: string;
      }[]
    >()
    .notNull()
    .default([]),
  id: text("id").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id),
  note: text("note").notNull(),
  createdAt: text("created_at").notNull(),
});
