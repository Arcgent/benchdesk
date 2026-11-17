import type { CanvasTree } from "./canvas";
import type { AgentProfile, AgentConversation, ChatItem } from "./agents";
import type { SessionContextOptions } from "./context";
import type { SessionMemory } from "./memory";
import { z } from "zod";
import { calendarDate } from "./task-schedule";
export const taskStatuses = [
  "todo",
  "in_progress",
  "blocked",
  "review",
  "done",
] as const;
export const sessionStates = [
  "starting",
  "working",
  "waiting",
  "idle",
  "interrupted",
  "ended",
  "error",
  "unknown",
] as const;
export type Provider = "shell" | "claude" | "codex";
export type Mode = "work" | "planning" | "intake" | "suggestions";
export type TaskStatus = (typeof taskStatuses)[number];
export const labels: Record<TaskStatus, string> = {
  todo: "Gepland",
  in_progress: "Bezig",
  blocked: "Geblokkeerd",
  review: "Wacht op jou",
  done: "Afgerond",
};
const text = z.string().max(30000);
const date = z.string().regex(/^$|^\d{4}-\d{2}-\d{2}$/);
export const criterionInput = z.object({
  id: z.string().max(100),
  text: z.string().trim().min(1).max(4000),
  checked: z.boolean().default(false),
  comment: z.string().max(4000).default(""),
  agentNote: z.string().max(4000).default(""),
  evidence: z
    .object({
      path: z.string().max(8000),
      line: z.number().int().min(1).max(1000000).default(1),
    })
    .nullable()
    .default(null),
});
export type Criterion = z.infer<typeof criterionInput>;
export const companyInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    workspacePath: z.string().min(1),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default("#b8593c"),
    product: text.default(""),
    audience: text.default(""),
    stage: text.default(""),
    bottleneck: text.default(""),
    sources: z.array(z.string().max(4000)).max(100).default([]),
  })
  .strict();
export const departmentInput = z
  .object({
    companyId: z.string(),
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(2000).default(""),
  })
  .strict();
export type Department = z.infer<typeof departmentInput> & {
  id: string;
  createdAt: string;
};
export const projectInput = z
  .object({
    companyId: z.string(),
    name: z.string().trim().min(1).max(200),
    description: text.default(""),
    departmentId: z.string().nullable().default(null),
    workspacePath: z.string().default(""),
    goalId: z.string().nullable().default(null),
    dueDate: date.default(""),
  })
  .strict();
export const goalInput = z
  .object({
    companyId: z.string(),
    title: z.string().trim().min(1).max(500),
    metric: text.default(""),
    unit: z.string().max(100).default(""),
    baseline: z.number().finite().default(0),
    current: z.number().finite().default(0),
    target: z.number().finite().default(0),
    dueDate: date.default(""),
    primary: z.boolean().default(false),
  })
  .strict();
export const taskInput = z
  .object({
    agentId: z.string().uuid().nullable().optional(),
    recurrence: z.enum(["none", "daily", "weekly"]).default("none"),
    scheduledDate: calendarDate.default(""),
    companyId: z.string(),
    projectId: z.string(),
    goalId: z.string().nullable().default(null),
    title: z.string().trim().min(1).max(500),
    description: text.default(""),
    definitionDone: text.default(""),
    criteria: z.array(criterionInput).max(100).default([]),
    provider: z.enum(["claude", "codex", "shell"]).default("claude"),
    model: z
      .string()
      .trim()
      .max(100)
      .regex(/^$|^[a-zA-Z0-9._:-]+$/)
      .default(""),
    dueDate: date.default(""),
    estimateMinutes: z.number().int().min(0).max(100000).default(30),
    kind: z.enum(["ai", "human"]).default("ai"),
    status: z.enum(taskStatuses).default("todo"),
    pinned: z.boolean().default(false),
    mustDo: z.boolean().default(false),
    dependencies: z.array(z.string()).max(100).default([]),
  })
  .strict();
export const priorityItem = z.object({
  taskId: z.string(),
  reason: z.string().min(1).max(3000),
  evidence: z.array(z.string().max(1000)).max(20),
  confidence: z.enum(["low", "medium", "high"]),
});
export const contextInput = companyInput
  .pick({ product: true, audience: true, stage: true, bottleneck: true })
  .extend({
    summary: text,
    goals: z
      .array(goalInput.omit({ companyId: true }))
      .max(10)
      .default([]),
  });
export type Company = z.infer<typeof companyInput> & {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastCheckinAt: string;
};
export type Project = z.infer<typeof projectInput> & {
  id: string;
  createdAt: string;
};
export type Goal = z.infer<typeof goalInput> & {
  id: string;
  updatedAt: string;
};
export type Task = z.infer<typeof taskInput> & {
  nextOccurrenceDate?: string;
  id: string;
  rank: number;
  priorityReason: string;
  priorityEvidence: string[];
  confidence: string;
  resultSummary: string;
  createdAt: string;
  updatedAt: string;
};
export type Session = {
  agentId?: string | null;
  conversationId?: string | null;
  transport?: "pty" | "chat";
  contextOptions?: SessionContextOptions;
  id: string;
  companyId: string;
  taskId: string | null;
  provider: Provider;
  mode: Mode;
  state: string;
  providerSessionId: string | null;
  cwd: string;
  outputDir: string;
  createdAt: string;
  updatedAt: string;
  error: string;
  alive?: boolean;
  agentRunning?: boolean;
  accountId?: string | null;
  accountConfigDir?: string;
  purpose?: "work" | "login" | "logout";
  memory?: SessionMemory | null;
  memoryDirty?: boolean;
  resumeFrom?: string | null;
};
export type WorkEvent = {
  id: string;
  companyId: string;
  taskId: string | null;
  sessionId: string | null;
  kind: string;
  summary: string;
  createdAt: string;
};
export type SessionFile = {
  path: string;
  name: string;
  relativePath: string;
  source: "linked" | "output" | "workspace";
  modifiedAt: string;
  size: number;
};
export type SessionFileList = {
  files: SessionFile[];
  truncated: boolean;
  unavailable: boolean;
};
export type Artifact = {
  id: string;
  companyId: string;
  taskId: string;
  sessionId: string | null;
  path: string;
  name: string;
  createdAt: string;
};
export type Proposal = {
  id: string;
  companyId: string;
  sessionId: string;
  kind: "priorities" | "tasks" | "context" | "suggestions";
  payload: any;
  basisRevision: number;
  status: string;
  createdAt: string;
};
export type Checkin = {
  measurements?: {
    goalId: string;
    title: string;
    before: number;
    after: number;
    unit: string;
  }[];
  id: string;
  companyId: string;
  note: string;
  createdAt: string;
};
export type Snapshot = {
  agents?: AgentProfile[];
  agentConversations?: AgentConversation[];
  companies: Company[];
  departments: Department[];
  projects: Project[];
  goals: Goal[];
  tasks: Task[];
  sessions: Session[];
  events: WorkEvent[];
  artifacts: Artifact[];
  proposals: Proposal[];
  checkins: Checkin[];
};
export type Inventory = {
  shell: string;
  providers: { name: string; path: string; version: string }[];
  mcps: { name: string; source: string; provider: string; enabled: boolean }[];
  skills: { path: string; count: number; provider: string }[];
  inspectedAt: string;
};
export type TerminalFrame = {
  screen: string;
  cols: number;
  rows: number;
  sequence: number;
};
export const profileInput = z.object({
  name: z.string().trim().max(100).default(""),
  email: z.string().max(250).default(""),
  language: z.enum(["nl"]).default("nl"),
  appearance: z.enum(["light", "dark", "system"]).default("light"),
  terminalPreset: z
    .enum(["classic", "refined", "compact"])
    .default("classic"),
  terminalFont: z.enum(["plex", "system"]).default("plex"),
  terminalFontSize: z.number().min(11).max(17).default(13),
  terminalLineHeight: z.number().min(1.1).max(1.8).default(1.4),
  weekStart: z.number().int().min(0).max(6).default(1),
  checkinTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default("09:00"),
  checkinReminder: z.boolean().default(true),
});
export type UserProfile = z.infer<typeof profileInput>;
export const accountInput = z.object({
  provider: z.enum(["claude", "codex"]),
  label: z.string().trim().min(1).max(100),
  configDir: z.string().trim().min(1).max(8000),
  companyIds: z.array(z.string()).max(500).default([]),
  globalDefault: z.boolean().default(false),
});
export type AssistantAccount = z.infer<typeof accountInput> & {
  id: string;
  email: string;
  status: "logged_in" | "logged_out" | "expired" | "unknown";
  checkedAt: string;
};
export type Preferences = {
  profile: UserProfile;
  accounts: AssistantAccount[];
};
export type WorkspaceState = {
  closedSessionIds?: string[];
  canvas?: CanvasTree | null;
  canvasFocus?: string;
  pendingSplitDir?: "row" | "col";
  canvasFilter?: string;
  workspaceMode?: "conversation" | "canvas";
  // Legacy (company tabs, removed with the Rustig shell). Nothing reads it any more; it is only carried along
  // so an older build still accepts the stored state.
  openCompanyIds?: string[];
  activeCompanyId: string;
  split: boolean;
  panes: [string | null, string | null];
  focusedPane: 0 | 1;
  dockExpanded: boolean;
  ratio: number;
};
export type AppEvent =
  | { type: "chat"; conversationId: string; item: ChatItem }
  | { type: "changed" }
  // Desktop only: the main process lost the runner connection and has it back; panes resync their screen.
  | { type: "reconnected" }
  | { type: "terminal"; sessionId: string; data: string; sequence: number };
export interface WerkAPI {
  call<T = any>(method: string, params?: any): Promise<T>;
  onEvent(callback: (event: AppEvent) => void): () => void;
  selectFolder(): Promise<string | null>;
  selectFiles(): Promise<string[]>;
  // Native desktop only: browsers intentionally cannot discover local file paths.
  pathForFile?(file: File): string;
  clipboardFiles?(): Promise<string[]>;
  openPath(path: string): Promise<void>;
  preview(
    path: string,
  ): Promise<{ kind: string; content: string; name: string }>;
  backup(): Promise<string | null>;
  restore(): Promise<boolean>;
}
declare global {
  interface Window {
    werk: WerkAPI;
  }
}
