import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { IntegrationVault } from "../src/core/integration-vault";
import {
  IntegrationService,
  draftMime,
  summarizeMessage,
} from "../src/runtime/integrations";
import { gmailTools } from "../src/shared/integrations";

const READ = "https://www.googleapis.com/auth/gmail.readonly",
  COMPOSE = "https://www.googleapis.com/auth/gmail.compose";
const config = {
  clientId: "fixture.apps.googleusercontent.com",
  clientSecret: "fixture-client-secret",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });
async function until(fn: () => boolean) {
  for (let i = 0; i < 150; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Voorwaarde niet bereikt");
}
function fixture(
  t: any,
  handler?: (url: string, init?: RequestInit) => Promise<Response> | Response,
) {
  const dir = mkdtempSync(join(tmpdir(), "benchdesk-gmail-")),
    path = join(dir, "integrations.vault"),
    key = randomBytes(32).toString("hex");
  const calls: { url: string; init?: RequestInit }[] = [];
  const service = new IntegrationService(path, () => {}, (async (
    url: any,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(url), init });
    if (handler) return handler(String(url), init);
    if (String(url).endsWith("/token"))
      return json({
        access_token: "fixture-access",
        refresh_token: "fixture-refresh",
        expires_in: 3600,
        scope: `${READ} ${COMPOSE}`,
      });
    if (String(url).endsWith("/profile"))
      return json({ emailAddress: "sam@example.test" });
    if (String(url).endsWith("/drafts"))
      return json({ id: "draft-1", message: { id: "message-1" } });
    return json({ messages: [] });
  }) as typeof fetch);
  service.vault.unlock(key);
  service.configure(config);
  t.after(() => {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { service, calls, path, key };
}
function seed(service: IntegrationService, overrides: any = {}) {
  const account = {
    id: randomUUID(),
    email: "a@example.test",
    links: [{ companyId: "a", drafts: true }],
    connectedAt: new Date().toISOString(),
    status: "connected" as const,
    refreshToken: "private-refresh-token",
    accessToken: "private-access-token",
    expiresAt: Date.now() + 3600000,
    scopes: [READ, COMPOSE],
    ...overrides,
  };
  service.vault.value.accounts.push(account);
  service.vault.save();
  service.sessionAccess("session-a", "draft");
  service.sessionAccess("session-b", "draft");
  return account;
}
const draft = (id: string) => ({
  accountId: id,
  requestId: randomUUID(),
  to: ["client@example.test"],
  subject: "Voorstel – café ☕",
  body: "Beste klant,\n\nHier is het voorstel.",
});

test("integratiekluis bewaart tokens versleuteld, heropent en weigert verkeerde sleutels zonder gegevensverlies", (t) => {
  const { service, path, key } = fixture(t);
  seed(service);
  const disk = readFileSync(path, "utf8");
  for (const secret of [
    "private-refresh-token",
    "private-access-token",
    config.clientSecret,
    "a@example.test",
  ])
    assert.ok(!disk.includes(secret));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const other = new IntegrationService(path);
  other.vault.unlock(key);
  assert.equal(other.overview().accounts[0].email, "a@example.test");
  assert.doesNotMatch(
    JSON.stringify(other.overview()),
    /private-refresh-token|private-access-token|fixture-client-secret/,
  );
  assert.throws(
    () => other.vault.unlock(randomBytes(32).toString("hex")),
    /andere sleutel/,
  );
  const wrong = new IntegrationVault(path, () => ({}));
  assert.throws(
    () => wrong.unlock(randomBytes(32).toString("hex")),
    /behouden/,
  );
  assert.equal(readFileSync(path, "utf8"), disk);
  const tampered = JSON.parse(disk);
  tampered.tag = randomBytes(16).toString("base64");
  writeFileSync(path, JSON.stringify(tampered));
  assert.throws(
    () => new IntegrationVault(path, () => ({})).unlock(key),
    /behouden/,
  );
});

test("Gmail weigert cross-company toegang, onbekende sessies en uitgeschakelde rechten vóór netwerkverkeer", async (t) => {
  const { service, calls } = fixture(t),
    a = seed(service);
  assert.deepEqual(service.available("b", "session-b"), []);
  for (const [company, session] of [
    ["b", "session-b"],
    ["a", "unknown"],
  ])
    await assert.rejects(
      service.tool(company, session, "gmail_search", {
        accountId: a.id,
        query: "",
      }),
      /geen toestemming/,
    );
  service.sessionAccess("session-a", "none");
  await assert.rejects(
    service.tool("a", "session-a", "gmail_read_thread", {
      accountId: a.id,
      threadId: "123",
    }),
    /geen toestemming/,
  );
  assert.equal(calls.length, 0);
  service.sessionAccess("session-a", "read");
  await assert.rejects(
    service.tool("a", "session-a", "gmail_create_draft", draft(a.id)),
    /geen toestemming/,
  );
  service.sessionAccess("session-a", "draft");
  service.links(a.id, [{ companyId: "a", drafts: false }]);
  await assert.rejects(
    service.tool("a", "session-a", "gmail_create_draft", draft(a.id)),
    /geen toestemming/,
  );
  await assert.rejects(
    service.tool("a", "session-a", "gmail_send", {}),
    /Onbekende/,
  );
  assert.equal(calls.length, 0);
});

test("concepten worden één keer aangemaakt, nooit verstuurd; onzekere timeouts worden niet herhaald", async (t) => {
  const { service, calls } = fixture(t),
    a = seed(service),
    input = draft(a.id);
  const results = await Promise.allSettled([
    service.tool("a", "session-a", "gmail_create_draft", input),
    service.tool("a", "session-a", "gmail_create_draft", input),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/drafts"));
  assert.deepEqual(
    await service.tool("a", "session-a", "gmail_create_draft", input),
    { draftId: "draft-1", messageId: "message-1", sent: false },
  );
  assert.equal(calls.length, 1);
  await assert.rejects(
    service.tool("a", "session-a", "gmail_create_draft", {
      ...input,
      subject: "Changed",
    }),
    /ander concept/,
  );
  const broken = fixture(t, () => {
      throw new Error("timeout");
    }),
    b = seed(broken.service),
    retry = draft(b.id);
  await assert.rejects(
    broken.service.tool("a", "session-a", "gmail_create_draft", retry),
    /niet bereikbaar/,
  );
  await assert.rejects(
    broken.service.tool("a", "session-a", "gmail_create_draft", retry),
    /mogelijk al gemaakt/,
  );
  assert.equal(broken.calls.length, 1);
});

test("MIME ondersteunt Unicode, afzender, CC en regelafbreking zonder headerinjectie", () => {
  const input = gmailTools.gmail_create_draft.schema.parse({
    ...draft(randomUUID()),
    cc: ["colleague@example.test"],
  });
  const raw = Buffer.from(
    draftMime(input, "sender@example.test"),
    "base64url",
  ).toString();
  assert.match(raw, /From: sender@example.test\r\n/);
  assert.match(raw, /Cc: colleague@example.test\r\n/);
  const [headers, body] = raw.split("\r\n\r\n");
  const encoded = [...headers.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)]
    .map((m) => Buffer.from(m[1], "base64").toString())
    .join("");
  assert.equal(encoded, input.subject);
  assert.equal(
    Buffer.from(body, "base64").toString(),
    input.body.replace(/\n/g, "\r\n"),
  );
  assert.throws(() =>
    gmailTools.gmail_create_draft.schema.parse({
      ...input,
      subject: "Hello\r\nBcc: evil@example.test",
    }),
  );
  assert.throws(() =>
    gmailTools.gmail_create_draft.schema.parse({
      ...input,
      to: ["a@example.test\r\nBcc: evil@example.test"],
    }),
  );
});

test("gelijktijdige verlopen tokens delen één refresh; ingetrokken toegang verhindert de aansluitende Gmail-call", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const { service, calls } = fixture(t, async (url) => {
    if (url.endsWith("/token")) {
      await gate;
      return json({ access_token: "new", expires_in: 3600 });
    }
    return json({ messages: [] });
  });
  const a = seed(service, { expiresAt: 0 });
  const jobs = [1, 2].map(() =>
    service.tool("a", "session-a", "gmail_search", {
      accountId: a.id,
      query: "",
    }),
  );
  service.sessionAccess("session-a", "none");
  release();
  const results = await Promise.allSettled(jobs);
  assert.equal(results.filter((r) => r.status === "rejected").length, 2);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/token"));
});

test("Google invalid_grant vraagt opnieuw verbinden en lekt geen tokens", async (t) => {
  const { service } = fixture(t, () =>
    json(
      { error: "invalid_grant", error_description: "private-refresh-token" },
      400,
    ),
  );
  const a = seed(service, { expiresAt: 0 });
  await assert.rejects(
    service.tool("a", "session-a", "gmail_search", {
      accountId: a.id,
      query: "",
    }),
    (e: any) =>
      /vernieuwd/.test(e.message) &&
      !e.message.includes("private-refresh-token"),
  );
  assert.equal(service.overview().accounts[0].status, "reconnect");
});

test("OAuth gebruikt loopback, state, PKCE en Google-scopes; dubbele callbacks krijgen geen toegang", async (t) => {
  const { service, calls, path } = fixture(t);
  const start = await service.begin({ companyId: "a", drafts: true });
  const auth = new URL(start.url),
    callback = new URL(auth.searchParams.get("redirect_uri")!);
  assert.equal(auth.origin, "https://accounts.google.com");
  assert.equal(callback.hostname, "127.0.0.1");
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  callback.search = new URLSearchParams({
    state: "incorrect",
    code: "fixture-code",
  }).toString();
  assert.equal((await fetch(callback)).status, 400);
  assert.equal(calls.length, 0);
  callback.searchParams.set("state", auth.searchParams.get("state")!);
  assert.equal((await fetch(callback)).status, 200);
  await until(() => service.overview().pending?.status === "complete");
  assert.equal(service.overview().accounts.length, 1);
  assert.equal(service.overview().accounts[0].links[0].companyId, "a");
  const tokenRequest = calls[0].init!.body as URLSearchParams;
  assert.equal(
    createHash("sha256")
      .update(tokenRequest.get("code_verifier")!)
      .digest("base64url"),
    auth.searchParams.get("code_challenge"),
  );
  assert.doesNotMatch(
    readFileSync(path, "utf8"),
    /fixture-access|fixture-refresh/,
  );
  service.sessionAccess("s", "draft");
  assert.equal(service.available("a", "s")[0].drafts, true);
  const duplicate = await service.begin({ companyId: "b", drafts: true });
  const du = new URL(duplicate.url),
    cb = new URL(du.searchParams.get("redirect_uri")!);
  cb.search = new URLSearchParams({
    state: du.searchParams.get("state")!,
    code: "second",
  }).toString();
  await fetch(cb);
  await until(() => service.overview().pending?.status === "complete");
  assert.equal(service.overview().accounts.length, 1);
  assert.deepEqual(
    service.available("b", "s"),
    [],
    "Reconnecting must not grant another company access",
  );
});

test("OAuth annuleren en geweigerde scopes slaan geen account op", async (t) => {
  const f = fixture(t);
  await f.service.begin({ companyId: "a" });
  await assert.rejects(
    f.service.begin({ companyId: "a" }),
    /al een Google-inlog/,
  );
  f.service.cancel();
  assert.equal(f.service.overview().pending?.status, "error");
  assert.equal(f.service.overview().accounts.length, 0);
  const limited = fixture(t, () =>
    json({ access_token: "limited", scope: READ }),
  );
  const start = await limited.service.begin({ companyId: "a", drafts: true });
  const auth = new URL(start.url),
    callback = new URL(auth.searchParams.get("redirect_uri")!);
  callback.search = new URLSearchParams({
    state: auth.searchParams.get("state")!,
    code: "limited",
  }).toString();
  await fetch(callback);
  await until(() => limited.service.overview().pending?.status === "error");
  assert.equal(limited.service.overview().accounts.length, 0);
});

test("Gmail zoekresultaten en multipart-threads zijn begrensd en markeren mails als onbetrouwbare brondata", async (t) => {
  const { service, calls } = fixture(t, (url) =>
    url.includes("messages?")
      ? json({ messages: [{ id: "msg-1" }], nextPageToken: "next" })
      : json({
          id: "msg-1",
          threadId: "thread-1",
          snippet: "Hello",
          payload: { headers: [{ name: "Subject", value: "Voorstel" }] },
        }),
  );
  const a = seed(service);
  const result: any = await service.tool("a", "session-a", "gmail_search", {
    accountId: a.id,
    query: "from:client@example.test",
    limit: 1,
  });
  assert.equal(
    new URL(calls[0].url).searchParams.get("q"),
    "from:client@example.test",
  );
  assert.equal(result.messages[0].threadId, "thread-1");
  assert.equal(result.nextPageToken, "next");
  const message = summarizeMessage(
    {
      payload: {
        parts: [
          {
            mimeType: "text/plain",
            body: {
              data: Buffer.from("x".repeat(30000)).toString("base64url"),
            },
          },
          {
            filename: "file.pdf",
            mimeType: "application/pdf",
            body: { size: 300 },
          },
        ],
      },
    },
    true,
  );
  assert.equal(message.parts![0].text.length, 24000);
  assert.equal(message.truncated, true);
  assert.equal(message.attachments!.length, 1);
  assert.equal(message.contentTrust, "untrusted_email");
});

test("verwijderen en rechten verminderen werken direct, hervatten behoudt de beperking", async (t) => {
  const { service, calls } = fixture(t),
    a = seed(service);
  service.sessionAccess("session-a", "read");
  service.endSession("session-a");
  service.sessionAccess("resume", undefined, "session-a");
  assert.deepEqual(service.available("a", "session-a"), []);
  assert.equal(service.available("a", "resume")[0].drafts, false);
  service.sessionAccess("missing-resume", undefined, "does-not-exist");
  assert.deepEqual(service.available("a", "missing-resume"), []);
  service.remove(a.id);
  await assert.rejects(
    service.tool("a", "session-a", "gmail_search", {
      accountId: a.id,
      query: "",
    }),
    /geen toestemming/,
  );
  assert.equal(calls.length, 0);
  assert.equal(service.overview().accounts.length, 0);
});

test("externe koppelingen blijven per bedrijf, versleutelen sleutels en leveren alleen lees-tools", async (t) => {
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const f = fixture(t, async (url, init) => {
    if (url === "https://api.fireflies.ai/graphql") {
      const body = JSON.parse(String(init?.body || "{}"));
      return json(
        body.query.includes("query { user")
          ? { data: { user: { email: "meetings@example.test" } } }
          : { data: { transcripts: [{ id: "meeting-1", title: "Weekly" }] } },
      );
    }
    if (url.includes("public.heypocketai.com"))
      return json({ success: true, data: [{ id: "recording-1" }] });
    if (url.includes("unipile.com"))
      return json({ items: [{ id: "account-1", type: "LINKEDIN" }] });
    if (url === "https://api.github.com/user")
      return json({ login: "benchdesk-test" });
    if (url.includes("/user/repos"))
      return json([
        {
          id: 1,
          full_name: "example/benchdesk",
          private: true,
          html_url: "https://github.com/example/benchdesk",
          default_branch: "main",
          updated_at: "2026-09-21T10:00:00Z",
        },
      ]);
    return json({});
  });
  for (const input of [
    { provider: "fireflies", companyId, apiKey: "fireflies-secret" },
    { provider: "pocket", companyId, apiKey: "pk_pocket-secret" },
    {
      provider: "unipile",
      companyId,
      apiKey: "unipile-secret",
      dsn: "https://api123.unipile.com:1337",
    },
    { provider: "github", companyId, apiKey: "github-secret" },
  ])
    await f.service.configureExternal(input);
  const overview = f.service.overview();
  assert.deepEqual(
    overview.external.map((connection) => connection.provider),
    ["fireflies", "pocket", "unipile", "github"],
  );
  assert.doesNotMatch(
    JSON.stringify(overview),
    /fireflies-secret|pocket-secret|unipile-secret|github-secret|api123/,
  );
  const disk = readFileSync(f.path, "utf8");
  assert.doesNotMatch(
    disk,
    /fireflies-secret|pocket-secret|unipile-secret|github-secret|api123/,
  );
  f.service.sessionAccess("external-session", "none");
  const github: any = await f.service.tool(
    companyId,
    "external-session",
    "github_list_repositories",
    {},
  );
  assert.equal(github.repositories[0].fullName, "example/benchdesk");
  const fireflies: any = await f.service.tool(
    companyId,
    "external-session",
    "fireflies_list_transcripts",
    {},
  );
  assert.equal(fireflies.contentTrust, "untrusted_meeting_data");
  assert.equal(fireflies.data[0].id, "meeting-1");
  const callsBeforeDenied = f.calls.length;
  await assert.rejects(
    f.service.tool(
      otherCompanyId,
      "external-session",
      "github_list_repositories",
      {},
    ),
    /geen toegang/,
  );
  assert.equal(f.calls.length, callsBeforeDenied);
  f.service.removeExternal(companyId, "github");
  await assert.rejects(
    f.service.tool(
      companyId,
      "external-session",
      "github_list_repositories",
      {},
    ),
    /geen toegang/,
  );
});

test("Blotato: MCP-functies via de vault, per bedrijf, met eigen namen en zonder sleutel op schijf", async (t) => {
  const { createServer } = await import("node:http");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );
  const { z } = await import("zod");
  const http = createServer(async (req, res) => {
    if (req.headers["blotato-api-key"] !== "blotato-secret") {
      res.writeHead(401).end();
      return;
    }
    const body = await new Promise<string>((ok) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => ok(data));
    });
    const server = new McpServer({ name: "blotato-fixture", version: "1" });
    server.registerTool(
      "blotato_list_accounts",
      { description: "List accounts", inputSchema: {} },
      async () => ({ content: [{ type: "text", text: "account-1" }] }),
    );
    server.registerTool(
      "create_post",
      { description: "Create a post", inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ type: "text", text: `posted:${text}` }] }),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  });
  await new Promise<void>((ok) => http.listen(0, "127.0.0.1", ok));
  t.after(() => http.close());
  const local = `http://127.0.0.1:${(http.address() as any).port}`;
  const companyId = randomUUID();
  const f = fixture(t, (url, init) =>
    fetch(url.replace("https://mcp.blotato.com", local), init),
  );
  await assert.rejects(
    f.service.configureExternal({ provider: "blotato", companyId, apiKey: "wrong-key-123" }),
    /weigerde|niet bereikbaar/,
  );
  const saved = await f.service.configureExternal({
    provider: "blotato",
    companyId,
    apiKey: "blotato-secret",
  });
  assert.equal(saved.label, "2 functies");
  assert.doesNotMatch(readFileSync(f.path, "utf8"), /blotato-secret/);
  assert.doesNotMatch(JSON.stringify(f.service.overview()), /blotato-secret/);
  f.service.sessionAccess("blotato-session", "none");
  const tools = await f.service.remoteTools(companyId, "blotato-session", () => true);
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["blotato_create_post", "blotato_list_accounts"],
  );
  assert.equal(tools.find((tool) => tool.name === "blotato_create_post")!.inputSchema.type, "object");
  assert.deepEqual(await f.service.remoteTools(companyId, "blotato-session", () => false), []);
  assert.deepEqual(await f.service.remoteTools(randomUUID(), "blotato-session", () => true), []);
  const result: any = await f.service.tool(companyId, "blotato-session", "blotato_create_post", {
    text: "hoi",
  });
  assert.equal(result.content[0].text, "posted:hoi");
  assert.equal(result.contentTrust, "untrusted_external");
  f.service.removeExternal(companyId, "blotato");
  await assert.rejects(
    f.service.tool(companyId, "blotato-session", "blotato_create_post", { text: "x" }),
    /geen toegang/,
  );
});
