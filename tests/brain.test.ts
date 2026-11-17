import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { BrainService, contextUnits, BRAIN_CONTEXT_LIMIT, START_CONTEXT_LIMIT } from "../src/runtime/brain";
import { JevService } from "../src/runtime/jev";
import type { BrainHit } from "../src/shared/brain";

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "benchdesk-brain-"));
  const store = new Store(join(root, "state.sqlite"));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const companyId = store.saveCompany({
    name: "Acme",
    product: "Software",
    workspacePath: root,
  });
  const other = store.saveCompany({ name: "Other", workspacePath: root });
  const projectId = store.saveProject({ companyId, name: "Product" });
  const taskId = store.saveTask({
    companyId,
    projectId,
    title: "Doelgroep onderzoeken",
  });
  const sid = store.createSession({
    companyId,
    taskId,
    mode: "work",
    provider: "codex",
    cwd: root,
    outputDir: root,
    token: "test",
  });
  const jev = new JevService(join(root, "jev.vault"));
  const service = new BrainService(store, jev);
  service.sync(companyId);
  const source = store.brain
    .pending(companyId)
    .find((s) => s.kind === "company")!;
  const change = (
    id = "doelgroep",
    revision = 0,
    body = "De doelgroep bestaat uit kleine bedrijven.",
  ) => ({
    pageId: id,
    expectedRevision: revision,
    title: "Doelgroep",
    kind: "topic",
    sections: [
      {
        id: "overzicht",
        title: "Overzicht",
        body,
        status: "fact",
        sources: [source.id],
        links: [] as string[],
      },
    ],
  });
  return {
    root,
    store,
    companyId,
    other,
    projectId,
    taskId,
    sid,
    jev,
    service,
    source,
    change,
  };
}

test("start packet includes assignment, criteria, linked project and memory without separate reads", async (t) => {
  const f = fixture(t);
  f.store.patchTask(f.taskId, { description: "Onderzoek drie doelgroepen", definitionDone: "Bronnen gevonden", criteria: [{ id: "c1", text: "Vermeld bronnen", checked: false, comment: "", agentNote: "", evidence: null }] });
  f.store.saveSessionMemory(f.sid, { summary: "Eerdere afspraak", decisions: ["Alleen Nederlandse bedrijven"] }, 0, "user");
  const packet = await f.service.tool(f.sid, "get_task_context", {});
  assert.equal(packet.task.description, "Onderzoek drie doelgroepen");
  assert.equal(packet.task.definitionDone, f.store.task(f.taskId).definitionDone);
  assert.equal(packet.task.criteria[0].text, "Vermeld bronnen");
  assert.equal(packet.task.partial, false);
  assert.equal(packet.project.id, f.projectId);
  assert.deepEqual(packet.sessionMemory.decisions, ["Alleen Nederlandse bedrijven"]);
  assert.equal(packet.brain.wikiState, "empty");
  assert.ok(contextUnits(packet) <= START_CONTEXT_LIMIT);
  assert.equal(packet.contextUsage.payloadBytes, contextUnits(packet));
  assert.equal(packet.contextUsage.remainingReadBytes, f.service.remaining(f.sid));
  assert.equal((await f.service.tool(f.sid, "get_task_context", {})).alreadyProvided, true);
  f.store.patchTask(f.taskId, { description: "Gewijzigde opdracht" });
  assert.equal((await f.service.tool(f.sid, "get_task_context", {})).task.description, "Gewijzigde opdracht");
});

test("large assignments explicitly identify omitted fields and can be read without data loss", async (t) => {
  const f = fixture(t);
  const description = "Uitgebreide opdracht 🚀 ".repeat(800);
  f.store.patchTask(f.taskId, { description });
  const packet = await f.service.tool(f.sid, "get_task_context", {});
  assert.equal(packet.task.partial, true);
  assert.ok(packet.task.omitted.includes("description"));
  assert.ok(contextUnits(packet) <= START_CONTEXT_LIMIT);
  let offset = 0, body = "";
  do {
    const detail = await f.service.tool(f.sid, "get_context_details", { kind: "task", offset });
    assert.equal(detail.format, "json-fragment");
    body += detail.text;
    offset = detail.nextOffset;
  } while (offset !== null);
  assert.equal(JSON.parse(body).description, description);
});

test("start retrieval preserves corrections and obeys company/context scope", async (t) => {
  const f = fixture(t);
  f.store.brain.commit(f.companyId, { changes: [f.change()] }, "assistant");
  f.store.brain.correct(f.companyId, "doelgroep", "overzicht", 1, "Gebruikerscorrectie: alleen ontwerpers.");
  const packet = await f.service.tool(f.sid, "get_task_context", {});
  assert.equal(packet.knowledge.engine, "local");
  assert.ok(packet.knowledge.hits.some((h: BrainHit) => h.body.includes("ontwerpers")));
  const restricted = f.store.createSession({ companyId: f.companyId, taskId: f.taskId, mode: "work", provider: "codex", cwd: f.root, outputDir: f.root, token: "restricted", contextOptions: { assignment: false, criteria: false, business: false } });
  const hidden = await f.service.tool(restricted, "get_task_context", {});
  assert.equal(hidden.knowledge, undefined);
  assert.equal(hidden.brain.wikiState, "restricted");
  assert.equal(hidden.company.product, "");
  assert.deepEqual(hidden.task.criteria, []);
  const other = f.store.createSession({ companyId: f.other, mode: "work", provider: "codex", taskId: null, cwd: f.root, outputDir: f.root, token: "other" });
  assert.equal((await f.service.tool(other, "get_task_context", {})).knowledge, undefined);
});

test("small context details are returned as complete structured data", async (t) => {
  const f = fixture(t);
  const detail = await f.service.tool(f.sid, "get_context_details", { kind: "task" });
  assert.equal(detail.format, "json");
  assert.equal(detail.data.id, f.taskId);
  assert.equal(detail.nextOffset, null);
});

test("automatic retrieval ranks ambiguous candidates once and reuses the read receipt", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 7; i++)
    f.store.brain.commit(f.companyId, { changes: [f.change(`groep-${i}`, 0, `Doelgroep ${i}: klanten met passende wensen.`)] }, "assistant");
  let calls = 0;
  f.jev.rank = async (_company, query, candidates) => {
    calls++;
    assert.match(query, /Doelgroep/);
    return { hits: candidates.slice(-2), engine: "jev", fallback: null, cached: false, elapsedMs: 1, moreAvailable: true };
  };
  const packet = await f.service.tool(f.sid, "get_task_context", {});
  assert.equal(packet.knowledge.engine, "jev");
  assert.equal(packet.knowledge.hits.length, 2);
  await f.service.tool(f.sid, "get_task_context", {});
  assert.equal(calls, 1);
});

test("automatic retrieval does not call Jev for a small local selection", async (t) => {
  const f = fixture(t);
  f.store.brain.commit(f.companyId, { changes: [f.change()] }, "assistant");
  f.jev.rank = async () => { throw new Error("Unnecessary remote call"); };
  const packet = await f.service.tool(f.sid, "get_task_context", {});
  assert.equal(packet.knowledge.hits.length, 1);
  assert.equal(packet.knowledge.engine, "local");
});

test("sync recovers raw sources left behind by a failed manifest publish", (t) => {
  const f = fixture(t),
    b = f.store.brain;
  const manifest = join(b.root, f.companyId, "manifest.json");
  const published = readFileSync(manifest, "utf8");
  f.store.saveCompany(
    { name: "Acme", workspacePath: f.root, product: "Ander product" },
    f.companyId,
  );
  f.service.sync(f.companyId);
  const orphan = b.pending(f.companyId).find((s) => s.kind === "company")!;
  assert.notEqual(orphan.id, f.source.id);
  // Simulate a publish that wrote the raw file but never swapped the manifest,
  // with a stale (here: truncated) raw header that no longer matches.
  writeFileSync(manifest, published);
  writeFileSync(join(b.root, f.companyId, "raw", `${orphan.id}.md`), "");
  assert.doesNotThrow(() => f.service.sync(f.companyId));
  assert.match(b.source(f.companyId, orphan.id).body, /Ander product/);
  assert.equal(b.source(f.companyId, f.source.id).current, false);
});

test("wiki imports idempotently, preserves immutable sources and rebuilds its search index", (t) => {
  const f = fixture(t),
    b = f.store.brain;
  const count = b.pending(f.companyId).length;
  f.service.sync(f.companyId);
  assert.equal(b.pending(f.companyId).length, count);
  const raw = b.source(f.companyId, f.source.id).body;
  b.commit(
    f.companyId,
    { changes: [f.change()], processedSources: [f.source.id] },
    "assistant",
  );
  assert.match(
    b.page(f.companyId, "doelgroep").sections[0].body,
    /kleine bedrijven/,
  );
  assert.equal(b.candidates(f.companyId, "doelgroep").length, 1);
  assert.equal(
    b.pending(f.companyId).some((s) => s.id === f.source.id),
    false,
  );
  f.store.saveCompany(
    { name: "Acme", workspacePath: f.root, product: "Nieuw product" },
    f.companyId,
  );
  f.service.sync(f.companyId);
  assert.equal(b.source(f.companyId, f.source.id).body, raw);
  assert.equal(b.source(f.companyId, f.source.id).current, false);
  const second = new Store(join(f.root, "state.sqlite"));
  try {
    assert.equal(second.brain.candidates(f.companyId, "bedrijven").length, 1);
  } finally {
    second.close();
  }
});

test("multi-page writes validate before publication and enforce company isolation", (t) => {
  const f = fixture(t),
    b = f.store.brain;
  f.service.sync(f.other);
  const foreign = b.pending(f.other)[0];
  const bad = f.change("verboden");
  bad.sections[0].sources = [foreign.id];
  assert.throws(
    () => b.commit(f.companyId, { changes: [f.change(), bad] }, "assistant"),
    /bronverwijzing/,
  );
  assert.equal(b.overview(f.companyId).pages.length, 0);
  assert.throws(() => b.source(f.companyId, foreign.id), /niet beschikbaar/);
  assert.throws(() => b.page(f.companyId, "../other"));
  b.commit(f.companyId, { changes: [f.change()] }, "assistant");
  assert.deepEqual(b.candidates(f.other, "doelgroep"), []);
  assert.deepEqual(
    b.candidates(f.companyId, "doelgroep", {
      business: false,
      assignment: true,
      criteria: true,
      taskId: f.taskId,
    }),
    [],
  );
});

test("revisions and user corrections survive later changes and rejected stale writes", (t) => {
  const f = fixture(t),
    b = f.store.brain;
  b.commit(f.companyId, { changes: [f.change()] }, "assistant");
  b.correct(
    f.companyId,
    "doelgroep",
    "overzicht",
    1,
    "De doelgroep bestaat uit zelfstandige ontwerpers.",
  );
  assert.throws(
    () =>
      b.commit(
        f.companyId,
        { changes: [f.change("doelgroep", 1)] },
        "assistant",
      ),
    /ondertussen/,
  );
  assert.throws(
    () =>
      b.commit(
        f.companyId,
        { changes: [f.change("doelgroep", 2)] },
        "assistant",
      ),
    /correctie/,
  );
  assert.match(b.page(f.companyId, "doelgroep", 1).sections[0].body, /kleine/);
  assert.match(b.page(f.companyId, "doelgroep").sections[0].body, /ontwerpers/);
  assert.equal(f.store.task(f.taskId).status, "todo");
});

test("wiki backup restores history and rejects missing sources before changing existing state", (t) => {
  const f = fixture(t),
    b = f.store.brain;
  b.commit(f.companyId, { changes: [f.change()] }, "assistant");
  const backup = f.store.export();
  b.correct(
    f.companyId,
    "doelgroep",
    "overzicht",
    1,
    "Gecorrigeerde doelgroep.",
  );
  const bad = structuredClone(backup);
  bad.data.brainFiles = bad.data.brainFiles.filter(
    (f) => !f.path.startsWith("raw/"),
  );
  assert.throws(() => f.store.restore(bad), /bron/);
  assert.equal(b.page(f.companyId, "doelgroep").revision, 2);
  f.store.restore(backup);
  assert.equal(b.page(f.companyId, "doelgroep").revision, 1);
  assert.equal(b.candidates(f.companyId, "bedrijven").length, 1);
  assert.ok(!JSON.stringify(backup).includes("apiKey"));
});

test("context budget is shared, persistent and only resets on a different user turn", async (t) => {
  const f = fixture(t);
  const outputs: any[] = [];
  f.service.reset(f.sid, "turn-1");
  outputs.push(await f.service.tool(f.sid, "get_task_context", {}));
  for (let i = 0; i < 200; i++) {
    outputs.push(
      await f.service.tool(f.sid, "get_context_details", {
        kind: "tasks",
        offset: i,
      }),
    );
    if (outputs.at(-1).budgetExhausted) break;
  }
  assert.ok(outputs.some((o) => o.budgetExhausted));
  const used = outputs
    .filter((o) => !o.budgetExhausted)
    .reduce((n, o) => n + contextUnits(o), 0);
  assert.ok(used > 4000);
  assert.ok(used <= BRAIN_CONTEXT_LIMIT);
  const remaining = f.service.remaining(f.sid);
  f.service.reset(f.sid, "turn-1");
  assert.equal(f.service.remaining(f.sid), remaining);
  const resumed = new BrainService(f.store, f.jev);
  assert.equal(resumed.remaining(f.sid), remaining);
  resumed.reset(f.sid, "turn-2");
  assert.equal(resumed.remaining(f.sid), BRAIN_CONTEXT_LIMIT);
});

test("one turn can list and fully read twenty small sources", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 20; i++)
    f.store.saveTask({
      companyId: f.companyId,
      projectId: f.projectId,
      title: `Batch source ${i}`,
    });
  f.service.reset(f.sid, "batch-turn");
  const context = await f.service.tool(f.sid, "get_task_context", {});
  assert.equal(context.brain.contextLimit, 64_000);
  const sources: { id: string }[] = [];
  for (let offset = 0; sources.length < 20;) {
    const page = await f.service.tool(f.sid, "list_brain_pending", { offset });
    assert.ok(!page.budgetExhausted);
    sources.push(...page.items);
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  assert.ok(sources.length >= 20);
  for (const source of sources.slice(0, 20)) {
    let offset = 0;
    let body = "";
    while (true) {
      const chunk = await f.service.tool(f.sid, "read_brain_source", {
        sourceId: source.id, offset,
      });
      assert.ok(!chunk.budgetExhausted);
      assert.ok(chunk.text.length > 0);
      body += chunk.text;
      if (chunk.nextOffset === null) break;
      assert.ok(chunk.nextOffset > offset);
      offset = chunk.nextOffset;
    }
    assert.equal(body, f.store.brain.source(f.companyId, source.id).body);
  }
  assert.ok(BRAIN_CONTEXT_LIMIT - f.service.remaining(f.sid) > 4000);
  assert.ok(f.service.remaining(f.sid) > 0);
});

test("context restrictions apply to historical sources and write operations", async (t) => {
  const f = fixture(t),
    b = f.store.brain;
  const taskSource = b.pending(f.companyId).find((s) => s.kind === "task")!;
  const access = {
    business: true,
    assignment: false,
    criteria: true,
    taskId: f.taskId,
  };
  assert.throws(
    () => b.source(f.companyId, taskSource.id, access),
    /niet beschikbaar/,
  );
  const change = f.change();
  change.sections[0].sources = [taskSource.id];
  assert.throws(
    () => b.commit(f.companyId, { changes: [change] }, "assistant", access),
    /bronverwijzing/,
  );
});

test("memory patches preserve fields and enforce revisions without returning full notes", async (t) => {
  const f = fixture(t);
  f.store.saveSessionMemory(
    f.sid,
    { summary: "Eerste notitie", decisions: ["Behoud deze keuze"] },
    0,
    "user",
  );
  const receipt = await f.service.tool(f.sid, "patch_session_memory", {
    expectedRevision: 1,
    summary: "Nieuwe samenvatting",
  });
  assert.equal(receipt.revision, 2);
  assert.equal(receipt.summary, undefined);
  assert.deepEqual(f.store.session(f.sid).memory!.decisions, [
    "Behoud deze keuze",
  ]);
  await assert.rejects(
    f.service.tool(f.sid, "patch_session_memory", {
      expectedRevision: 1,
      summary: "Verouderd",
    }),
    /ondertussen/,
  );
});

const hits: BrainHit[] = Array.from({ length: 6 }, (_, n) => ({
  id: `page-${n}:section`,
  pageId: `page-${n}`,
  sectionId: "section",
  title: `Page ${n}`,
  body: `Evidence ${n}`,
  revision: 1,
  status: "fact",
  sources: [],
  links: [],
}));
test("Jev scores supplied candidates, caches by scope and revision, and keeps credentials private", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const request: typeof fetch = async (_url, init) => {
    calls++;
    const payload = JSON.parse(init!.body as string);
    assert.equal(payload.state.candidates.length, 6);
    assert.ok(payload.questions.candidate_0.instructions.includes(hits[0].id));
    return new Response(
      JSON.stringify({
        model: "jev-latest",
        answers: Object.fromEntries(
          hits.map((_, n) => [
            `candidate_${n}`,
            { type: "score", score: n / 2, confidence: 0.9 },
          ]),
        ),
        usage: { input_tokens: 200 },
      }),
    );
  };
  const jev = new JevService(join(f.root, "test.vault"), request);
  jev.vault.unlock("a".repeat(64));
  jev.configure(f.companyId, "secret-test-key");
  const ranked = await jev.rank(f.companyId, "evidence", hits, "scope1");
  assert.equal(ranked.engine, "jev");
  assert.equal(ranked.hits[0].id, hits[5].id);
  assert.equal(
    (await jev.rank(f.companyId, "evidence", hits, "scope1")).cached,
    true,
  );
  await jev.rank(f.companyId, "evidence", hits, "scope2");
  await jev.rank(
    f.companyId,
    "evidence",
    hits.map((h) => ({ ...h, revision: 2 })),
    "scope2",
  );
  assert.equal(calls, 3);
  assert.ok(
    !readFileSync(join(f.root, "test.vault"), "utf8").includes(
      "secret-test-key",
    ),
  );
  assert.ok(
    !JSON.stringify(jev.status(f.companyId)).includes("secret-test-key"),
  );
});

test("Jev has bounded latency and local fallback for timeout, invalid response and absent key", async (t) => {
  const f = fixture(t);
  for (const request of [
    async () => new Promise<Response>(() => {}),
    async () => new Response("{}"),
    async () => new Response("denied", { status: 401 }),
  ]) {
    const jev = new JevService(
      join(f.root, `failure-${Math.random()}.vault`),
      request as typeof fetch,
      20,
    );
    jev.vault.unlock("a".repeat(64));
    jev.configure(f.companyId, "secret-test-key");
    const start = Date.now(),
      result = await jev.rank(f.companyId, "evidence", hits, "scope");
    assert.equal(result.engine, "local");
    assert.ok(result.fallback);
    assert.ok(Date.now() - start < 1000);
    assert.deepEqual(result.hits, hits.slice(0, 5));
  }
  const result = await f.jev.rank(f.companyId, "evidence", hits, "scope");
  assert.equal(result.engine, "local");
});

test("a complete memory-to-wiki flow respects the context budget and source provenance", async (t) => {
  const f = fixture(t);
  f.service.reset(f.sid, "ingest-turn");
  await f.service.tool(f.sid, "get_task_context", {});
  await f.service.tool(f.sid, "patch_session_memory", {
    expectedRevision: 0,
    summary: "Voorstel: richt ons op ontwerpers, nog niet goedgekeurd.",
  });
  const pending = await f.service.tool(f.sid, "list_brain_pending", {});
  const note = pending.items.find((i: any) => i.kind === "session");
  assert.ok(note);
  const source = await f.service.tool(f.sid, "read_brain_source", {
    sourceId: note.id,
  });
  assert.match(source.text, /nog niet goedgekeurd/);
  const change = f.change();
  change.sections[0].sources = [note.id];
  change.sections[0].status = "proposal";
  const receipt = await f.service.tool(f.sid, "save_brain_changes", {
    changes: [change],
    processedSources: [note.id],
  });
  assert.equal(receipt.pendingApproval, true);
  f.store.brain.decideSuggestion(f.companyId, receipt.suggestionId, "accept");
  assert.equal(
    f.store.brain.page(f.companyId, "doelgroep").sections[0].status,
    "proposal",
  );
  assert.equal(f.store.task(f.taskId).status, "todo");
  f.service.reset(f.sid, "query-turn");
  const result = await f.service.tool(f.sid, "search_company_brain", {
    query: "doelgroep",
  });
  assert.equal(result.hits[0].sources[0], note.id);
});

test("long passages are paginated and search excerpts include matches near the end", async (t) => {
  const f = fixture(t);
  const text =
    "Algemene informatie. ".repeat(200) + " Specifiek: productontwerpers.";
  f.store.brain.commit(
    f.companyId,
    { changes: [f.change("lang", 0, text)] },
    "assistant",
  );
  const hits = f.store.brain.candidates(f.companyId, "productontwerpers");
  assert.match(hits[0].body, /productontwerpers/);
  const first = await f.service.tool(f.sid, "read_brain_page", {
    pageId: "lang",
    sectionId: "overzicht",
  });
  assert.ok(first.nextOffset > 0);
  f.service.reset(f.sid, "next-turn");
  const second = await f.service.tool(f.sid, "read_brain_page", {
    pageId: "lang",
    sectionId: "overzicht",
    offset: first.nextOffset,
  });
  assert.equal(
    first.body + second.body,
    text.slice(0, first.body.length + second.body.length),
  );
});

test("user correction cannot be rewritten merely by retaining its citation", (t) => {
  const f = fixture(t);
  f.store.brain.commit(f.companyId, { changes: [f.change()] }, "assistant");
  f.store.brain.correct(
    f.companyId,
    "doelgroep",
    "overzicht",
    1,
    "Ontwerpers zijn de doelgroep.",
  );
  const current = f.store.brain.page(f.companyId, "doelgroep");
  const change = f.change("doelgroep", 2, "Iedereen is de doelgroep.");
  change.sections[0].sources = current.sections[0].sources;
  assert.throws(
    () => f.store.brain.commit(f.companyId, { changes: [change] }, "assistant"),
    /correctie/,
  );
});

test("only an accepted user hook can reset the context budget", (t) => {
  const f = fixture(t);
  const event = {
    id: crypto.randomUUID(),
    name: "UserPromptSubmit",
    at: Date.now(),
  };
  assert.equal(f.store.hook(f.sid, event)?.contextTurn, event.id);
  assert.equal(f.store.hook(f.sid, event), undefined);
  assert.equal(
    f.store.hook(f.sid, {
      ...event,
      id: crypto.randomUUID(),
      at: event.at - 100,
    }),
    undefined,
  );
});

test("new topics wait for approval, are isolated and dismissed suggestions do not reappear", async (t) => {
  const f = fixture(t),
    b = f.store.brain;
  const input = { changes: [f.change()], processedSources: [f.source.id] };
  const pending = await f.service.tool(f.sid, "save_brain_changes", input);
  assert.equal(pending.pendingApproval, true);
  assert.equal(b.overview(f.companyId).pages.length, 0);
  assert.equal(b.candidates(f.companyId, "doelgroep").length, 0);
  assert.equal(
    b.pending(f.companyId).find((s) => s.id === f.source.id)?.processed,
    false,
  );
  assert.equal(b.overview(f.companyId).suggestions.length, 1);
  assert.throws(
    () => b.decideSuggestion(f.other, pending.suggestionId, "accept"),
    /niet beschikbaar/,
  );
  b.decideSuggestion(f.companyId, pending.suggestionId, "dismiss");
  assert.equal(
    (await f.service.tool(f.sid, "save_brain_changes", input)).status,
    "dismissed",
  );
  assert.equal(b.overview(f.companyId).suggestions.length, 0);
});

test("source review lists all candidates, keeps rejection across sync and allows materially new versions", (t) => {
  const f = fixture(t), b = f.store.brain;
  assert.ok(b.overview(f.companyId).reviewSources.some((s) => s.id === f.source.id));
  assert.throws(() => b.decideSource(f.other, f.source.id, "dismiss"), /niet beschikbaar/);
  b.decideSource(f.companyId, f.source.id, "dismiss");
  f.service.sync(f.companyId);
  assert.ok(!b.pending(f.companyId).some((s) => s.id === f.source.id));
  assert.ok(!b.overview(f.companyId).reviewSources.some((s) => s.id === f.source.id));
  const backup = b.export([f.companyId]);
  b.restore(backup, [f.companyId]);
  assert.ok(!b.pending(f.companyId).some((s) => s.id === f.source.id));
  f.store.saveCompany({ name: "Acme", product: "Een nieuw product", workspacePath: f.root }, f.companyId);
  f.service.sync(f.companyId);
  assert.ok(b.overview(f.companyId).reviewSources.some((s) => s.kind === "company" && s.id !== f.source.id));
});

test("source approval validates before staging and preserves user edits with citations", (t) => {
  const f = fixture(t), b = f.store.brain;
  const draft = b.sourceDraft(f.companyId, f.source.id);
  assert.match(draft.body, /Software/);
  assert.throws(() => b.decideSource(f.companyId, f.source.id, "accept", "Profiel", ""));
  assert.equal(b.overview(f.companyId).suggestions.length, 0);
  b.decideSource(f.companyId, f.source.id, "accept", "Profiel", "Software voor ontwerpers.");
  const page = b.page(f.companyId, `article-${f.source.id.slice(2)}`);
  assert.equal(page.title, "Profiel");
  assert.equal(page.sections[0].body, "Software voor ontwerpers.");
  assert.ok(page.sections[0].sources.includes(f.source.id));
  assert.ok(page.sections[0].sources.some((id) => b.source(f.companyId, id).kind === "correction"));
  assert.ok(!b.overview(f.companyId).reviewSources.some((s) => s.id === f.source.id));
  assert.throws(() => b.decideSource(f.companyId, f.source.id, "accept", "Opnieuw", draft.body), /al beoordeeld/);
});

test("prepared suggestions replace their source rows and rejected wording cannot recreate the same topic", (t) => {
  const f = fixture(t), b = f.store.brain;
  const staged = b.commit(f.companyId, { changes: [f.change()] }, "assistant", undefined, true);
  assert.ok(staged.suggestionId);
  assert.ok(!b.overview(f.companyId).reviewSources.some((s) => s.id === f.source.id));
  assert.throws(() => b.decideSource(f.companyId, f.source.id, "dismiss"), /inmiddels/);
  b.decideSuggestion(f.companyId, staged.suggestionId!, "dismiss");
  const repeated = b.commit(f.companyId, { changes: [f.change("doelgroep", 0, "Anders geformuleerd.")] }, "assistant", undefined, true);
  assert.equal(repeated.status, "dismissed");
  assert.equal(b.overview(f.companyId).suggestions.length, 0);
});

test("approval publishes source-backed edits, preserves corrections and existing-only updates remain automatic", async (t) => {
  const f = fixture(t),
    b = f.store.brain;
  const pending = await f.service.tool(f.sid, "save_brain_changes", {
    changes: [f.change()],
  });
  b.decideSuggestion(f.companyId, pending.suggestionId, "accept", {
    "doelgroep:overzicht": "De doelgroep is zelfstandige ontwerpers.",
  });
  const page = b.page(f.companyId, "doelgroep");
  assert.equal(page.updatedBy, "user");
  assert.match(page.sections[0].body, /ontwerpers/);
  assert.ok(
    page.sections[0].sources.some(
      (id) => b.source(f.companyId, id).kind === "correction",
    ),
  );
  assert.throws(
    () => b.decideSuggestion(f.companyId, pending.suggestionId, "accept"),
    /al beoordeeld/,
  );
  await assert.rejects(
    f.service.tool(f.sid, "save_brain_changes", {
      changes: [f.change("doelgroep", 1, "Verkeerde doelgroep.")],
    }),
    /correctie/,
  );
  const update = {
    ...f.change("doelgroep", 1),
    sections: [
      {
        ...page.sections[0],
        body: page.sections[0].body + " Onderzoek loopt.",
      },
    ],
  };
  const saved = await f.service.tool(f.sid, "save_brain_changes", {
    changes: [update],
  });
  assert.equal(saved.pages[0].revision, 2);
});

test("mixed linked batches wait together and approval rejects stale revisions; backups retain suggestions", async (t) => {
  const f = fixture(t),
    b = f.store.brain;
  b.commit(f.companyId, { changes: [f.change()] }, "assistant");
  const fresh = f.change("nieuw");
  fresh.sections[0].links = ["doelgroep"];
  const pending = await f.service.tool(f.sid, "save_brain_changes", {
    changes: [f.change("doelgroep", 1), fresh],
  });
  assert.equal(b.page(f.companyId, "doelgroep").revision, 1);
  const backup = b.export([f.companyId]);
  b.decideSuggestion(f.companyId, pending.suggestionId, "dismiss");
  b.restore(backup, [f.companyId]);
  assert.equal(b.overview(f.companyId).suggestions.length, 1);
  b.correct(f.companyId, "doelgroep", "overzicht", 1, "Gebruikerscorrectie.");
  assert.throws(
    () => b.decideSuggestion(f.companyId, pending.suggestionId, "accept"),
    /ondertussen gewijzigd/,
  );
  assert.equal(b.overview(f.companyId).pages.length, 1);
  assert.match(
    b.page(f.companyId, "doelgroep").sections[0].body,
    /Gebruikerscorrectie/,
  );
});

test("repeated reads return compact receipts across service restarts and renew on a user turn", async (t) => {
  const f = fixture(t);
  f.service.reset(f.sid, "one");
  const first = await f.service.tool(f.sid, "read_brain_source", {
    sourceId: f.source.id,
  });
  assert.ok(first.text);
  const left = f.service.remaining(f.sid);
  const resumed = new BrainService(f.store, f.jev);
  const again = await resumed.tool(f.sid, "read_brain_source", {
    sourceId: f.source.id,
  });
  assert.equal(again.alreadyProvided, true);
  assert.equal(again.text, undefined);
  assert.equal(resumed.remaining(f.sid), left);
  resumed.reset(f.sid, "two");
  assert.ok(
    (await resumed.tool(f.sid, "read_brain_source", { sourceId: f.source.id }))
      .text,
  );
});
