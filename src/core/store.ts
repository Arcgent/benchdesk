import {
  sessionContextInput,
  type SessionContextOptions,
} from "../shared/context";
import { nextActionsInput, nextActionsPayload } from "../shared/suggestions";
import { BrainStore } from "./brain";
import { AgentStore } from "./agents";
import { sessionMemoryInput, memoryInstruction } from "../shared/memory";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq, desc, and, notLike } from "drizzle-orm";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, existsSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve, basename, sep } from "node:path";
import { z } from "zod";
import * as s from "./schema";
import { validateBackup } from "./backup";
import { applyProposedOrder } from "../shared/priorities";
import {
  localDate,
  nextOccurrence,
  availableToday,
} from "../shared/task-schedule";
import {
  companyInput,
  projectInput,
  departmentInput,
  goalInput,
  taskInput,
  contextInput,
  priorityItem,
  criterionInput,
  type Snapshot,
  type Session,
  type Task,
} from "../shared/types";
const now = () => new Date().toISOString();
const id = () => randomUUID();
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const inside = (root: string, file: string) =>
  file === root || file.startsWith(root + sep);
export function folder(path: string) {
  const p = realpathSync(path);
  if (!statSync(p).isDirectory()) throw new Error("Kies een bestaande map.");
  return p;
}
export class Store {
  readonly agents: AgentStore;
  readonly brain: BrainStore;
  sql: Database.Database;
  db: ReturnType<typeof drizzle>;
  constructor(
    public path: string,
    private clock: () => Date = () => new Date(),
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.sql = new Database(path);
    this.sql.pragma("journal_mode = WAL");
    this.sql.pragma("foreign_keys = ON");
    const schemaVersion = Number(
      this.sql.pragma("user_version", { simple: true }),
    );
    if (schemaVersion > 9) {
      this.sql.close();
      throw new Error(
        "Deze database is gemaakt door een nieuwere versie van Benchdesk.",
      );
    }
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS companies (id TEXT PRIMARY KEY,name TEXT NOT NULL,workspace_path TEXT NOT NULL,color TEXT NOT NULL,product TEXT NOT NULL,audience TEXT NOT NULL,stage TEXT NOT NULL,bottleneck TEXT NOT NULL,sources TEXT NOT NULL,revision INTEGER NOT NULL,last_checkin_at TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS departments (id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),name TEXT NOT NULL,description TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),name TEXT NOT NULL,description TEXT NOT NULL,workspace_path TEXT NOT NULL,goal_id TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),title TEXT NOT NULL,metric TEXT NOT NULL,unit TEXT NOT NULL,baseline REAL NOT NULL,current REAL NOT NULL,target REAL NOT NULL,due_date TEXT NOT NULL,is_primary INTEGER NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),project_id TEXT NOT NULL REFERENCES projects(id),goal_id TEXT,title TEXT NOT NULL,description TEXT NOT NULL,definition_done TEXT NOT NULL,due_date TEXT NOT NULL,estimate_minutes INTEGER NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,pinned INTEGER NOT NULL,must_do INTEGER NOT NULL,dependencies TEXT NOT NULL,rank INTEGER NOT NULL,priority_reason TEXT NOT NULL,priority_evidence TEXT NOT NULL,confidence TEXT NOT NULL,result_summary TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),task_id TEXT REFERENCES tasks(id),provider TEXT NOT NULL,mode TEXT NOT NULL,state TEXT NOT NULL,provider_session_id TEXT,cwd TEXT NOT NULL,output_dir TEXT NOT NULL,token_hash TEXT NOT NULL,basis_revision INTEGER NOT NULL,last_hook_at REAL NOT NULL,error TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),task_id TEXT,session_id TEXT,kind TEXT NOT NULL,summary TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),task_id TEXT NOT NULL REFERENCES tasks(id),session_id TEXT,path TEXT NOT NULL,name TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),session_id TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,basis_revision INTEGER NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkins (id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),note TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_company ON tasks(company_id); CREATE INDEX IF NOT EXISTS event_company ON events(company_id,created_at);
    `);
    // Additive migration: keep existing companies, sessions and result paths.
    this.sql.transaction(() => {
      const add = (table: string, column: string, definition: string) => {
        const columns = this.sql
          .prepare(`PRAGMA table_info(${table})`)
          .all() as { name: string }[];
        if (!columns.some((c) => c.name === column))
          this.sql.exec(
            `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`,
          );
      };
      add("projects", "department_id", "TEXT REFERENCES departments(id)");
      add("projects", "due_date", "TEXT NOT NULL DEFAULT ''");
      add("tasks", "criteria", "TEXT NOT NULL DEFAULT '[]'");
      add("tasks", "provider", "TEXT NOT NULL DEFAULT 'claude'");
      add("tasks", "model", "TEXT NOT NULL DEFAULT ''");
      add("tasks", "recurrence", "TEXT NOT NULL DEFAULT 'none'");
      add("tasks", "scheduled_date", "TEXT NOT NULL DEFAULT ''");
      add("tasks", "next_occurrence_date", "TEXT NOT NULL DEFAULT ''");
      this.sql.exec(`CREATE TABLE IF NOT EXISTS task_completions (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
        occurrence_date TEXT NOT NULL, completed_at TEXT NOT NULL,
        summary TEXT NOT NULL, criteria TEXT NOT NULL,
        UNIQUE(task_id, occurrence_date)
      );`);
      add(
        "sessions",
        "context_options",
        `TEXT NOT NULL DEFAULT '{"assignment":true,"criteria":true,"business":true}'`,
      );
      add("checkins", "measurements", "TEXT NOT NULL DEFAULT '[]'");
      add("sessions", "memory", "TEXT");
      add("sessions", "memory_dirty", "INTEGER NOT NULL DEFAULT 0");
      add("sessions", "memory_reminded", "INTEGER NOT NULL DEFAULT 0");
      add("sessions", "resume_from", "TEXT");
      add("sessions", "account_id", "TEXT");
      add("sessions", "account_config_dir", "TEXT NOT NULL DEFAULT ''");
      add("sessions", "purpose", "TEXT NOT NULL DEFAULT 'work'");
      if (schemaVersion < 2)
        for (const t of this.sql
          .prepare(
            "SELECT id, definition_done, kind FROM tasks WHERE criteria='[]'",
          )
          .all() as any[]) {
          const criteria = t.definition_done
            .split(/\n+/)
            .map((text: string) =>
              text.replace(/^\s*[-*]\s*(\[[ x]\]\s*)?/, "").trim(),
            )
            .filter(Boolean)
            .map((text: string) => ({
              id: id(),
              text,
              checked: false,
              comment: "",
              agentNote: "",
              evidence: null,
            }));
          this.sql
            .prepare("UPDATE tasks SET criteria=?, provider=? WHERE id=?")
            .run(
              JSON.stringify(criteria),
              t.kind === "human" ? "shell" : "claude",
              t.id,
            );
        }
      add("tasks", "agent_id", "TEXT");
      add("sessions", "agent_id", "TEXT");
      add("sessions", "conversation_id", "TEXT");
      add("sessions", "transport", "TEXT NOT NULL DEFAULT 'pty'");
      this.sql.pragma("user_version = 9");
    })();
    this.db = drizzle(this.sql);
    this.agents = new AgentStore(this.sql);
    this.brain = new BrainStore(this.sql, resolve(dirname(path), "brain"));
  }
  close() {
    this.sql.close();
  }
  company(id: string) {
    const row = this.db
      .select()
      .from(s.companies)
      .where(eq(s.companies.id, id))
      .get();
    if (!row) throw new Error("Bedrijf niet gevonden.");
    return row;
  }
  task(id: string) {
    const row = this.db.select().from(s.tasks).where(eq(s.tasks.id, id)).get();
    if (!row) throw new Error("Taak niet gevonden.");
    return row;
  }
  session(id: string) {
    const row = this.db
      .select()
      .from(s.sessions)
      .where(eq(s.sessions.id, id))
      .get();
    if (!row) throw new Error("Gesprek niet gevonden.");
    return row;
  }
  bump(companyId: string) {
    const c = this.company(companyId);
    this.db
      .update(s.companies)
      .set({ revision: c.revision + 1, updatedAt: now() })
      .where(eq(s.companies.id, companyId))
      .run();
  }
  event(
    companyId: string,
    taskId: string | null,
    sessionId: string | null,
    kind: string,
    summary: string,
    eventId: string = id(),
  ) {
    return (
      this.db
        .insert(s.events)
        .values({
          id: eventId,
          companyId,
          taskId,
          sessionId,
          kind,
          summary: summary.slice(0, 30000),
          createdAt: now(),
        })
        .onConflictDoNothing()
        .run().changes > 0
    );
  }
  snapshot(): Snapshot {
    this.refreshRecurringTasks();
    return {
      agents: this.agents.profiles(),
      agentConversations: this.agents.conversations(),
      companies: this.db.select().from(s.companies).all(),
      departments: this.db.select().from(s.departments).all(),
      projects: this.db.select().from(s.projects).all(),
      goals: this.db.select().from(s.goals).all(),
      tasks: this.db.select().from(s.tasks).all(),
      sessions: this.db
        .select()
        .from(s.sessions)
        .all()
        .map(
          ({ tokenHash, basisRevision, lastHookAt, memoryReminded, ...row }) =>
            row,
        ),
      events: this.db
        .select()
        .from(s.events)
        .where(notLike(s.events.kind, "hook:%"))
        .orderBy(desc(s.events.createdAt))
        .limit(300)
        .all(),
      artifacts: this.db.select().from(s.artifacts).all(),
      proposals: this.db
        .select()
        .from(s.proposals)
        .orderBy(desc(s.proposals.createdAt))
        .all(),
      checkins: this.db
        .select()
        .from(s.checkins)
        .orderBy(desc(s.checkins.createdAt))
        .all(),
    } as Snapshot;
  }
  saveCompany(input: unknown, companyId?: string) {
    const value = companyInput.parse(input);
    value.workspacePath = folder(value.workspacePath);
    if (companyId) {
      this.company(companyId);
      this.db
        .update(s.companies)
        .set({ ...value, updatedAt: now() })
        .where(eq(s.companies.id, companyId))
        .run();
      this.bump(companyId);
      return companyId;
    }
    const company = {
      ...value,
      id: id(),
      revision: 0,
      lastCheckinAt: "",
      createdAt: now(),
      updatedAt: now(),
    };
    this.db.insert(s.companies).values(company).run();
    return company.id;
  }
  checkGoal(goalId: string | null, companyId: string) {
    if (
      goalId &&
      !this.db
        .select()
        .from(s.goals)
        .where(and(eq(s.goals.id, goalId), eq(s.goals.companyId, companyId)))
        .get()
    )
      throw new Error("Het doel hoort niet bij dit bedrijf.");
  }
  saveDepartment(input: unknown, departmentId?: string) {
    const value = departmentInput.parse(input);
    this.company(value.companyId);
    const all = this.db
      .select()
      .from(s.departments)
      .where(eq(s.departments.companyId, value.companyId))
      .all();
    if (departmentId && !all.some((d) => d.id === departmentId))
      throw new Error("Afdeling niet gevonden bij dit bedrijf.");
    if (
      all.some(
        (d) =>
          d.id !== departmentId &&
          d.name.toLocaleLowerCase() === value.name.toLocaleLowerCase(),
      )
    )
      throw new Error("Er bestaat al een afdeling met deze naam.");
    return this.sql.transaction(() => {
      const key = departmentId || id();
      if (departmentId)
        this.db
          .update(s.departments)
          .set(value)
          .where(eq(s.departments.id, key))
          .run();
      else
        this.db
          .insert(s.departments)
          .values({ ...value, id: key, createdAt: now() })
          .run();
      this.bump(value.companyId);
      return key;
    })();
  }
  removeDepartment(departmentId: string) {
    const d = this.db
      .select()
      .from(s.departments)
      .where(eq(s.departments.id, departmentId))
      .get();
    if (!d) throw new Error("Afdeling niet gevonden.");
    if (
      this.db
        .select()
        .from(s.projects)
        .where(eq(s.projects.departmentId, departmentId))
        .get()
    )
      throw new Error(
        "Verplaats eerst de projecten naar een andere afdeling of kies Zonder afdeling.",
      );
    this.sql.transaction(() => {
      this.db
        .delete(s.departments)
        .where(eq(s.departments.id, departmentId))
        .run();
      this.bump(d.companyId);
    })();
  }
  saveProject(input: unknown, projectId?: string) {
    const value = projectInput.parse(input);
    this.company(value.companyId);
    this.checkGoal(value.goalId, value.companyId);
    if (
      value.departmentId &&
      !this.db
        .select()
        .from(s.departments)
        .where(
          and(
            eq(s.departments.id, value.departmentId),
            eq(s.departments.companyId, value.companyId),
          ),
        )
        .get()
    )
      throw new Error("De afdeling hoort niet bij dit bedrijf.");
    if (value.workspacePath) value.workspacePath = folder(value.workspacePath);
    if (projectId) {
      const p = this.db
        .select()
        .from(s.projects)
        .where(eq(s.projects.id, projectId))
        .get();
      if (!p || p.companyId !== value.companyId)
        throw new Error("Project niet gevonden.");
      this.db
        .update(s.projects)
        .set(value)
        .where(eq(s.projects.id, projectId))
        .run();
    } else {
      projectId = id();
      this.db
        .insert(s.projects)
        .values({ ...value, id: projectId, createdAt: now() })
        .run();
    }
    this.bump(value.companyId);
    return projectId;
  }
  saveGoal(input: unknown, goalId?: string) {
    const value = goalInput.parse(input);
    this.company(value.companyId);
    if (goalId) this.checkGoal(goalId, value.companyId);
    return this.sql.transaction(() => {
      if (value.primary)
        this.db
          .update(s.goals)
          .set({ primary: false })
          .where(eq(s.goals.companyId, value.companyId))
          .run();
      if (goalId)
        this.db
          .update(s.goals)
          .set({ ...value, updatedAt: now() })
          .where(eq(s.goals.id, goalId))
          .run();
      else {
        goalId = id();
        this.db
          .insert(s.goals)
          .values({ ...value, id: goalId, updatedAt: now() })
          .run();
      }
      this.bump(value.companyId);
      return goalId!;
    })();
  }
  saveTask(input: unknown, taskId?: string) {
    return this.sql.transaction(() => this.writeTask(input, taskId))();
  }
  private writeTask(input: unknown, taskId?: string) {
    const value = taskInput.parse(input);
    if (value.agentId) {
      const agent = this.agents.profile(value.agentId);
      if (agent.companyId !== value.companyId) throw new Error("De agent hoort niet bij dit bedrijf.");
      value.provider = agent.provider;
      value.kind = "ai";
    }
    const previous = taskId ? this.task(taskId) : null;
    const today = localDate(this.clock());
    if (value.recurrence !== "none" && !value.scheduledDate)
      value.scheduledDate = today;
    const scheduleChanged =
      !previous ||
      value.recurrence !== previous.recurrence ||
      value.scheduledDate !== previous.scheduledDate;
    const rescheduled =
      previous?.status === "done" &&
      value.status === "done" &&
      scheduleChanged &&
      value.scheduledDate > today;
    if (rescheduled) {
      value.status = "todo";
      value.criteria = value.criteria.map((c) => ({
        ...c,
        checked: false,
        comment: "",
        agentNote: "",
        evidence: null,
      }));
    }
    const completing = value.status === "done" && previous?.status !== "done";
    const nextDate =
      value.status === "done" && value.recurrence !== "none"
        ? completing || scheduleChanged
          ? nextOccurrence(value.scheduledDate, value.recurrence, today)
          : previous?.nextOccurrenceDate || ""
        : "";
    if (!value.criteria.length && value.definitionDone.trim()) {
      value.criteria = value.definitionDone
        .split(/\n+/)
        .map((line) => line.replace(/^\s*[-*]\s*(\[[ x]\]\s*)?/, "").trim())
        .filter(Boolean)
        .map(
          (text) =>
            previous?.criteria.find((c) => c.text === text) ||
            criterionInput.parse({ id: id(), text }),
        );
    }
    value.definitionDone = value.criteria.map((c) => c.text).join("\n");
    if (new Set(value.criteria.map((c) => c.id)).size !== value.criteria.length)
      throw new Error("Elk criterium moet een eigen ID hebben.");
    if (value.kind === "human") value.provider = "shell";
    if (value.provider !== "codex" || value.agentId) value.model = "";
    this.company(value.companyId);
    this.checkGoal(value.goalId, value.companyId);
    const project = this.db
      .select()
      .from(s.projects)
      .where(eq(s.projects.id, value.projectId))
      .get();
    if (!project || project.companyId !== value.companyId)
      throw new Error("Het project hoort niet bij dit bedrijf.");
    if (taskId && this.task(taskId).companyId !== value.companyId)
      throw new Error("De taak hoort niet bij dit bedrijf.");
    for (const dep of value.dependencies) {
      if (dep === taskId || this.task(dep).companyId !== value.companyId)
        throw new Error("Ongeldige afhankelijkheid.");
      const visited = new Set<string>();
      const walk = (other: string): boolean => {
        if (other === taskId) return true;
        if (visited.has(other)) return false;
        visited.add(other);
        return this.task(other).dependencies.some(walk);
      };
      if (taskId && walk(dep))
        throw new Error("Deze afhankelijkheid maakt een cirkel.");
    }
    if (
      ["in_progress", "review", "done"].includes(value.status) &&
      value.dependencies.some((dep) => this.task(dep).status !== "done")
    )
      throw new Error("Rond eerst de afhankelijkheden af.");
    if (taskId)
      this.db
        .update(s.tasks)
        .set({
          ...value,
          ...(rescheduled ? { resultSummary: "" } : {}),
          nextOccurrenceDate: nextDate,
          updatedAt: now(),
        })
        .where(eq(s.tasks.id, taskId))
        .run();
    else {
      taskId = id();
      this.db
        .insert(s.tasks)
        .values({
          ...value,
          nextOccurrenceDate: nextDate,
          id: taskId,
          rank: this.db.select().from(s.tasks).all().length,
          priorityReason: "",
          priorityEvidence: [],
          confidence: "",
          resultSummary: "",
          createdAt: now(),
          updatedAt: now(),
        })
        .run();
    }
    if (completing) {
      const occurrenceDate = value.scheduledDate || today;
      this.sql
        .prepare(
          `INSERT INTO task_completions (id,task_id,occurrence_date,completed_at,summary,criteria)
        VALUES (?,?,?,?,?,?) ON CONFLICT(task_id,occurrence_date) DO UPDATE SET
        completed_at=excluded.completed_at,summary=excluded.summary,criteria=excluded.criteria`,
        )
        .run(
          id(),
          taskId,
          occurrenceDate,
          this.clock().toISOString(),
          previous?.resultSummary || "",
          JSON.stringify(value.criteria),
        );
    }
    this.bump(value.companyId);
    return taskId;
  }
  refreshRecurringTasks() {
    const today = localDate(this.clock());
    const rows = this.sql
      .prepare(
        "SELECT id FROM tasks WHERE status='done' AND recurrence!='none' AND next_occurrence_date!='' AND next_occurrence_date<=?",
      )
      .all(today) as { id: string }[];
    this.sql.transaction(() => {
      for (const { id: taskId } of rows) {
        const task = this.task(taskId);
        this.db
          .update(s.tasks)
          .set({
            status: "todo",
            scheduledDate: task.nextOccurrenceDate,
            nextOccurrenceDate: "",
            criteria: task.criteria.map((c) => ({
              ...c,
              checked: false,
              comment: "",
              agentNote: "",
              evidence: null,
            })),
            resultSummary: "",
            priorityReason: "",
            priorityEvidence: [],
            confidence: "",
            updatedAt: this.clock().toISOString(),
          })
          .where(eq(s.tasks.id, taskId))
          .run();
        this.event(
          task.companyId,
          taskId,
          null,
          "recurrence",
          `Nieuwe uitvoering gepland voor ${task.nextOccurrenceDate}.`,
        );
        this.bump(task.companyId);
      }
    })();
    return rows.length;
  }
  taskHistory(taskId: string) {
    this.task(taskId);
    return this.db
      .select()
      .from(s.taskCompletions)
      .where(eq(s.taskCompletions.taskId, taskId))
      .orderBy(desc(s.taskCompletions.completedAt))
      .limit(30)
      .all();
  }
  patchTask(taskId: string, patch: unknown) {
    const task = this.task(taskId);
    const value = taskInput.partial().parse(patch);
    if (value.definitionDone !== undefined && value.criteria === undefined)
      value.criteria = [];
    const base = taskInput.parse(
      Object.fromEntries(
        Object.keys(taskInput.shape).map((k) => [k, (task as any)[k]]),
      ),
    );
    return this.saveTask({ ...base, ...value }, taskId);
  }
  removeTask(taskId: string) {
    const task = this.task(taskId);
    return this.sql.transaction(() => {
      for (const conversation of this.agents.conversations())
        if (conversation.taskId === taskId)
          this.agents.updateConversation(conversation.id, { taskId: null });
      for (const dependent of this.db.select().from(s.tasks).all())
        if (dependent.dependencies.includes(taskId))
          this.db
            .update(s.tasks)
            .set({
              dependencies: dependent.dependencies.filter(
                (dependency) => dependency !== taskId,
              ),
              updatedAt: now(),
            })
            .where(eq(s.tasks.id, dependent.id))
            .run();
      for (const proposal of this.db.select().from(s.proposals).all())
        if (JSON.stringify(proposal.payload).includes(taskId))
          this.db
            .delete(s.proposals)
            .where(eq(s.proposals.id, proposal.id))
            .run();
      this.db
        .update(s.sessions)
        .set({ taskId: null, updatedAt: now() })
        .where(eq(s.sessions.taskId, taskId))
        .run();
      this.db
        .update(s.events)
        .set({ taskId: null })
        .where(eq(s.events.taskId, taskId))
        .run();
      this.db
        .delete(s.artifacts)
        .where(eq(s.artifacts.taskId, taskId))
        .run();
      this.db
        .delete(s.taskCompletions)
        .where(eq(s.taskCompletions.taskId, taskId))
        .run();
      this.db.delete(s.tasks).where(eq(s.tasks.id, taskId)).run();
      this.event(
        task.companyId,
        null,
        null,
        "task_removed",
        `Taak verwijderd: ${task.title}`,
      );
      this.bump(task.companyId);
    })();
  }
  completeTask(taskId: string, note: string) {
    return this.sql.transaction(() => {
      if (this.task(taskId).status === "done") return;
      this.patchTask(taskId, { status: "done" });
      const t = this.task(taskId);
      if (note)
        this.db
          .update(s.tasks)
          .set({ resultSummary: note.slice(0, 30000) })
          .where(eq(s.tasks.id, taskId))
          .run();
      this.db
        .update(s.taskCompletions)
        .set({ summary: note || t.resultSummary })
        .where(
          and(
            eq(s.taskCompletions.taskId, taskId),
            eq(
              s.taskCompletions.occurrenceDate,
              t.scheduledDate || localDate(this.clock()),
            ),
          ),
        )
        .run();
      this.event(
        t.companyId,
        taskId,
        null,
        "completed",
        note || "Resultaat beoordeeld en taak afgerond.",
      );
    })();
  }
  reviewCriterion(taskId: string, criterionId: string, patch: unknown) {
    const task = this.task(taskId);
    const value = criterionInput
      .pick({ checked: true, comment: true })
      .partial()
      .strict()
      .parse(patch);
    if (!task.criteria.some((c) => c.id === criterionId))
      throw new Error("Criterium niet gevonden.");
    this.patchTask(taskId, {
      criteria: task.criteria.map((c) =>
        c.id === criterionId ? { ...c, ...value } : c,
      ),
    });
  }
  returnTask(taskId: string) {
    const task = this.task(taskId);
    if (task.status !== "review")
      throw new Error("Deze taak staat niet ter beoordeling.");
    const comments = task.criteria.filter(
      (c) => !c.checked && c.comment.trim(),
    );
    if (!comments.length)
      throw new Error("Voeg een opmerking toe bij een open criterium.");
    const message = `Graag aanpassen op basis van mijn beoordeling:\n${comments.map((c) => `- ${c.text}: ${c.comment}`).join("\n")}\nDien het aangepaste resultaat daarna opnieuw ter beoordeling in.`;
    this.patchTask(taskId, { status: "in_progress" });
    this.event(task.companyId, taskId, null, "review_feedback", message);
    return message;
  }
  reorderTasks(projectId: string, taskIds: string[]) {
    z.array(z.string()).max(50000).parse(taskIds);
    const tasks = this.snapshot().tasks.filter(
      (t) => t.projectId === projectId,
    );
    if (
      !tasks.length ||
      tasks.length !== taskIds.length ||
      new Set(taskIds).size !== taskIds.length ||
      taskIds.some((id) => !tasks.some((t) => t.id === id))
    )
      throw new Error(
        "De takenlijst is gewijzigd. Ververs en probeer opnieuw.",
      );
    this.sql.transaction(() => {
      const slots = tasks.map((t) => t.rank).sort((a, b) => a - b);
      taskIds.forEach((id, index) =>
        this.sql
          .prepare("UPDATE tasks SET rank=? WHERE id=?")
          .run(slots[index], id),
      );
      this.bump(tasks[0].companyId);
    })();
  }
  checkin(
    companyId: string,
    note: string,
    values: { goalId: string; current: number }[],
  ) {
    this.company(companyId);
    z.string().min(1).max(30000).parse(note);
    return this.sql.transaction(() => {
      const measurements = values.map((value) => {
        this.checkGoal(value.goalId, companyId);
        const g = this.db
          .select()
          .from(s.goals)
          .where(eq(s.goals.id, value.goalId))
          .get()!;
        return {
          goalId: g.id,
          title: g.title,
          before: g.current,
          after: value.current,
          unit: g.unit,
        };
      });
      for (const value of values) {
        this.checkGoal(value.goalId, companyId);
        z.number().finite().parse(value.current);
        this.db
          .update(s.goals)
          .set({ current: value.current, updatedAt: now() })
          .where(eq(s.goals.id, value.goalId))
          .run();
      }
      this.db
        .insert(s.checkins)
        .values({ id: id(), companyId, note, measurements, createdAt: now() })
        .run();
      this.db
        .update(s.companies)
        .set({ lastCheckinAt: now() })
        .where(eq(s.companies.id, companyId))
        .run();
      this.bump(companyId);
      this.event(companyId, null, null, "checkin", note);
    })();
  }
  addArtifact(taskId: string, file: string, sessionId: string | null = null) {
    const task = this.task(taskId);
    let path = file;
    if (/^https?:\/\//.test(file)) {
      new URL(file);
    } else {
      path = realpathSync(file);
      if (!statSync(path).isFile()) throw new Error("Selecteer een bestand.");
      if (sessionId && !inside(folder(this.session(sessionId).cwd), path))
        throw new Error("Resultaat moet in de gekoppelde werkmap staan.");
    }
    const existing = this.db
      .select()
      .from(s.artifacts)
      .where(and(eq(s.artifacts.taskId, taskId), eq(s.artifacts.path, path)))
      .get();
    if (existing) return existing.id;
    const artifactId = id();
    this.db
      .insert(s.artifacts)
      .values({
        id: artifactId,
        companyId: task.companyId,
        taskId,
        sessionId,
        path,
        name: basename(path),
        createdAt: now(),
      })
      .run();
    return artifactId;
  }
  fullContext(sessionId: string) {
    const session = this.session(sessionId),
      snap = this.snapshot(),
      company = this.company(session.companyId);
    this.db
      .update(s.sessions)
      .set({ basisRevision: company.revision })
      .where(eq(s.sessions.id, sessionId))
      .run();
    return {
      company,
      goals: snap.goals.filter((g) => g.companyId === company.id),
      departments: snap.departments.filter((d) => d.companyId === company.id),
      projects: snap.projects.filter((p) => p.companyId === company.id),
      tasks: snap.tasks.filter((t) => t.companyId === company.id),
      task: session.taskId ? (this.task(session.taskId) as Task) : null,
      recentUpdates: snap.events
        .filter(
          (e) =>
            e.companyId === company.id &&
            (!session.taskId || e.taskId === session.taskId),
        )
        .slice(0, 20),
      recentCheckins: snap.checkins
        .filter((c) => c.companyId === company.id)
        .slice(0, 3),
      artifacts: snap.artifacts.filter(
        (a) =>
          a.companyId === company.id &&
          (!session.taskId || a.taskId === session.taskId),
      ),
      sessionMemory: session.memory,
      sessionMemoryPending: session.memoryDirty,
      relatedSessionMemories: session.taskId
        ? snap.sessions
            .filter(
              (s) =>
                s.id !== sessionId &&
                s.companyId === company.id &&
                s.taskId === session.taskId &&
                s.memory &&
                (!session.providerSessionId ||
                  s.providerSessionId !== session.providerSessionId ||
                  s.accountConfigDir !== session.accountConfigDir),
            )
            .sort((a, b) =>
              b.memory!.updatedAt.localeCompare(a.memory!.updatedAt),
            )
            .slice(0, 3)
            .map((s) => ({
              sessionId: s.id,
              memory: s.memory,
              pending: s.memoryDirty,
            }))
        : [],
      ...(session.mode === "suggestions"
        ? {
            companySessionMemories: snap.sessions
              .filter(
                (s) =>
                  s.companyId === company.id &&
                  s.memory &&
                  (!s.purpose || s.purpose === "work"),
              )
              .map((s) => ({
                sessionId: s.id,
                taskId: s.taskId,
                memory: s.memory,
                pending: s.memoryDirty,
              })),
            previousSuggestions: snap.proposals
              .filter(
                (p) => p.companyId === company.id && p.kind === "suggestions",
              )
              .slice(0, 5),
          }
        : {}),
      // Older sessions retain outputDir so their existing results stay discoverable.
      // New work always belongs in the session's chosen workspace.
      outputDirectory: session.cwd,
      revision: company.revision,
    };
  }
  context(sessionId: string) {
    const result = this.fullContext(sessionId);
    const options = sessionContextInput.parse(
      this.session(sessionId).contextOptions,
    );
    if (this.session(sessionId).mode !== "work") return result;
    const cleanTask = (task: (typeof result.tasks)[number]) => ({
      ...task,
      ...(!options.assignment
        ? { description: "", definitionDone: "", resultSummary: "" }
        : {}),
      ...(!options.criteria ? { criteria: [], definitionDone: "" } : {}),
    });
    result.tasks = result.tasks.map(cleanTask);
    if (result.task) result.task = cleanTask(result.task);
    if (!options.assignment) {
      result.artifacts = [];
      result.recentUpdates = [];
      result.relatedSessionMemories = [];
    }
    if (!options.business) {
      result.company = {
        ...result.company,
        product: "",
        audience: "",
        stage: "",
        bottleneck: "",
        sources: [],
      };
      result.goals = [];
      result.departments = [];
      result.recentCheckins = [];
      result.projects = result.projects
        .filter((p) => p.id === result.task?.projectId)
        .map((p) => ({ ...p, description: "", goalId: null }));
      result.tasks = result.task ? [result.task] : [];
      result.recentUpdates = result.recentUpdates.filter(
        (e) => e.taskId === result.task?.id,
      );
      result.artifacts = result.artifacts.filter(
        (a) => a.taskId === result.task?.id,
      );
    }
    return result;
  }
  createSession(input: {
    agentId?: string | null;
    conversationId?: string | null;
    transport?: "pty" | "chat";
    companyId: string;
    taskId: string | null;
    provider: Session["provider"];
    mode: Session["mode"];
    cwd: string;
    outputDir: string;
    token: string;
    providerSessionId?: string;
    accountId?: string | null;
    accountConfigDir?: string;
    purpose?: "work" | "login" | "logout";
    resumeFrom?: string;
    contextOptions?: SessionContextOptions;
  }) {
    const c = this.company(input.companyId);
    if (input.taskId && this.task(input.taskId).companyId !== c.id)
      throw new Error("Gesprek en taak horen niet bij hetzelfde bedrijf.");
    const previous = input.resumeFrom ? this.session(input.resumeFrom) : null;
    if (
      previous &&
      (previous.companyId !== c.id ||
        previous.taskId !== input.taskId ||
        previous.provider !== input.provider ||
        previous.accountId !== (input.accountId || null) ||
        previous.accountConfigDir !== (input.accountConfigDir || ""))
    )
      throw new Error("Gesprek kan niet met deze notities worden hervat.");
    // An older row can resume the same provider conversation again. Use the
    // latest checkpoint of that exact conversation/account, not an old copy.
    const memorySource = previous?.providerSessionId
      ? this.snapshot()
          .sessions.filter(
            (s) =>
              s.companyId === previous.companyId &&
              s.taskId === previous.taskId &&
              s.provider === previous.provider &&
              s.providerSessionId === previous.providerSessionId &&
              s.accountId === previous.accountId &&
              s.accountConfigDir === previous.accountConfigDir &&
              s.memory,
          )
          .sort(
            (a, b) =>
              b.memory!.updatedAt.localeCompare(a.memory!.updatedAt) ||
              b.memory!.revision - a.memory!.revision,
          )[0] || previous
      : previous;
    const sessionId = id();
    this.db
      .insert(s.sessions)
      .values({
        id: sessionId,
        agentId: input.agentId || null,
        conversationId: input.conversationId || null,
        transport: input.transport || "pty",
        contextOptions: sessionContextInput.parse(
          input.contextOptions || previous?.contextOptions,
        ),
        memory: memorySource?.memory || null,
        memoryDirty: memorySource?.memoryDirty || false,
        resumeFrom: memorySource?.id || null,
        companyId: c.id,
        taskId: input.taskId,
        provider: input.provider,
        accountId: input.accountId || null,
        accountConfigDir: input.accountConfigDir || "",
        purpose: input.purpose || "work",
        mode: input.mode,
        state: "starting",
        providerSessionId: input.providerSessionId || null,
        cwd: input.cwd,
        outputDir: input.outputDir,
        tokenHash: hash(input.token),
        basisRevision: c.revision,
        lastHookAt: 0,
        error: "",
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    return sessionId;
  }
  setSession(
    sessionId: string,
    patch: Partial<typeof s.sessions.$inferInsert>,
  ) {
    this.db
      .update(s.sessions)
      .set({ ...patch, updatedAt: now() })
      .where(eq(s.sessions.id, sessionId))
      .run();
  }
  recover() {
    for (const c of this.agents.conversations()) this.agents.finishPending(c.id);
    for (const row of this.db.select().from(s.sessions).all())
      if (!["ended", "error", "interrupted"].includes(row.state))
        this.setSession(row.id, {
          state: "interrupted",
          error:
            "De achtergrondservice is opnieuw gestart. Hervat het gesprek expliciet.",
          tokenHash: "",
        });
  }
  saveSessionMemory(
    sessionId: string,
    input: unknown,
    expectedRevision: unknown,
    source: "assistant" | "user",
  ) {
    const value = sessionMemoryInput.parse(input);
    const revision = z.number().int().nonnegative().parse(expectedRevision);
    return this.sql.transaction(() => {
      const session = this.session(sessionId);
      if (session.purpose !== "work")
        throw new Error("Inloggesprekken hebben geen notities.");
      if ((session.memory?.revision || 0) !== revision)
        throw new Error(
          "De notities zijn ondertussen gewijzigd. Lees ze opnieuw voordat je opslaat.",
        );
      const memory = {
        ...value,
        revision: revision + 1,
        updatedAt: now(),
        source,
      };
      this.setSession(sessionId, { memory, memoryDirty: false });
      return memory;
    })();
  }
  confirmSessionMemory(sessionId: string, expectedRevision: unknown) {
    const revision = z.number().int().positive().parse(expectedRevision);
    const session = this.session(sessionId);
    if (!session.memory || session.memory.revision !== revision)
      throw new Error("Lees eerst het actuele sessiegeheugen.");
    this.setSession(sessionId, { memoryDirty: false });
    return { revision, unchanged: true };
  }
  authenticate(sessionId: string, token: string) {
    const session = this.session(sessionId);
    if (!token || session.tokenHash !== hash(token))
      throw new Error("Ongeldige sessietoegang.");
    return session;
  }
  hook(sessionId: string, payload: any) {
    const event = z
      .object({
        id: z.string().uuid(),
        name: z.string(),
        at: z.number().finite(),
        providerSessionId: z.string().max(500).optional(),
        source: z.string().optional(),
        stopHookActive: z.boolean().optional(),
        toolName: z.string().max(500).optional(),
      })
      .parse(payload);
    const session = this.session(sessionId);
    const states: Record<string, string> = {
      SessionStart: "idle",
      UserPromptSubmit: "working",
      PermissionRequest: "waiting",
      PreToolUse: "working",
      PostToolUse: "working",
      PostToolUseFailure: "working",
      Stop: "idle",
      StopFailure: "error",
      SessionEnd: "idle",
      LaunchStart: "starting",
      LaunchEnd: "idle",
    };
    if (!(event.name in states)) return;
    if (
      !this.event(
        session.companyId,
        session.taskId,
        sessionId,
        `hook:${event.name}`,
        event.name,
        event.id,
      )
    )
      return;
    if (event.at < session.lastHookAt) return;
    this.setSession(sessionId, {
      state: states[event.name],
      ...(event.name === "UserPromptSubmit"
        ? { memoryDirty: true, memoryReminded: false }
        : {}),
      ...(event.name === "PostToolUse" &&
      !/(?:save_session_memory|patch_session_memory|confirm_session_memory|get_task_context|search_company_brain|read_brain_page|read_brain_source|list_brain_pending|get_context_details|save_brain_changes)$/.test(
        event.toolName || "",
      )
        ? { memoryDirty: true }
        : {}),
      lastHookAt: event.at,
      ...(event.name === "SessionStart" && event.providerSessionId
        ? { providerSessionId: event.providerSessionId }
        : {}),
    });
    if (
      event.name === "Stop" &&
      !event.stopHookActive &&
      !session.memoryReminded &&
      session.provider !== "shell" &&
      session.purpose === "work" &&
      (!session.memory || session.memoryDirty)
    ) {
      this.setSession(sessionId, { memoryReminded: true, state: "working" });
      return {
        memoryReminder:
          memoryInstruction +
          ` Huidige geheugenrevisie: ${session.memory?.revision || 0}. Werk alleen het geheugen bij; start geen nieuwe taken.`,
      };
    }
    if (event.name === "UserPromptSubmit" || event.name === "SessionStart")
      return { contextTurn: event.id };
  }
  agentCall(sessionId: string, name: string, args: any) {
    const session = this.session(sessionId);
    if (
      session.taskId &&
      ["report_progress", "submit_result"].includes(name) &&
      this.task(session.taskId).recurrence !== "none" &&
      this.sql
        .prepare(
          "SELECT 1 FROM task_completions WHERE task_id=? AND completed_at>=? LIMIT 1",
        )
        .get(session.taskId, session.createdAt)
    )
      throw new Error(
        "Deze sessie hoort bij een afgeronde uitvoering. Start een nieuw gesprek voor de volgende uitvoering.",
      );
    if (name === "get_task_context") return this.context(sessionId);
    if (name === "propose_next_actions")
      return this.proposeNextActions(sessionId, args);
    if (name === "save_session_memory")
      return this.saveSessionMemory(
        sessionId,
        args,
        args.expectedRevision,
        "assistant",
      );
    if (name === "confirm_session_memory")
      return this.confirmSessionMemory(sessionId, args.expectedRevision);
    if (name === "report_progress") {
      const a = z
        .object({
          summary: z.string().min(1).max(12000),
          blocked: z.boolean().default(false),
        })
        .parse(args);
      if (!session.taskId)
        throw new Error("Deze sessie is een bedrijfsanalyse.");
      const t = this.task(session.taskId);
      if (t.status === "done") throw new Error("De taak is al afgerond.");
      this.patchTask(t.id, { status: a.blocked ? "blocked" : "in_progress" });
      this.event(
        session.companyId,
        t.id,
        sessionId,
        a.blocked ? "blocked" : "progress",
        a.summary,
      );
      return { ok: true };
    }
    if (name === "submit_result") {
      const a = z
        .object({
          summary: z.string().min(1).max(30000),
          files: z.array(z.string()).max(50).default([]),
          criteria: z
            .array(
              z.object({
                id: z.string(),
                note: z.string().max(4000),
                evidence: criterionInput.shape.evidence,
              }),
            )
            .max(100)
            .default([]),
        })
        .parse(args);
      if (!session.taskId) throw new Error("Deze sessie heeft geen taak.");
      if (this.task(session.taskId).status === "done")
        throw new Error("Deze taak is al afgerond.");
      return this.sql.transaction(() => {
        for (const file of a.files)
          this.addArtifact(session.taskId!, file, sessionId);
        const task = this.task(session.taskId!);
        for (const item of a.criteria) {
          if (!task.criteria.some((c) => c.id === item.id))
            throw new Error("Onbekend criterium.");
          if (item.evidence) {
            this.addArtifact(task.id, item.evidence.path, sessionId);
            if (!/^https?:\/\//.test(item.evidence.path))
              item.evidence.path = realpathSync(item.evidence.path);
          }
        }
        this.patchTask(session.taskId!, { status: "review" });
        this.db
          .update(s.tasks)
          .set({
            resultSummary: a.summary,
            criteria: task.criteria.map((c) => {
              const check = a.criteria.find((item) => item.id === c.id);
              return check
                ? { ...c, agentNote: check.note, evidence: check.evidence }
                : c;
            }),
          })
          .where(eq(s.tasks.id, session.taskId!))
          .run();
        this.event(
          session.companyId,
          session.taskId,
          sessionId,
          "result",
          a.summary,
        );
        return { ok: true, status: "review" };
      })();
    }
    let kind: "priorities" | "tasks" | "context", payload: any;
    if (name === "propose_priorities") {
      kind = "priorities";
      payload = z
        .object({
          summary: z.string().max(5000),
          items: z.array(priorityItem).max(200),
        })
        .parse(args);
      const seen = new Set();
      for (const item of payload.items) {
        const t = this.task(item.taskId);
        if (
          t.companyId !== session.companyId ||
          t.status === "done" ||
          seen.has(t.id)
        )
          throw new Error("Ongeldige taak in prioriteitsvoorstel.");
        seen.add(t.id);
      }
    } else if (name === "propose_tasks") {
      kind = "tasks";
      payload = z
        .object({
          summary: z.string().max(5000),
          tasks: z
            .array(taskInput.omit({ companyId: true }))
            .min(1)
            .max(30),
        })
        .parse(args);
      for (const t of payload.tasks) {
        const p = this.db
          .select()
          .from(s.projects)
          .where(eq(s.projects.id, t.projectId))
          .get();
        if (!p || p.companyId !== session.companyId)
          throw new Error("Project buiten dit bedrijf.");
        this.checkGoal(t.goalId, session.companyId);
      }
    } else if (name === "propose_company_context") {
      kind = "context";
      payload = contextInput.parse(args);
    } else throw new Error("Onbekende agentfunctie.");
    const proposalId = id();
    this.db
      .insert(s.proposals)
      .values({
        id: proposalId,
        companyId: session.companyId,
        sessionId,
        kind,
        payload,
        basisRevision: this.session(sessionId).basisRevision,
        status: "pending",
        createdAt: now(),
      })
      .run();
    this.event(
      session.companyId,
      session.taskId,
      sessionId,
      "proposal",
      "Nieuw voorstel klaar voor beoordeling.",
    );
    return {
      ok: true,
      proposalId,
      message: "Het voorstel wacht op de gebruiker. Het is nog niet toegepast.",
    };
  }
  decideProposal(proposalId: string, accept: boolean) {
    const p = this.db
      .select()
      .from(s.proposals)
      .where(eq(s.proposals.id, proposalId))
      .get();
    if (!p || p.status !== "pending")
      throw new Error("Voorstel is al verwerkt of bestaat niet.");
    if (!accept) {
      this.db
        .update(s.proposals)
        .set({ status: "dismissed" })
        .where(eq(s.proposals.id, p.id))
        .run();
      return;
    }
    if (p.kind === "suggestions" && accept)
      throw new Error("Voeg deze voorstellen afzonderlijk toe via Vandaag.");
    if (
      (p.kind === "priorities" || p.kind === "context") &&
      p.basisRevision !== this.company(p.companyId).revision
    )
      throw new Error(
        "Dit advies is verouderd. Vraag een nieuw advies op basis van de huidige taken.",
      );
    if (p.kind === "priorities" && p.payload.decisions) {
      for (const item of p.payload.items)
        if (!p.payload.decisions[item.taskId])
          this.decidePriorityItem(p.id, item.taskId, true);
      return;
    }
    this.sql.transaction(() => {
      if (p.kind === "priorities") {
        const current = this.snapshot()
          .tasks.filter((t) => t.companyId === p.companyId)
          .sort((a, b) => a.rank - b.rank);
        const requested = p.payload.items.map((item: any) => {
          const task = this.task(item.taskId);
          if (task.companyId !== p.companyId || task.status === "done")
            throw new Error("Taak niet beschikbaar voor dit voorstel.");
          return task;
        });
        const order = applyProposedOrder(
          current,
          requested,
          new Set<string>(p.payload.items.map((i: any) => i.taskId)),
        );
        for (const [rank, task] of order.entries())
          this.db
            .update(s.tasks)
            .set({ rank })
            .where(eq(s.tasks.id, task.id))
            .run();
        for (const item of p.payload.items)
          this.db
            .update(s.tasks)
            .set({
              priorityReason: item.reason,
              priorityEvidence: item.evidence,
              confidence: item.confidence,
              pinned: false,
            })
            .where(eq(s.tasks.id, item.taskId))
            .run();
      }
      if (p.kind === "priorities") this.bump(p.companyId);
      if (p.kind === "tasks")
        for (const task of p.payload.tasks)
          this.saveTask({
            ...task,
            companyId: p.companyId,
            criteria: (task.criteria || []).map((c: any) => ({
              ...c,
              checked: false,
              comment: "",
              agentNote: "",
              evidence: null,
            })),
          });
      if (p.kind === "context") {
        const c = this.company(p.companyId),
          v = contextInput.parse(p.payload);
        this.db
          .update(s.companies)
          .set({
            product: v.product,
            audience: v.audience,
            stage: v.stage,
            bottleneck: v.bottleneck,
            updatedAt: now(),
          })
          .where(eq(s.companies.id, c.id))
          .run();
        for (const goal of v.goals) this.saveGoal({ ...goal, companyId: c.id });
        this.bump(c.id);
      }
      this.db
        .update(s.proposals)
        .set({ status: "accepted" })
        .where(eq(s.proposals.id, p.id))
        .run();
      this.event(
        p.companyId,
        null,
        p.sessionId,
        "accepted",
        "Voorstel toegepast.",
      );
    })();
  }
  proposeNextActions(sessionId: string, args: unknown) {
    const session = this.session(sessionId);
    if (session.mode !== "suggestions")
      throw new Error("Start eerst een sessie voor AI-voorstellen.");
    const snap = this.snapshot();
    const latest = snap.sessions
      .filter(
        (s) => s.companyId === session.companyId && s.mode === "suggestions",
      )
      .reverse()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (latest?.id !== sessionId)
      throw new Error(
        "Er is inmiddels een nieuwere aanvraag voor voorstellen.",
      );
    if (
      snap.proposals.some(
        (p) => p.sessionId === sessionId && p.kind === "suggestions",
      )
    )
      throw new Error("Deze sessie heeft al drie voorstellen opgeleverd.");
    const payload = nextActionsInput.parse(args);
    const titles = new Set(
      snap.tasks
        .filter((t) => t.companyId === session.companyId && t.status !== "done")
        .map((t) => t.title.trim().toLocaleLowerCase()),
    );
    for (const action of payload.actions) {
      const task = action.task;
      if (
        !snap.projects.some(
          (p) => p.id === task.projectId && p.companyId === session.companyId,
        )
      )
        throw new Error("Project buiten dit bedrijf.");
      this.checkGoal(task.goalId, session.companyId);
      for (const dependency of task.dependencies)
        if (this.task(dependency).companyId !== session.companyId)
          throw new Error("Afhankelijkheid buiten dit bedrijf.");
      const title = task.title.trim().toLocaleLowerCase();
      if (titles.has(title))
        throw new Error(
          "Stel drie verschillende nieuwe taken voor; deze taak bestaat al.",
        );
      titles.add(title);
    }
    return this.sql.transaction(() => {
      for (const previous of snap.proposals.filter(
        (p) =>
          p.companyId === session.companyId &&
          p.kind === "suggestions" &&
          p.status === "pending",
      ))
        this.db
          .update(s.proposals)
          .set({ status: "dismissed" })
          .where(eq(s.proposals.id, previous.id))
          .run();
      const proposalId = id();
      this.db
        .insert(s.proposals)
        .values({
          id: proposalId,
          companyId: session.companyId,
          sessionId,
          kind: "suggestions",
          payload: { ...payload, decisions: {}, createdTasks: {} },
          basisRevision: session.basisRevision,
          status: "pending",
          createdAt: now(),
        })
        .run();
      this.event(
        session.companyId,
        null,
        sessionId,
        "proposal",
        "Drie AI-voorstellen klaar.",
      );
      return {
        ok: true,
        proposalId,
        message:
          "De drie voorstellen staan op Vandaag. Er zijn geen taken aangemaakt.",
      };
    })();
  }
  decideSuggestion(proposalId: string, index: number, accept: boolean) {
    z.number().int().min(0).max(2).parse(index);
    z.boolean().parse(accept);
    const p = this.db
      .select()
      .from(s.proposals)
      .where(eq(s.proposals.id, proposalId))
      .get();
    if (!p || p.kind !== "suggestions" || p.status !== "pending")
      throw new Error("Deze voorstellen zijn niet meer beschikbaar.");
    const payload = nextActionsPayload.parse(p.payload);
    if (payload.decisions[index])
      throw new Error("Dit voorstel is al verwerkt.");
    return this.sql.transaction(() => {
      let taskId: string | undefined;
      if (accept) {
        const task = payload.actions[index].task;
        if (
          this.snapshot().tasks.some(
            (t) =>
              t.companyId === p.companyId &&
              t.status !== "done" &&
              t.title.trim().toLocaleLowerCase() ===
                task.title.trim().toLocaleLowerCase(),
          )
        )
          throw new Error("Deze taak staat al in je takenlijst.");
        taskId = this.saveTask({
          ...task,
          companyId: p.companyId,
          status: "todo",
          pinned: false,
          criteria: task.criteria.map((c) => ({
            ...c,
            checked: false,
            comment: "",
            agentNote: "",
            evidence: null,
          })),
        });
        payload.createdTasks[index] = taskId;
      }
      payload.decisions[index] = accept ? "accepted" : "dismissed";
      this.db
        .update(s.proposals)
        .set({
          payload,
          status:
            Object.keys(payload.decisions).length === 3
              ? Object.values(payload.decisions).includes("accepted")
                ? "accepted"
                : "dismissed"
              : "pending",
        })
        .where(eq(s.proposals.id, p.id))
        .run();
      if (accept)
        this.event(
          p.companyId,
          taskId!,
          p.sessionId,
          "accepted",
          "AI-voorstel toegevoegd als taak.",
        );
      return { taskId };
    })();
  }
  decidePriorityItem(proposalId: string, taskId: string, accept: boolean) {
    const p = this.db
      .select()
      .from(s.proposals)
      .where(eq(s.proposals.id, proposalId))
      .get();
    if (!p || p.kind !== "priorities" || p.status !== "pending")
      throw new Error("Voorstel niet beschikbaar.");
    const index = p.payload.items.findIndex(
      (item: any) => item.taskId === taskId,
    );
    if (index < 0 || p.payload.decisions?.[taskId])
      throw new Error("Deze wijziging is al verwerkt.");
    if (accept && p.basisRevision !== this.company(p.companyId).revision)
      throw new Error("Dit advies is verouderd. Vraag een nieuw advies.");
    this.sql.transaction(() => {
      const item = p.payload.items[index];
      if (accept) {
        const task = this.task(taskId);
        if (task.companyId !== p.companyId || task.status === "done")
          throw new Error("Deze taak kan niet worden verplaatst.");
        const current = this.snapshot()
          .tasks.filter((t) => t.companyId === p.companyId)
          .sort((a, b) => a.rank - b.rank);
        const requested = current.filter(
          (t) => t.id !== taskId && t.status !== "done",
        );
        requested.splice(Math.min(index, requested.length), 0, task as Task);
        const order = applyProposedOrder(current, requested, new Set([taskId]));
        order.forEach((t, rank) =>
          this.db
            .update(s.tasks)
            .set({ rank })
            .where(eq(s.tasks.id, t.id))
            .run(),
        );
        this.db
          .update(s.tasks)
          .set({
            priorityReason: item.reason,
            priorityEvidence: item.evidence,
            confidence: item.confidence,
            pinned: false,
          })
          .where(eq(s.tasks.id, taskId))
          .run();
        this.bump(p.companyId);
      }
      const decisions = {
        ...(p.payload.decisions || {}),
        [taskId]: accept ? "accepted" : "dismissed",
      };
      this.db
        .update(s.proposals)
        .set({
          payload: { ...p.payload, decisions },
          basisRevision: accept
            ? this.company(p.companyId).revision
            : p.basisRevision,
          status:
            Object.keys(decisions).length === p.payload.items.length
              ? Object.values(decisions).includes("accepted")
                ? "accepted"
                : "dismissed"
              : "pending",
        })
        .where(eq(s.proposals.id, p.id))
        .run();
      if (accept)
        this.event(
          p.companyId,
          taskId,
          p.sessionId,
          "accepted",
          "Voorgestelde prioriteit overgenomen.",
        );
    })();
  }
  export() {
    const snapshot = this.snapshot();
    snapshot.events = this.db
      .select()
      .from(s.events)
      .orderBy(desc(s.events.createdAt))
      .all();
    return {
      format: "werk-backup",
      version: 9,
      exportedAt: now(),
      data: {
        ...snapshot,
        ...this.agents.export(),
        brainFiles: this.brain.export(snapshot.companies.map(c => c.id)),
        taskCompletions: this.db.select().from(s.taskCompletions).all(),
      },
    };
  }
  restore(input: unknown) {
    const values = validateBackup(input);
    this.brain.validateFiles(values.brainFiles, values.companies.map(c => c.id));
    for (const task of values.tasks)
      if (!task.criteria.length && task.definitionDone.trim())
        task.criteria = task.definitionDone
          .split(/\n+/)
          .filter(Boolean)
          .map((text) => criterionInput.parse({ id: id(), text }));
    this.sql.transaction(() => {
      this.agents.clear();
      for (const table of [
        s.taskCompletions,
        s.artifacts,
        s.events,
        s.proposals,
        s.checkins,
        s.sessions,
        s.tasks,
        s.projects,
        s.departments,
        s.goals,
        s.companies,
      ])
        this.db.delete(table).run();
      const entries: [any, any[]][] = [
        [s.companies, values.companies],
        [s.goals, values.goals],
        [s.departments, values.departments],
        [s.projects, values.projects],
        [s.tasks, values.tasks],
        [s.taskCompletions, values.taskCompletions],
        [
          s.sessions,
          values.sessions.map((row: any) => ({
            ...row,
            state: "interrupted",
            tokenHash: "",
            basisRevision: 0,
            lastHookAt: 0,
            error: "Hersteld uit back-up; hervat expliciet.",
          })),
        ],
        [s.events, values.events],
        [s.artifacts, values.artifacts],
        [s.proposals, values.proposals],
        [s.checkins, values.checkins],
      ];
      for (const [table, rows] of entries)
        for (const row of rows) this.db.insert(table).values(row).run();
      this.agents.restore(values);
      this.brain.restore(values.brainFiles, values.companies.map(c => c.id));
    })();
  }
}
export function focusTasks(
  tasks: Task[],
  companyId: string,
  today = localDate(),
) {
  return tasks
    .filter(
      (t) =>
        t.companyId === companyId &&
        availableToday(t, today) &&
        t.status !== "done" &&
        t.status !== "blocked" &&
        t.dependencies.every((dep) =>
          tasks.some((o) => o.id === dep && o.status === "done"),
        ),
    )
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        Number(b.mustDo && !!b.dueDate && b.dueDate <= today) -
          Number(a.mustDo && !!a.dueDate && a.dueDate <= today) ||
        a.rank - b.rank ||
        a.createdAt.localeCompare(b.createdAt),
    );
}
