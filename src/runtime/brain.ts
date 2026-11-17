import { createHash } from "node:crypto";
import { brainTools, type BrainAccess, type BrainHit } from "../shared/brain";
import { sessionContextInput } from "../shared/context";
import type { Store } from "../core/store";
import type { JevService } from "./jev";

// UTF-8 bytes are a deliberately conservative upper bound for byte-tokenized
// provider text. This needs no cloud call or provider-specific tokenizer.
export const contextUnits = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");
// Allow source ingestion batches while retaining a shared, bounded read budget.
export const BRAIN_CONTEXT_LIMIT = 64_000;
export const START_CONTEXT_LIMIT = 16_000;

// Keep complete fields whenever possible. Omitted fields are explicitly named;
// the agent must fetch them before acting on an incomplete assignment.
function boundedRecord(value: any, limit: number, keys: string[]) {
  if (!value) return null;
  const result: any = {};
  const omitted: string[] = [];
  for (const key of keys) {
    if (value[key] === undefined) continue;
    if (contextUnits({ ...result, [key]: value[key] }) <= limit - 400)
      result[key] = value[key];
    else omitted.push(key);
  }
  return { ...result, partial: omitted.length > 0, omitted };
}
export class BrainService {
  constructor(
    private store: Store,
    readonly jev: JevService,
  ) {
    store.sql.exec(
      "CREATE TABLE IF NOT EXISTS brain_budgets(session_id TEXT PRIMARY KEY,turn TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0)",
    );
    store.sql.exec(
      "CREATE TABLE IF NOT EXISTS brain_reads(session_id TEXT NOT NULL,fingerprint TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(session_id,fingerprint))",
    );
  }
  reset(sessionId: string, turn: string) {
    const old = this.store.sql
      .prepare("SELECT turn FROM brain_budgets WHERE session_id=?")
      .get(sessionId) as { turn: string } | undefined;
    if (old?.turn !== turn)
      this.store.sql
        .prepare("DELETE FROM brain_reads WHERE session_id=?")
        .run(sessionId);
    this.store.sql
      .prepare(
        "INSERT INTO brain_budgets(session_id,turn,used) VALUES(?,?,0) ON CONFLICT(session_id) DO UPDATE SET turn=excluded.turn,used=0 WHERE turn<>excluded.turn",
      )
      .run(sessionId, turn);
  }
  remaining(sessionId: string) {
    const row = this.store.sql
      .prepare("SELECT used FROM brain_budgets WHERE session_id=?")
      .get(sessionId) as { used: number } | undefined;
    return Math.max(0, BRAIN_CONTEXT_LIMIT - (row?.used || 0));
  }
  private deliver(sessionId: string, value: any) {
    const size = contextUnits(value);
    if (size > this.remaining(sessionId))
      return {
        budgetExhausted: true,
        message:
          "Contextbudget bereikt. Ga verder met de gelezen bronnen; resterend wiki-onderhoud blijft open.",
      };
    this.store.sql
      .prepare(
        "INSERT INTO brain_budgets(session_id,turn,used) VALUES(?,'initial',?) ON CONFLICT(session_id) DO UPDATE SET used=used+excluded.used",
      )
      .run(sessionId, size);
    return value;
  }
  access(sessionId: string): BrainAccess {
    const s = this.store.session(sessionId);
    return {
      ...sessionContextInput.parse(
        s.mode === "work" ? s.contextOptions : undefined,
      ),
      taskId: s.taskId,
    };
  }
  sync(companyId: string) {
    const snapshot = this.store.snapshot();
    snapshot.events = this.store.sql
      .prepare(
        "SELECT id,company_id as companyId,task_id as taskId,session_id as sessionId,kind,summary,created_at as createdAt FROM events WHERE company_id=? AND kind IN ('result','progress','blocked') ORDER BY created_at",
      )
      .all(companyId) as typeof snapshot.events;
    this.store.brain.capture(companyId, snapshot);
  }
  captureMutation(method: string, params: any, result: unknown) {
    if (
      !/^(company|department|project|goal|task|checkin|artifact|proposal|suggestion|session\.memory)\.(save|patch|complete|return|submit|decide|item|add|criterion|remove)$/.test(
        method,
      )
    )
      return;
    const snapshot = this.store.snapshot();
    const rows = [
      ...snapshot.tasks,
      ...snapshot.projects,
      ...snapshot.goals,
      ...snapshot.sessions,
      ...snapshot.proposals,
      ...snapshot.departments,
    ];
    const companyId =
      params.companyId ||
      params.value?.companyId ||
      (method === "company.save"
        ? result
        : rows.find((row) => row.id === params.id)?.companyId);
    if (typeof companyId === "string") this.sync(companyId);
  }
  async compact(sessionId: string) {
    const c = this.store.context(sessionId);
    const access = this.access(sessionId);
    const project = c.projects.find((p) => p.id === c.task?.projectId);
    const goal = c.goals.find((g) => g.id === (c.task?.goalId || project?.goalId));
    const minimal = (x: any) =>
      x
        ? {
            id: x.id,
            title: (x.title || x.name || "").slice(0, 100),
            status: x.status,
            projectId: x.projectId,
          }
        : null;
    const result: any = {
      company: boundedRecord({
        id: c.company.id,
        name: c.company.name,
        product: c.company.product,
        audience: c.company.audience,
        bottleneck: c.company.bottleneck,
      }, 1800, ["id", "name", "product", "audience", "bottleneck"]),
      task: boundedRecord(c.task, 6000, ["id", "title", "status", "projectId", "goalId", "dueDate", "criteria", "definitionDone", "description", "dependencies"]),
      project: boundedRecord(project, 1200, ["id", "name", "goalId", "description"]),
      goal: boundedRecord(goal, 1200, ["id", "title", "current", "target", "unit", "dueDate", "metric"]),
      projects: c.task ? [] : c.projects.slice(0, 3).map(minimal),
      goals: c.task ? [] : c.goals.slice(0, 2).map(minimal),
      sessionMemory: boundedRecord(c.sessionMemory, 3600, ["revision", "summary", "decisions", "blockers", "nextSteps", "completed"]),
      relatedSessionMemories: c.sessionMemory ? [] : c.relatedSessionMemories.slice(0, 1).map((s) => ({
        sessionId: s.sessionId,
        pending: s.pending,
        memory: boundedRecord(s.memory, 1600, ["revision", "summary", "decisions", "blockers", "nextSteps"]),
      })),
      sessionMemoryPending: c.sessionMemoryPending,
      revision: c.revision,
      outputDirectory: c.outputDirectory,
      brain: {
        pending: this.store.brain.pending(c.company.id, access)
          .length,
        contextLimit: BRAIN_CONTEXT_LIMIT,
        counting: "conservative-utf8-bytes",
        tools: "search_company_brain, read_brain_page, get_context_details",
      },
      partial: true,
      counts: {
        tasks: c.tasks.length,
        projects: c.projects.length,
        goals: c.goals.length,
      },
    };
    const pageCount = Object.keys(this.store.brain.manifest(c.company.id).pages).length;
    result.brain.wikiState = !access.business ? "restricted" : pageCount ? "available" : "empty";
    // Query complete task fields, not an already truncated start packet. Avoid
    // a title consuming all twenty words of the local candidate query.
    const query = [c.task?.title, c.task?.description, project?.name]
      .map((s) => (s?.match(/[\p{L}\p{N}]+/gu) || []).slice(0, 6).join(" "))
      .filter(Boolean).join(" ").slice(0, 500);
    if (c.task && access.business && pageCount && query && this.remaining(sessionId) > contextUnits(result) + 1000) {
      result.knowledge = await this.search(c.company.id, query, access, true);
      // Never separate a correction from its page's evidence group.
      while (result.knowledge.hits.length && contextUnits(result) > Math.min(START_CONTEXT_LIMIT, this.remaining(sessionId)) - 300) {
        const page = result.knowledge.hits.at(-1).pageId;
        result.knowledge.hits = result.knowledge.hits.filter((h: BrainHit) => h.pageId !== page);
        result.knowledge.moreAvailable = true;
      }
    }
    // Bound even pathological Unicode titles/paths and large context lists.
    for (const key of ["relatedSessionMemories", "projects", "goals"]) {
      if (contextUnits(result) <= START_CONTEXT_LIMIT - 300) break;
      result[key] = [];
    }
    for (const [record, key] of [["company", "product"], ["company", "audience"], ["project", "description"], ["goal", "metric"], ["task", "description"], ["task", "criteria"]]) {
      if (contextUnits(result) <= START_CONTEXT_LIMIT - 300) break;
      if (result[record]?.[key] !== undefined) {
        delete result[record][key];
        result[record].omitted.push(key);
        result[record].partial = true;
      }
    }
    result.contextUsage = {
      counting: "utf8-bytes-not-tokens",
      payloadBytes: 0,
      remainingReadBytes: 0,
    };
    for (let i = 0; i < 5; i++) {
      result.contextUsage.payloadBytes = contextUnits(result);
      result.contextUsage.remainingReadBytes = Math.max(0, this.remaining(sessionId) - result.contextUsage.payloadBytes);
    }
    return this.deliver(sessionId, result);
  }
  async search(companyId: string, query: string, access?: BrainAccess, automatic = false) {
    this.sync(companyId);
    const candidates = this.store.brain.candidates(companyId, query, access);
    const result = structuredClone(
      automatic && candidates.length <= 5
        ? { hits: candidates, engine: "local" as const, fallback: null, cached: false, elapsedMs: 0, moreAvailable: false }
        : await this.jev.rank(
        companyId,
        query,
        candidates,
        JSON.stringify({
          access,
          generation: this.store.brain.manifest(companyId).generation,
        }),
      ),
    );
    // A correction/conflict on the same page cannot disappear just because it
    // uses different query words or was ranked below the original claim.
    const groups: BrainHit[][] = result.hits.map((hit) => {
      const page = this.store.brain.page(companyId, hit.pageId);
      return [
        hit,
        ...page.sections
          .filter(
            (s) =>
              s.id !== hit.sectionId &&
              (s.status === "conflict" ||
                s.sources.some(
                  (id) =>
                    this.store.brain.manifest(companyId).sources[id]?.kind ===
                    "correction",
                )) &&
              this.store.brain.sectionAllowed(companyId, s.sources, access),
          )
          .map((s) => ({
            id: `${page.id}:${s.id}`,
            pageId: page.id,
            sectionId: s.id,
            title: `${page.title} · ${s.title}`,
            body: s.body.slice(0, 1000),
            revision: page.revision,
            status: s.status,
            sources: s.sources,
            links: s.links,
          })),
      ];
    });
    const hits: BrainHit[] = [];
    for (const group of groups) {
      const fresh = group.filter((h) => !hits.some((x) => x.id === h.id));
      if (hits.length + fresh.length <= 5) hits.push(...fresh);
      else result.moreAvailable = true;
    }
    return { ...result, hits };
  }
  async tool(sessionId: string, name: string, input: any): Promise<any> {
    if (["save_brain_changes", "patch_session_memory"].includes(name))
      return this.execute(sessionId, name, input);
    const session = this.store.session(sessionId);
    this.sync(session.companyId);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          name,
          input,
          generation: this.store.brain.manifest(session.companyId).generation,
          memory: session.memory?.revision,
          revision: this.store.company(session.companyId).revision,
          memoryDirty: session.memoryDirty,
          access: this.access(sessionId),
        }),
      )
      .digest("hex");
    const previous = this.store.sql
      .prepare(
        "SELECT receipt FROM brain_reads WHERE session_id=? AND fingerprint=?",
      )
      .get(sessionId, fingerprint) as { receipt: string } | undefined;
    if (previous) return JSON.parse(previous.receipt);
    const result = await this.execute(sessionId, name, input);
    if (!result.budgetExhausted) {
      const receipt = {
        alreadyProvided: true,
        message:
          "Deze inhoud is in deze beurt al opgehaald. Gebruik het eerdere toolresultaat.",
        nextOffset: result.nextOffset ?? null,
      };
      this.store.sql
        .prepare(
          "INSERT OR REPLACE INTO brain_reads(session_id,fingerprint,receipt) VALUES(?,?,?)",
        )
        .run(sessionId, fingerprint, JSON.stringify(receipt));
    }
    return result;
  }
  private async execute(sessionId: string, name: string, input: any) {
    const session = this.store.session(sessionId),
      companyId = session.companyId;
    if (session.purpose !== "work")
      throw new Error("Bedrijfsbrein is alleen beschikbaar in werkgesprekken.");
    this.sync(companyId);
    const access = this.access(sessionId);
    if (name === "get_task_context") return this.compact(sessionId);
    const spec = brainTools[name as keyof typeof brainTools];
    if (!spec) throw new Error("Onbekende wiki-opdracht.");
    const args = spec.schema.parse(input) as any;
    if (name === "patch_session_memory") {
      const { expectedRevision, ...patch } = args;
      const memory = this.store.saveSessionMemory(
        sessionId,
        { ...session.memory, ...patch },
        expectedRevision,
        "assistant",
      );
      this.sync(companyId);
      return { revision: memory.revision, updatedAt: memory.updatedAt };
    }
    if (name === "save_brain_changes") {
      const projectIds = new Set(
        this.store
          .snapshot()
          .projects.filter((p) => p.companyId === companyId)
          .map((p) => p.id),
      );
      if (
        args.changes.some(
          (c: any) => c.projectId && !projectIds.has(c.projectId),
        )
      )
        throw new Error("Project hoort niet bij dit bedrijf.");
      return this.store.brain.commit(
        companyId,
        args,
        "assistant",
        access,
        true,
      );
    }
    if (name === "search_company_brain") {
      if (this.remaining(sessionId) < 350)
        return this.deliver(sessionId, { budgetExhausted: true });
      const result = await this.search(companyId, args.query, access);
      // Budget whole evidence groups together rather than silently separating
      // a claim from a correction. Shorten snippets, never their citations.
      while (
        contextUnits(result) > this.remaining(sessionId) &&
        result.hits.some((h) => h.body.length > 100)
      )
        for (const hit of result.hits)
          hit.body = hit.body.slice(
            0,
            Math.max(100, Math.floor(hit.body.length / 2)),
          );
      while (
        contextUnits(result) > this.remaining(sessionId) &&
        result.hits.length
      ) {
        const lastPage = result.hits.at(-1)!.pageId;
        result.hits = result.hits.filter((h) => h.pageId !== lastPage);
        result.moreAvailable = true;
      }
      return this.deliver(sessionId, result);
    }
    if (name === "list_brain_pending") {
      const rows = this.store.brain.pending(companyId, access);
      const items = rows
        .slice(args.offset, args.offset + 5)
        .map((s) => ({ id: s.id, title: s.title, kind: s.kind }));
      while (
        items.length &&
        contextUnits({
          items,
          nextOffset: args.offset + items.length,
          total: rows.length,
        }) > this.remaining(sessionId)
      )
        items.pop();
      return this.deliver(sessionId, {
        items,
        nextOffset:
          items.length && args.offset + items.length < rows.length
            ? args.offset + items.length
            : null,
        total: rows.length,
        budgetExhausted: !items.length && rows.length > args.offset,
      });
    }
    if (name === "read_brain_page") {
      const page = this.store.brain.page(companyId, args.pageId, args.revision);
      const sections = page.sections.filter((s) =>
        this.store.brain.sectionAllowed(companyId, s.sources, access),
      );
      if (!sections.length)
        throw new Error("Wikipagina niet beschikbaar in deze context.");
      if (!args.sectionId)
        return this.deliver(sessionId, {
          id: page.id,
          revision: page.revision,
          title: page.title,
          sections: sections.map((s) => ({
            id: s.id,
            title: s.title,
            status: s.status,
          })),
        });
      const section = sections.find((s) => s.id === args.sectionId);
      if (!section) throw new Error("Sectie niet beschikbaar in deze context.");
      let body = section.body.slice(args.offset, args.offset + 1500);
      let result = {
        pageId: page.id,
        revision: page.revision,
        ...section,
        stale: section.sources.some(
          (id) => !this.store.brain.manifest(companyId).sources[id]?.current,
        ),
        body,
        nextOffset:
          args.offset + body.length < section.body.length
            ? args.offset + body.length
            : null,
      };
      while (contextUnits(result) > this.remaining(sessionId) && body.length) {
        body = body.slice(0, Math.floor(body.length / 2));
        result = { ...result, body, nextOffset: args.offset + body.length };
      }
      return this.deliver(sessionId, body ? result : { budgetExhausted: true });
    }
    if (name === "read_brain_source" || name === "get_context_details") {
      let body: string, metadata: any;
      if (name === "read_brain_source") {
        const source = this.store.brain.source(
          companyId,
          args.sourceId,
          access,
        );
        body = source.body;
        metadata = {
          id: source.id,
          title: source.title,
          current: source.current,
        };
      } else {
        const context = this.store.context(sessionId) as any;
        const value = context[args.kind] ?? null;
        const complete = { kind: args.kind, format: "json", data: value, nextOffset: null };
        if (args.offset === 0 && contextUnits(complete) <= Math.min(6000, this.remaining(sessionId)))
          return this.deliver(sessionId, complete);
        body = JSON.stringify(value);
        metadata = { kind: args.kind, format: "json-fragment" };
      }
      let text = body.slice(args.offset, args.offset + (name === "get_context_details" ? 4000 : 1500));
      let result = {
        ...metadata,
        text,
        nextOffset:
          args.offset + text.length < body.length
            ? args.offset + text.length
            : null,
      };
      while (contextUnits(result) > this.remaining(sessionId) && text.length) {
        text = text.slice(0, Math.floor(text.length / 2));
        result = { ...metadata, text, nextOffset: args.offset + text.length };
      }
      return this.deliver(sessionId, text ? result : { budgetExhausted: true });
    }
    throw new Error("Onbekende wiki-opdracht.");
  }
}
