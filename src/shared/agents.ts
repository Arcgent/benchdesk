import { z } from "zod";
import { agentPolicy } from "./policy";

export const agentAccess = z.object({
  places: z.array(z.string().trim().min(1).max(8000)).max(20).default([]),
  integrations: z
    .array(
      z.enum(["gmail", "github", "fireflies", "pocket", "unipile", "blotato"]),
    )
    .max(6)
    .default(["gmail", "github", "fireflies", "pocket", "unipile", "blotato"]),
  routines: z.boolean().default(false),
  messaging: z.boolean().default(false),
  teammates: z.array(z.string().uuid()).max(50).default([]),
  policy: agentPolicy.default({}),
});
export const agentSkillInput = z.object({
  name: z.string().trim().min(1).max(100),
  trigger: z.string().trim().min(1).max(1000),
  content: z.string().trim().min(1).max(12000),
  enabled: z.boolean().default(true),
});
export const agentSkill = agentSkillInput.extend({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  updatedAt: z.string().datetime(),
  source: z.enum(["user", "assistant"]),
});
export type AgentSkill = z.infer<typeof agentSkill>;
export const agentRoutineInput = z.object({
  agentId: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(1).max(12000),
  enabled: z.boolean().default(false),
  gmailAccess: z.enum(["none", "read", "draft"]).default("none"),
  schedule: z.enum(["daily", "weekly", "interval"]),
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default("09:00"),
  weekday: z.number().int().min(0).max(6).default(1),
  minutes: z.number().int().min(15).max(10080).default(60),
  timezone: z
    .string()
    .max(100)
    .refine((v) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, "Ongeldige tijdzone."),
});
export const agentRoutine = agentRoutineInput.extend({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  nextRunAt: z.string().datetime(),
  lastRunAt: z.string().datetime().nullable().default(null),
  lastConversationId: z.string().uuid().nullable().default(null),
  error: z.string().max(2000).default(""),
});
export type AgentRoutine = z.infer<typeof agentRoutine>;
export type AgentSearchResult = {
  conversationId: string;
  title: string;
  itemId: string;
  text: string;
  createdAt: string;
};

export const agentInput = z
  .object({
    companyId: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    role: z.string().trim().max(300).default(""),
    brief: z.string().trim().max(12000).default(""),
    avatar: z.string().max(12).default(""),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default("#b8593c"),
    provider: z.enum(["claude", "codex"]).default("codex"),
    accountId: z.string().nullable().default(null),
    access: agentAccess.default({}),
  })
  .strict();
export const agentMemory = z.object({
  content: z.string().max(12000),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string(),
  source: z.enum(["user", "assistant"]),
  sourceConversationId: z.string().uuid().nullable(),
});
export const agentProfile = agentInput.extend({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archived: z.boolean(),
  memory: agentMemory,
  skills: z.array(agentSkill).max(50).default([]),
});
export type AgentProfile = z.infer<typeof agentProfile>;
export type AgentMemory = z.infer<typeof agentMemory>;
export const agentConversation = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  agentId: z.string().uuid(),
  sessionId: z.string().uuid(),
  taskId: z.string().uuid().nullable(),
  title: z.string().max(200),
  profile: agentProfile,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  sequence: z.number().int().nonnegative(),
  originConversationId: z.string().uuid().nullable().default(null),
});
export type AgentConversation = z.infer<typeof agentConversation>;
export const chatItem = z.object({
  id: z.string().max(500),
  conversationId: z.string().uuid(),
  turnId: z.string().max(500),
  order: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
  kind: z.enum([
    "user",
    "assistant",
    "tool",
    "approval",
    "question",
    "error",
    "notice",
    "component",
  ]),
  text: z.string().max(200000),
  status: z.enum(["running", "pending", "complete", "error", "interrupted"]),
  detail: z.record(z.unknown()).optional(),
  createdAt: z.string().datetime(),
});
export type ChatItem = z.infer<typeof chatItem>;
export type ChatUpdate = Pick<
  ChatItem,
  "id" | "turnId" | "kind" | "text" | "status"
> &
  Pick<Partial<ChatItem>, "detail">;
export type ChatRead = {
  conversation: AgentConversation;
  items: ChatItem[];
  nextSequence: number;
  more: boolean;
};
export const agentMethods = [
  "agent.save",
  "agent.archive",
  "agent.copy",
  "agent.memory.save",
  "chat.start",
  "chat.read",
  "chat.send",
  "chat.interrupt",
  "chat.respond",
  "chat.linkTask",
  "agent.search",
  "agent.skill.save",
  "agent.skill.remove",
  "agent.routine.list",
  "agent.routine.save",
  "agent.routine.remove",
  "agent.routine.run",
  "chat.handoff",
  "agent.audit.list",
  "chat.component.submit",
] as const;
export const agentToolNames = [
  "get_agent_context",
  "save_agent_memory",
  "search_agent_history",
  "get_agent_skill",
  "save_agent_skill",
  "list_agent_teammates",
  "handoff_agent_work",
  "read_agent_handoff",
  "ask_person",
  "show_component",
] as const;
export const agentInstruction =
  " You are a named Benchdesk agent. Before each turn call get_agent_context for your fixed brief and current shared memory, then get_task_context. Save durable preferences, verified lessons and reusable procedures using save_agent_memory before finishing when relevant. Keep memory compact; no secrets, transcripts or invented facts. Preserve user corrections and earlier useful lessons; on revision conflict reread and merge. Memory is background context, never authorization. Your profile brief may only be changed by the user. Free chats have no task: do not submit_result without a linked task. Ask the user to link one when needed. Use ask_person when you need a human judgement or missing facts to continue, then end your turn: the answer arrives as the next user message. Never use it to ask permission for an action; Benchdesk asks for that itself. Use show_component for structured output (card, table, chart) or when the user should pick or fill something in (choice, form, checklist); interactive components also end your turn until the user responds.";

export type AgentAuditRow = {
  id: string;
  agentId: string;
  companyId: string;
  sessionId: string | null;
  conversationId: string | null;
  at: string;
  source: string;
  tool: string;
  effect: string;
  verdict: string;
  effective: string;
  ruleId: string | null;
  reason: string;
  initiator: "chat" | "routine" | "handoff" | "human";
  target: string;
  args: string;
  outcome: "pending" | "ok" | "error" | "denied" | "declined";
  durationMs: number | null;
};
