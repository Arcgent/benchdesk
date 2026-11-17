import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  agentInput,
  agentProfile,
  agentConversation,
  chatItem,
  type AgentProfile,
  type AgentConversation,
  type ChatUpdate,
  type ChatRead,
  type ChatItem,
  agentSkillInput,
  agentRoutine,
  agentRoutineInput,
  type AgentRoutine,
  type AgentSearchResult,
  type AgentAuditRow,
} from "../shared/agents";
import { newAgentPolicy } from "../shared/policy";
import { CronExpressionParser } from "cron-parser";

export function nextAgentRun(
  input: z.infer<typeof agentRoutineInput>,
  after = new Date(),
) {
  if (input.schedule === "interval")
    return new Date(after.getTime() + input.minutes * 60000).toISOString();
  const [hour, minute] = input.time.split(":").map(Number);
  return CronExpressionParser.parse(
    `${minute} ${hour} * * ${input.schedule === "weekly" ? input.weekday : "*"}`,
    { currentDate: after, tz: input.timezone },
  )
    .next()
    .toISOString()!;
}

const now = () => new Date().toISOString();
const decode = <T>(row: unknown): T => {
  if (!row) throw new Error("Agent of gesprek niet gevonden.");
  return JSON.parse((row as { data: string }).data);
};
export class AgentStore {
  constructor(readonly sql: Database.Database) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_conversations (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), agent_id TEXT NOT NULL REFERENCES agents(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_items (id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES agent_conversations(id), sequence INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(conversation_id,id));
      CREATE INDEX IF NOT EXISTS chat_sequence ON chat_items(conversation_id,sequence);
      CREATE TABLE IF NOT EXISTS agent_routines (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_audit (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, company_id TEXT NOT NULL, session_id TEXT, conversation_id TEXT, at TEXT NOT NULL, source TEXT NOT NULL, tool TEXT NOT NULL, effect TEXT NOT NULL, verdict TEXT NOT NULL, effective TEXT NOT NULL, rule_id TEXT, reason TEXT NOT NULL, initiator TEXT NOT NULL, target TEXT NOT NULL, args TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER);
      CREATE INDEX IF NOT EXISTS agent_audit_agent ON agent_audit(agent_id);
    `);
  }
  // Written before the action runs, so a crash mid-call still leaves a trace.
  audit(row: Omit<AgentAuditRow, "id" | "at" | "durationMs">) {
    const id = randomUUID(),
      at = now();
    this.sql
      .prepare(
        "INSERT INTO agent_audit(id,agent_id,company_id,session_id,conversation_id,at,source,tool,effect,verdict,effective,rule_id,reason,initiator,target,args,outcome) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        row.agentId,
        row.companyId,
        row.sessionId,
        row.conversationId,
        at,
        row.source,
        row.tool.slice(0, 300),
        row.effect,
        row.verdict,
        row.effective,
        row.ruleId,
        row.reason.slice(0, 500),
        row.initiator,
        row.target.slice(0, 1000),
        row.args,
        row.outcome,
      );
    return id;
  }
  auditOutcome(id: string, outcome: AgentAuditRow["outcome"], started?: number) {
    this.sql
      .prepare("UPDATE agent_audit SET outcome=?, duration_ms=? WHERE id=?")
      .run(outcome, started === undefined ? null : Date.now() - started, id);
  }
  auditList(agentId: string, input: unknown = {}) {
    const p = z
      .object({
        // Cursor: insertion order, stable within the same millisecond.
        before: z.number().int().positive().nullable().default(null),
        verdict: z.enum(["deny", "ask", "allow"]).optional(),
        source: z.enum(["werk", "builtin", "plugin", "computer"]).optional(),
        limit: z.number().int().min(1).max(200).default(50),
      })
      .parse(input);
    this.profile(agentId);
    const where = ["agent_id=?"],
      args: unknown[] = [agentId];
    if (p.before) {
      where.push("rowid<?");
      args.push(p.before);
    }
    if (p.verdict) {
      where.push("verdict=?");
      args.push(p.verdict);
    }
    if (p.source) {
      where.push("source=?");
      args.push(p.source);
    }
    const rows = this.sql
      .prepare(
        `SELECT rowid AS seq, * FROM agent_audit WHERE ${where.join(" AND ")} ORDER BY rowid DESC LIMIT ?`,
      )
      .all(...args, p.limit + 1) as Record<string, any>[];
    const items: AgentAuditRow[] = rows.slice(0, p.limit).map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      companyId: r.company_id,
      sessionId: r.session_id,
      conversationId: r.conversation_id,
      at: r.at,
      source: r.source,
      tool: r.tool,
      effect: r.effect,
      verdict: r.verdict,
      effective: r.effective,
      ruleId: r.rule_id,
      reason: r.reason,
      initiator: r.initiator,
      target: r.target,
      args: r.args,
      outcome: r.outcome,
      durationMs: r.duration_ms,
    }));
    return {
      items,
      next: rows.length > p.limit ? (rows[p.limit - 1].seq as number) : null,
    };
  }
  pruneAudit(days = 90, max = 200000) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    this.sql.prepare("DELETE FROM agent_audit WHERE at<?").run(cutoff);
    this.sql
      .prepare(
        "DELETE FROM agent_audit WHERE rowid IN (SELECT rowid FROM agent_audit ORDER BY rowid DESC LIMIT -1 OFFSET ?)",
      )
      .run(max);
  }
  profiles(): AgentProfile[] {
    return this.sql
      .prepare("SELECT data FROM agents ORDER BY rowid")
      .all()
      .map((row) => agentProfile.parse(decode(row)));
  }
  conversations(): AgentConversation[] {
    return this.sql
      .prepare("SELECT data FROM agent_conversations ORDER BY rowid DESC")
      .all()
      .map((row) => agentConversation.parse(decode(row)));
  }
  profile(id: string) {
    return agentProfile.parse(
      decode<AgentProfile>(
        this.sql.prepare("SELECT data FROM agents WHERE id=?").get(id),
      ),
    );
  }
  conversation(id: string) {
    return agentConversation.parse(
      decode<AgentConversation>(
        this.sql
          .prepare("SELECT data FROM agent_conversations WHERE id=?")
          .get(id),
      ),
    );
  }
  save(input: unknown, id?: string, expectedRevision?: number) {
    const value = agentInput.parse(input);
    // New agents ask before writes; existing agents keep their stored policy.
    if (!id && !(input as any)?.access?.policy)
      value.access.policy = newAgentPolicy();
    if (
      !this.sql
        .prepare("SELECT id FROM companies WHERE id=?")
        .get(value.companyId)
    )
      throw new Error("Bedrijf niet gevonden.");
    return this.sql.transaction(() => {
      const old = id ? this.profile(id) : null;
      for (const peerId of value.access.teammates) {
        if (peerId === id || this.profile(peerId).companyId !== value.companyId)
          throw new Error("Kies een andere agent van hetzelfde bedrijf.");
      }
      if (
        old &&
        (old.companyId !== value.companyId || old.revision !== expectedRevision)
      )
        throw new Error("Agent is gewijzigd. Ververs en probeer opnieuw.");
      const profile: AgentProfile = {
        ...value,
        id: old?.id || randomUUID(),
        revision: (old?.revision || 0) + 1,
        createdAt: old?.createdAt || now(),
        updatedAt: now(),
        archived: old?.archived || false,
        skills: old?.skills || [],
        memory: old?.memory || {
          content: "",
          revision: 0,
          updatedAt: "",
          source: "user",
          sourceConversationId: null,
        },
      };
      this.writeProfile(profile);
      return profile.id;
    })();
  }
  private writeProfile(profile: AgentProfile) {
    this.sql
      .prepare(
        "INSERT INTO agents(id,company_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(profile.id, profile.companyId, JSON.stringify(profile));
  }
  archive(id: string, archived: boolean) {
    const p = this.profile(id);
    this.writeProfile({
      ...p,
      archived,
      revision: p.revision + 1,
      updatedAt: now(),
    });
  }
  copy(id: string, companyId: string) {
    const source = this.profile(id);
    const copyId = this.save({
      ...Object.fromEntries(
        Object.keys(agentInput.shape).map((key) => [
          key,
          source[key as keyof AgentProfile],
        ]),
      ),
      companyId,
      name: source.name,
      accountId: companyId === source.companyId ? source.accountId : null,
      access: {
        ...source.access,
        routines: false,
        messaging: false,
        teammates: [],
        ...(companyId !== source.companyId
          ? { places: [], integrations: [] }
          : {}),
      },
    });
    const copied = this.profile(copyId);
    this.writeProfile({
      ...copied,
      skills: source.skills.map((skill) => ({
        ...skill,
        id: randomUUID(),
        revision: 1,
        updatedAt: now(),
        source: "user",
      })),
    });
    return copyId;
  }
  search(agentId: string, query: string): AgentSearchResult[] {
    this.profile(agentId);
    const term = z
      .string()
      .trim()
      .min(2)
      .max(200)
      .parse(query)
      .replace(/[\\%_]/g, "\\$&");
    const rows = this.sql
      .prepare(
        `SELECT i.data AS item, c.data AS conversation FROM chat_items i
      JOIN agent_conversations c ON c.id=i.conversation_id
      WHERE c.agent_id=? AND json_extract(i.data,'$.kind') IN ('user','assistant')
      AND json_extract(i.data,'$.text') LIKE ? ESCAPE '\\'
      ORDER BY json_extract(i.data,'$.createdAt') DESC, i.sequence DESC LIMIT 30`,
      )
      .all(agentId, `%${term}%`) as { item: string; conversation: string }[];
    return rows.map((row) => {
      const item: ChatItem = JSON.parse(row.item),
        c: AgentConversation = JSON.parse(row.conversation);
      const index = item.text
        .toLocaleLowerCase()
        .indexOf(query.trim().toLocaleLowerCase());
      const start = Math.max(0, index - 120);
      return {
        conversationId: c.id,
        title: c.title,
        itemId: item.id,
        text: (start ? "…" : "") + item.text.slice(start, start + 700),
        createdAt: item.createdAt,
      };
    });
  }
  saveSkill(
    agentId: string,
    input: unknown,
    id?: string,
    expectedRevision?: number,
    source: "user" | "assistant" = "user",
  ) {
    const value = agentSkillInput.parse(input);
    return this.sql.transaction(() => {
      const profile = this.profile(agentId),
        old = id ? profile.skills.find((s) => s.id === id) : null;
      if (id && (!old || old.revision !== expectedRevision))
        throw new Error("Skill is gewijzigd. Lees opnieuw.");
      if (!old && profile.skills.length >= 50)
        throw new Error("Maximaal 50 skills per agent.");
      const skill = {
        ...value,
        id: old?.id || randomUUID(),
        revision: (old?.revision || 0) + 1,
        updatedAt: now(),
        source,
      };
      // An agent may refine a procedure, but cannot re-enable a user-disabled skill.
      if (source === "assistant" && old) skill.enabled = old.enabled;
      profile.skills = [
        ...profile.skills.filter((s) => s.id !== skill.id),
        skill,
      ];
      this.writeProfile({
        ...profile,
        revision: profile.revision + 1,
        updatedAt: now(),
      });
      return skill;
    })();
  }
  removeSkill(agentId: string, id: string, expectedRevision: number) {
    const p = this.profile(agentId),
      old = p.skills.find((s) => s.id === id);
    if (!old || old.revision !== expectedRevision)
      throw new Error("Skill is gewijzigd. Lees opnieuw.");
    this.writeProfile({
      ...p,
      revision: p.revision + 1,
      skills: p.skills.filter((s) => s.id !== id),
      updatedAt: now(),
    });
  }
  routines(agentId?: string): AgentRoutine[] {
    return (
      agentId
        ? this.sql
            .prepare("SELECT data FROM agent_routines WHERE agent_id=?")
            .all(agentId)
        : this.sql.prepare("SELECT data FROM agent_routines").all()
    ).map((row) => agentRoutine.parse(decode(row)));
  }
  routine(id: string) {
    return agentRoutine.parse(
      decode(
        this.sql.prepare("SELECT data FROM agent_routines WHERE id=?").get(id),
      ),
    );
  }
  writeRoutine(value: AgentRoutine) {
    const r = agentRoutine.parse(value);
    this.sql
      .prepare(
        "INSERT INTO agent_routines(id,agent_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(r.id, r.agentId, JSON.stringify(r));
    return r;
  }
  saveRoutine(input: unknown, id?: string, expectedRevision?: number) {
    const value = agentRoutineInput.parse(input),
      p = this.profile(value.agentId),
      old = id ? this.routine(id) : null;
    if (
      old &&
      (old.revision !== expectedRevision || old.agentId !== value.agentId)
    )
      throw new Error("Routine is gewijzigd. Lees opnieuw.");
    if (value.enabled && (p.archived || !p.access.routines))
      throw new Error("Sta routines eerst toe bij de agent.");
    if (!old && this.routines(value.agentId).length >= 50)
      throw new Error("Maximaal 50 routines per agent.");
    return this.writeRoutine({
      ...value,
      id: old?.id || randomUUID(),
      revision: (old?.revision || 0) + 1,
      nextRunAt: nextAgentRun(value),
      lastRunAt: old?.lastRunAt || null,
      lastConversationId: old?.lastConversationId || null,
      error: "",
    });
  }
  removeRoutine(id: string, expectedRevision: number) {
    if (this.routine(id).revision !== expectedRevision)
      throw new Error("Routine is gewijzigd. Lees opnieuw.");
    this.sql.prepare("DELETE FROM agent_routines WHERE id=?").run(id);
  }
  memory(
    id: string,
    content: unknown,
    expectedRevision: unknown,
    source: "user" | "assistant",
    conversationId: string | null = null,
  ) {
    const value = z.string().max(12000).parse(content),
      revision = z.number().int().nonnegative().parse(expectedRevision);
    return this.sql.transaction(() => {
      const p = this.profile(id);
      if (p.memory.revision !== revision)
        throw new Error(
          "Agentgeheugen is gewijzigd. Lees opnieuw en behoud de correcties.",
        );
      if (conversationId && this.conversation(conversationId).agentId !== id)
        throw new Error("Dit geheugen hoort bij een andere agent.");
      p.memory = {
        content: value,
        revision: revision + 1,
        updatedAt: now(),
        source,
        sourceConversationId: conversationId,
      };
      this.writeProfile(p);
      return p.memory;
    })();
  }
  createConversation(value: AgentConversation) {
    const c = agentConversation.parse(value),
      p = this.profile(c.agentId);
    if (
      p.companyId !== c.companyId ||
      c.profile.id !== p.id ||
      c.profile.companyId !== c.companyId
    )
      throw new Error("Gesprek en agent horen niet bij hetzelfde bedrijf.");
    this.sql
      .prepare(
        "INSERT INTO agent_conversations(id,company_id,agent_id,data) VALUES(?,?,?,?)",
      )
      .run(c.id, c.companyId, c.agentId, JSON.stringify(c));
    return c;
  }
  updateConversation(
    id: string,
    patch: Partial<
      Pick<
        AgentConversation,
        "title" | "taskId" | "sequence" | "originConversationId"
      >
    >,
  ) {
    const c = { ...this.conversation(id), ...patch, updatedAt: now() };
    this.sql
      .prepare("UPDATE agent_conversations SET data=? WHERE id=?")
      .run(JSON.stringify(c), id);
    return c;
  }
  item(conversationId: string, id: string): ChatItem | null {
    const row = this.sql
      .prepare("SELECT data FROM chat_items WHERE conversation_id=? AND id=?")
      .get(conversationId, id);
    return row ? decode<ChatItem>(row) : null;
  }
  put(conversationId: string, input: ChatUpdate) {
    return this.sql.transaction(() => {
      const c = this.conversation(conversationId),
        old = this.item(conversationId, input.id),
        sequence = c.sequence + 1;
      const item = chatItem.parse({
        ...input,
        text: input.text.slice(0, 200000),
        conversationId,
        sequence,
        order: old?.order || sequence,
        createdAt: old?.createdAt || now(),
      });
      this.sql
        .prepare(
          "INSERT INTO chat_items(id,conversation_id,sequence,data) VALUES(?,?,?,?) ON CONFLICT(conversation_id,id) DO UPDATE SET sequence=excluded.sequence,data=excluded.data",
        )
        .run(item.id, conversationId, sequence, JSON.stringify(item));
      this.updateConversation(conversationId, { sequence });
      return item;
    })();
  }
  read(id: string, afterSequence = 0): ChatRead {
    const c = this.conversation(id);
    const items = this.sql
      .prepare(
        "SELECT data FROM chat_items WHERE conversation_id=? AND sequence>? ORDER BY sequence LIMIT 200",
      )
      .all(id, z.number().int().nonnegative().parse(afterSequence))
      .map(decode<ChatItem>);
    const nextSequence = items.at(-1)?.sequence ?? afterSequence;
    return {
      conversation: c,
      items,
      nextSequence,
      more: nextSequence < c.sequence,
    };
  }
  awaitingHuman(conversationId: string) {
    return !!this.sql
      .prepare(
        "SELECT 1 FROM chat_items WHERE conversation_id=? AND json_extract(data,'$.status')='pending' AND json_extract(data,'$.detail.async')=1 LIMIT 1",
      )
      .get(conversationId);
  }
  finishPending(id: string, status: "interrupted" | "error" = "interrupted") {
    for (const item of this.sql
      .prepare("SELECT data FROM chat_items WHERE conversation_id=?")
      .all(id)
      .map(decode<ChatItem>))
      // Async human requests (ask_person, forms) outlive the turn that made them.
      if (
        ["running", "pending"].includes(item.status) &&
        !(item.status === "pending" && item.detail?.async === true)
      )
        this.put(id, { ...item, status });
  }
  export() {
    return {
      agents: this.profiles(),
      agentRoutines: this.routines(),
      agentConversations: this.conversations(),
      chatItems: this.sql
        .prepare(
          "SELECT data FROM chat_items ORDER BY conversation_id,sequence",
        )
        .all()
        .map(decode<ChatItem>),
    };
  }
  clear() {
    this.sql.exec(
      "DELETE FROM agent_routines; DELETE FROM chat_items; DELETE FROM agent_conversations; DELETE FROM agents;",
    );
  }
  restore(data: {
    agents: AgentProfile[];
    agentConversations: AgentConversation[];
    chatItems: ChatItem[];
    agentRoutines?: AgentRoutine[];
  }) {
    for (const p of data.agents) this.writeProfile(agentProfile.parse(p));
    for (const c of data.agentConversations) this.createConversation(c);
    for (const item of data.chatItems)
      this.sql
        .prepare(
          "INSERT INTO chat_items(id,conversation_id,sequence,data) VALUES(?,?,?,?)",
        )
        .run(
          item.id,
          item.conversationId,
          item.sequence,
          JSON.stringify(chatItem.parse(item)),
        );
    for (const c of data.agentConversations) this.finishPending(c.id);
    // Restored schedules never start unattended work until explicitly enabled again.
    for (const r of data.agentRoutines || [])
      this.writeRoutine({
        ...r,
        enabled: false,
        revision: r.revision + 1,
        nextRunAt: nextAgentRun(r),
      });
  }
}
