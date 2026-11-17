import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { z } from "zod";
import { IntegrationVault } from "../core/integration-vault";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  remoteMcp,
  type RemoteTool,
  externalConfig,
  externalProvider,
  externalTools,
  gmailAccess,
  gmailConnect,
  gmailLink,
  gmailTools,
  googleConfig,
  type GmailAccess,
  type GmailAccount,
  type IntegrationOverview,
  type ExternalProvider,
} from "../shared/integrations";

const READ = "https://www.googleapis.com/auth/gmail.readonly";
const COMPOSE = "https://www.googleapis.com/auth/gmail.compose";
const API = "https://gmail.googleapis.com/gmail/v1/users/me/";
type Account = Omit<GmailAccount, "canDraft"> & {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  scopes: string[];
};
type Receipt = {
  hash: string;
  status: "pending" | "complete";
  result?: unknown;
};
type Data = {
  config?: z.infer<typeof googleConfig>;
  accounts: Account[];
  receipts: Record<string, Receipt>;
  external?: StoredExternal[];
};
type StoredExternal = z.infer<typeof externalConfig> & {
  label: string;
  connectedAt: string;
};
type Pending = {
  id: string;
  status: "waiting" | "complete" | "error";
  message: string;
  server: Server;
  timer?: NodeJS.Timeout;
};

export function draftMime(
  input: z.infer<typeof gmailTools.gmail_create_draft.schema>,
  from?: string,
) {
  const headers = [
    ...(from ? [`From: ${z.string().email().parse(from)}`] : []),
    `To: ${input.to.join(",\r\n ")}`,
    ...(input.cc.length ? [`Cc: ${input.cc.join(",\r\n ")}`] : []),
    // Fold RFC 2047 encoded words without splitting UTF-8 characters.
    `Subject: ${Array.from(input.subject)
      .reduce<string[]>((parts, char) => {
        if (
          !parts.length ||
          Buffer.byteLength(parts[parts.length - 1] + char) > 42
        )
          parts.push(char);
        else parts[parts.length - 1] += char;
        return parts;
      }, [])
      .map((part) => `=?UTF-8?B?${Buffer.from(part).toString("base64")}?=`)
      .join("\r\n ")}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const body =
    Buffer.from(input.body.replace(/\r?\n/g, "\r\n"))
      .toString("base64")
      .match(/.{1,76}/g)
      ?.join("\r\n") || "";
  return Buffer.from(headers.join("\r\n") + "\r\n\r\n" + body).toString(
    "base64url",
  );
}

export function summarizeMessage(message: any, withBody = false) {
  const headers = (message.payload?.headers || [])
    .filter((h: any) =>
      ["from", "to", "cc", "subject", "date", "message-id"].includes(
        String(h.name).toLowerCase(),
      ),
    )
    .slice(0, 20)
    .map((h: any) => ({
      name: String(h.name).slice(0, 30),
      value: String(h.value).slice(0, 2000),
    }));
  const parts: { text: string; mimeType: string }[] = [],
    attachments: { filename: string; mimeType: string; size: number }[] = [];
  let remaining = 24000,
    truncated = false;
  const walk = (part: any, depth = 0) => {
    if (depth > 20) {
      truncated = true;
      return;
    }
    if (part.filename)
      attachments.push({
        filename: String(part.filename).slice(0, 300),
        mimeType: part.mimeType,
        size: part.body?.size || 0,
      });
    else if (
      withBody &&
      part.body?.data &&
      ["text/plain", "text/html"].includes(part.mimeType)
    ) {
      const text = Buffer.from(part.body.data, "base64url").toString("utf8");
      if (text.length > remaining) truncated = true;
      if (remaining)
        parts.push({ text: text.slice(0, remaining), mimeType: part.mimeType });
      remaining = Math.max(0, remaining - text.length);
    }
    for (const child of part.parts || []) walk(child, depth + 1);
  };
  walk(message.payload || {});
  return {
    id: message.id,
    threadId: message.threadId,
    snippet: String(message.snippet || "").slice(0, 2000),
    contentTrust: "untrusted_email",
    headers,
    ...(withBody
      ? { parts, attachments: attachments.slice(0, 100), truncated }
      : {}),
  };
}

type RemoteEntry = {
  key: string;
  client: Promise<Client>;
  tools?: { at: number; list: (RemoteTool & { original: string })[] };
};

export class IntegrationService {
  readonly vault: IntegrationVault<Data>;
  private pending: Pending | null = null;
  private refreshes = new Map<string, Promise<string>>();
  private sessions = new Map<string, GmailAccess>();
  private externalSessions = new Set<string>();
  // Remote MCP clients per company and provider, with their last tool list.
  private remote = new Map<string, RemoteEntry>();
  private ended = new Set<string>();
  constructor(
    path: string,
    private changed: () => void = () => {},
    private fetcher: typeof fetch = fetch,
  ) {
    this.vault = new IntegrationVault(path, () => ({
      accounts: [],
      receipts: {},
    }));
  }
  overview(): IntegrationOverview {
    const data = this.vault.unlocked ? this.vault.value : null;
    return {
      unlocked: !!data,
      configured: !!data?.config,
      clientId: data?.config?.clientId || "",
      accounts: (data?.accounts || []).map((a) => this.publicAccount(a)),
      pending: this.pending
        ? {
            id: this.pending.id,
            status: this.pending.status,
            message: this.pending.message,
          }
        : null,
      sessions: Object.fromEntries(this.sessions),
      external: (data?.external || []).map(
        ({ provider, companyId, label, connectedAt }) => ({
          provider,
          companyId,
          label,
          connectedAt,
        }),
      ),
    };
  }
  private publicAccount(a: Account): GmailAccount {
    return {
      id: a.id,
      email: a.email,
      status: a.status,
      links: a.links.map((l) => ({ ...l })),
      connectedAt: a.connectedAt,
      canDraft: a.scopes.includes(COMPOSE),
    };
  }
  configure(input: unknown) {
    const config = googleConfig.parse(input),
      data = this.vault.value;
    if (this.pending?.status === "waiting")
      throw new Error("Rond eerst de Google-inlog af of annuleer deze.");
    if (data.accounts.length && data.config?.clientId !== config.clientId)
      throw new Error(
        "Verwijder eerst de Gmail-verbindingen voordat je van Google-app wisselt.",
      );
    data.config = config;
    this.vault.save();
  }
  private externalConnection(companyId: string, provider: ExternalProvider) {
    const connection = (this.vault.value.external || []).find(
      (item) => item.companyId === companyId && item.provider === provider,
    );
    if (!connection)
      throw new Error(
        `${provider[0].toUpperCase()}${provider.slice(1)} is niet verbonden voor dit bedrijf.`,
      );
    return connection;
  }
  private async externalJson(
    service: string,
    url: string,
    init: RequestInit,
  ) {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error(`${service} is niet bereikbaar. Probeer het opnieuw.`);
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 6000000) {
          await reader.cancel();
          throw new Error(`${service} gaf een te groot antwoord.`);
        }
        chunks.push(value);
      }
    let data: any;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Error(`${service} gaf een ongeldig antwoord.`);
    }
    if (!response.ok)
      throw new Error(
        response.status === 401 || response.status === 403
          ? `${service} weigert de API-sleutel of de benodigde rechten.`
          : response.status === 429
            ? `${service} heeft de aanvraaglimiet bereikt. Probeer later opnieuw.`
            : `${service}-aanvraag geweigerd (${response.status}).`,
      );
    return data;
  }
  private async verifyExternal(config: z.infer<typeof externalConfig>) {
    if (config.provider === "fireflies") {
      const data = await this.externalJson(
        "Fireflies",
        "https://api.fireflies.ai/graphql",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query: "query { user { email name } }" }),
        },
      );
      if (data.errors?.length || !data.data?.user)
        throw new Error("Fireflies kon dit account niet lezen.");
      return String(data.data.user.email || data.data.user.name || "Fireflies").slice(
        0,
        250,
      );
    }
    if (config.provider === "pocket") {
      await this.externalJson(
        "Pocket",
        "https://public.heypocketai.com/api/v1/public/recordings?limit=1",
        { headers: { Authorization: `Bearer ${config.apiKey}` } },
      );
      return "Pocket";
    }
    if (config.provider === "blotato") {
      const tools = await this.remoteList(config, true);
      if (!tools.length) throw new Error("Blotato gaf geen functies terug.");
      return `${tools.length} functies`;
    }
    if (config.provider === "unipile") {
      const data = await this.externalJson(
        "Unipile",
        `${config.dsn}/api/v1/accounts?limit=1`,
        { headers: { "X-API-KEY": config.apiKey, Accept: "application/json" } },
      );
      const count = Array.isArray(data?.items) ? data.items.length : 0;
      return count ? `${count}+ account` : new URL(config.dsn).hostname;
    }
    const data = await this.externalJson(
      "GitHub",
      "https://api.github.com/user",
      {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Benchdesk",
        },
      },
    );
    if (typeof data.login !== "string")
      throw new Error("GitHub kon dit account niet lezen.");
    return data.login.slice(0, 250);
  }
  private remoteClient(
    connection: StoredExternal | z.infer<typeof externalConfig>,
  ): RemoteEntry {
    const server = remoteMcp[connection.provider];
    if (!server) throw new Error("Deze koppeling heeft geen MCP-server.");
    const id = `${connection.companyId}:${connection.provider}`,
      cached = this.remote.get(id);
    if (cached?.key === connection.apiKey) return cached;
    if (cached) void cached.client.then((c) => c.close()).catch(() => {});
    const client = (async () => {
      const c = new Client({ name: "benchdesk", version: "1" });
      await c.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: { [server.header]: connection.apiKey } },
          fetch: this.fetcher,
        }),
      );
      return c;
    })();
    const entry: RemoteEntry = { key: connection.apiKey, client };
    this.remote.set(id, entry);
    // A failed connection is not cached, so the next call tries again.
    client.catch(() => {
      if (this.remote.get(id) === entry) this.remote.delete(id);
    });
    return entry;
  }
  private dropRemote(companyId: string, provider: ExternalProvider) {
    const id = `${companyId}:${provider}`,
      cached = this.remote.get(id);
    if (!cached) return;
    this.remote.delete(id);
    void cached.client.then((c) => c.close()).catch(() => {});
  }
  private async remoteList(
    connection: StoredExternal | z.infer<typeof externalConfig>,
    fresh = false,
  ) {
    const entry = this.remoteClient(connection);
    if (!fresh && entry.tools && Date.now() - entry.tools.at < 600000)
      return entry.tools.list;
    const provider = connection.provider;
    let result;
    try {
      result = await (await entry.client).listTools();
    } catch (e) {
      this.dropRemote(connection.companyId, provider);
      const message = (e as Error).message || "";
      throw new Error(
        /401|403|unauthori[sz]ed|forbidden/i.test(message)
          ? `${provider[0].toUpperCase()}${provider.slice(1)} weigerde de API-sleutel.`
          : `${provider[0].toUpperCase()}${provider.slice(1)} is niet bereikbaar.`,
      );
    }
    const list = result.tools.slice(0, 100).map((tool) => ({
      // Namespaced so routing and rules can tell providers apart.
      name: (tool.name.startsWith(`${provider}_`)
        ? tool.name
        : `${provider}_${tool.name}`
      ).slice(0, 64),
      original: tool.name,
      description: String(tool.description || "").slice(0, 4000),
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }));
    entry.tools = { at: Date.now(), list };
    return list;
  }
  async remoteTools(
    companyId: string,
    sessionId: string,
    permits: (provider: ExternalProvider) => boolean,
  ): Promise<RemoteTool[]> {
    const tools: RemoteTool[] = [];
    for (const { provider } of this.externalAvailable(companyId, sessionId)) {
      if (!remoteMcp[provider] || !permits(provider)) continue;
      try {
        const list = await this.remoteList(
          this.externalConnection(companyId, provider),
        );
        tools.push(
          ...list.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        );
      } catch {
        // An unreachable provider leaves out its tools; the others still work.
      }
    }
    return tools;
  }
  private async remoteTool(
    companyId: string,
    sessionId: string,
    name: string,
    args: unknown,
  ) {
    const provider = externalProvider.parse(name.split("_")[0]);
    if (
      !remoteMcp[provider] ||
      !this.externalAvailable(companyId, sessionId).some(
        (item) => item.provider === provider,
      )
    )
      throw new Error(
        "Deze sessie heeft geen toegang tot deze koppeling. Verbind de dienst bij Koppelingen en start of hervat het gesprek.",
      );
    const connection = this.externalConnection(companyId, provider);
    const tool = (await this.remoteList(connection)).find(
      (t) => t.name === name,
    );
    if (!tool) throw new Error("Onbekende functie van deze koppeling.");
    const result = await (
      await this.remoteClient(connection).client
    ).callTool({
      name: tool.original,
      arguments: (args && typeof args === "object" ? args : {}) as Record<
        string,
        unknown
      >,
    });
    return {
      content: Array.isArray(result.content) ? result.content : [],
      isError: !!result.isError,
      contentTrust: "untrusted_external",
    };
  }
  async configureExternal(input: unknown) {
    const config = externalConfig.parse(input);
    const label = await this.verifyExternal(config);
    const external = this.vault.value.external || [];
    this.vault.value.external = external.filter(
      (item) =>
        item.companyId !== config.companyId || item.provider !== config.provider,
    );
    this.vault.value.external.push({
      ...config,
      label,
      connectedAt: new Date().toISOString(),
    } as StoredExternal);
    this.vault.save();
    this.changed();
    return { provider: config.provider, companyId: config.companyId, label };
  }
  async testExternal(companyId: unknown, provider: unknown) {
    const id = z.string().uuid().parse(companyId);
    const name = externalProvider.parse(provider);
    const connection = this.externalConnection(id, name);
    return { ok: true, label: await this.verifyExternal(connection) };
  }
  removeExternal(companyId: unknown, provider: unknown) {
    const id = z.string().uuid().parse(companyId);
    const name = externalProvider.parse(provider);
    this.externalConnection(id, name);
    this.vault.value.external = (this.vault.value.external || []).filter(
      (item) => item.companyId !== id || item.provider !== name,
    );
    this.dropRemote(id, name);
    this.vault.save();
    this.changed();
  }
  sessionAccess(
    id: string,
    access?: GmailAccess,
    resumeFrom?: string,
    allowExternal = true,
  ) {
    if (allowExternal) this.externalSessions.add(id);
    else this.externalSessions.delete(id);
    if (access) this.sessions.set(id, gmailAccess.parse(access));
    else
      this.sessions.set(
        id,
        resumeFrom ? this.sessions.get(resumeFrom) || "none" : "draft",
      );
  }
  endSession(id: string) {
    this.ended.add(id);
  }
  private account(id: string) {
    const a = this.vault.value.accounts.find((a) => a.id === id);
    if (!a) throw new Error("Gmail-account niet gevonden.");
    return a;
  }
  links(id: string, input: unknown) {
    const links = z.array(gmailLink).max(100).parse(input),
      a = this.account(id);
    if (new Set(links.map((l) => l.companyId)).size !== links.length)
      throw new Error("Bedrijf staat dubbel in de koppeling.");
    if (links.some((l) => l.drafts) && !a.scopes.includes(COMPOSE))
      throw new Error(
        "Verbind dit account opnieuw met toestemming voor concepten.",
      );
    a.links = links;
    this.vault.save();
  }
  remove(id: string) {
    this.account(id);
    if (this.pending?.status === "waiting")
      throw new Error("Annuleer eerst de lopende Google-inlog.");
    this.vault.value.accounts = this.vault.value.accounts.filter(
      (a) => a.id !== id,
    );
    for (const key of Object.keys(this.vault.value.receipts))
      if (key.startsWith(id + ":")) delete this.vault.value.receipts[key];
    this.vault.save();
  }
  cancel() {
    if (this.pending?.status === "waiting")
      this.finish(
        this.pending,
        "error",
        "Google-inlog geannuleerd. Je kunt opnieuw verbinden.",
      );
  }
  close() {
    this.cancel();
  }
  private finish(p: Pending, status: "complete" | "error", message: string) {
    if (p.status !== "waiting") return;
    p.status = status;
    p.message = message;
    clearTimeout(p.timer);
    p.server.close();
    this.changed();
  }
  private async json(
    url: string,
    init: RequestInit = {},
  ): Promise<{ response: Response; data: any }> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      throw new Error("Google is niet bereikbaar. Probeer het opnieuw.");
    }
    const reader = response.body?.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (reader)
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 8000000) {
          await reader.cancel();
          throw new Error("Dit Gmail-antwoord is te groot om te lezen.");
        }
        chunks.push(value);
      }
    try {
      return {
        response,
        data: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      };
    } catch {
      throw new Error("Google gaf een ongeldig antwoord.");
    }
  }
  async begin(input: unknown) {
    const args = gmailConnect.parse(input),
      config = this.vault.value.config;
    if (!config) throw new Error("Stel eerst de Google-appgegevens in.");
    if (this.pending?.status === "waiting")
      throw new Error("Er staat al een Google-inlog open.");
    const expected = args.accountId ? this.account(args.accountId) : undefined;
    const verifier = randomBytes(48).toString("base64url"),
      state = randomBytes(32).toString("base64url");
    let claimed = false;
    let redirect = "";
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      let url: URL;
      try {
        url = new URL(req.url || "/", "http://127.0.0.1");
      } catch {
        res.writeHead(400);
        res.end("Ongeldige inlogaanvraag.");
        return;
      }
      if (
        !redirect ||
        req.method !== "GET" ||
        url.pathname !== "/oauth/callback" ||
        req.headers.host !== new URL(redirect).host ||
        url.searchParams.get("state") !== state ||
        claimed ||
        p.status !== "waiting"
      ) {
        res.writeHead(400);
        res.end("Ongeldige inlogaanvraag.");
        return;
      }
      claimed = true;
      const code = url.searchParams.get("code");
      if (url.searchParams.has("error") || !code) {
        this.finish(
          p,
          "error",
          "Google-toegang is niet verleend. Je kunt opnieuw verbinden.",
        );
        res.end("Geen verbinding gemaakt. Ga terug naar Benchdesk.");
        return;
      }
      res.end(
        "Google-inlog ontvangen. Ga terug naar Benchdesk om de verbindingsstatus te bekijken.",
      );
      void (async () => {
        try {
          const { response, data } = await this.json(
            "https://oauth2.googleapis.com/token",
            {
              method: "POST",
              body: new URLSearchParams({
                client_id: config.clientId,
                client_secret: config.clientSecret,
                code,
                code_verifier: verifier,
                redirect_uri: redirect,
                grant_type: "authorization_code",
              }),
            },
          );
          if (!response.ok || typeof data.access_token !== "string")
            throw new Error(
              "Google-inlog mislukt. Controleer de Desktop-appgegevens en probeer opnieuw.",
            );
          const scopes =
            typeof data.scope === "string" ? data.scope.split(" ") : [];
          if (
            !scopes.includes(READ) ||
            (args.drafts && !scopes.includes(COMPOSE))
          )
            throw new Error(
              "Niet alle gevraagde Gmail-rechten zijn verleend. Verbind opnieuw en vink de gevraagde rechten aan.",
            );
          const profile = await this.json(API + "profile", {
            headers: { Authorization: `Bearer ${data.access_token}` },
          });
          if (
            !profile.response.ok ||
            !z.string().email().safeParse(profile.data.emailAddress).success
          )
            throw new Error(
              "Gmail-profiel niet beschikbaar. Controleer of de Gmail API aan staat.",
            );
          const email = profile.data.emailAddress.toLowerCase();
          if (expected && expected.email !== email)
            throw new Error(
              "Je koos een ander Google-account. Gebruik het oorspronkelijke account om opnieuw te verbinden.",
            );
          if (p.status !== "waiting" || this.pending !== p) return;
          const old = this.vault.value.accounts.find((a) => a.email === email);
          const refreshToken = data.refresh_token || old?.refreshToken;
          if (!refreshToken)
            throw new Error(
              "Google gaf geen blijvende toegang. Verbind het account opnieuw.",
            );
          const links = old
            ? old.links.map((l) => ({
                ...l,
                drafts: l.drafts && scopes.includes(COMPOSE),
              }))
            : [{ companyId: args.companyId, drafts: args.drafts }];
          // Reconnecting never silently grants a new company access.
          const account: Account = {
            id: old?.id || randomUUID(),
            email,
            links,
            connectedAt: new Date().toISOString(),
            refreshToken,
            accessToken: data.access_token,
            expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
            scopes,
            status: "connected",
          };
          if (old)
            this.vault.value.accounts = this.vault.value.accounts.filter(
              (a) => a.id !== old.id,
            );
          this.vault.value.accounts.push(account);
          this.vault.save();
          this.finish(
            p,
            "complete",
            `${email} is verbonden. Controleer hieronder de toegang per bedrijf.`,
          );
        } catch (e) {
          this.finish(p, "error", (e as Error).message);
        }
      })();
    });
    const p: Pending = {
      id: randomUUID(),
      status: "waiting",
      message: "Rond de Google-inlog af in je browser.",
      server,
    };
    this.pending = p;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
    } catch {
      this.finish(p, "error", "De lokale Google-inlog kon niet starten.");
      throw new Error(p.message);
    }
    redirect = `http://127.0.0.1:${(server.address() as { port: number }).port}/oauth/callback`;
    p.timer = setTimeout(
      () =>
        this.finish(
          p,
          "error",
          "De Google-inlog is verlopen. Probeer opnieuw.",
        ),
      180000,
    );
    p.timer.unref();
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirect,
      response_type: "code",
      scope: [READ, ...(args.drafts ? [COMPOSE] : [])].join(" "),
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent select_account",
      ...(expected ? { login_hint: expected.email } : {}),
    }).toString();
    return { id: p.id, url: url.href };
  }
  private async token(a: Account, force = false) {
    if (!force && a.expiresAt > Date.now() + 60000) return a.accessToken;
    const ongoing = this.refreshes.get(a.id);
    if (ongoing) return ongoing;
    const job = (async () => {
      const config = this.vault.value.config!;
      const { response, data } = await this.json(
        "https://oauth2.googleapis.com/token",
        {
          method: "POST",
          body: new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            refresh_token: a.refreshToken,
            grant_type: "refresh_token",
          }),
        },
      );
      if (!response.ok || typeof data.access_token !== "string") {
        if (response.status === 400 || response.status === 401) {
          a.status = "reconnect";
          this.vault.save();
          this.changed();
        }
        throw new Error(
          "Gmail-toegang kon niet worden vernieuwd. Controleer de verbinding bij Koppelingen.",
        );
      }
      a.accessToken = data.access_token;
      a.expiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
      if (data.refresh_token) a.refreshToken = data.refresh_token;
      this.vault.save();
      return a.accessToken;
    })().finally(() => this.refreshes.delete(a.id));
    this.refreshes.set(a.id, job);
    return job;
  }
  available(companyId: string, sessionId: string) {
    if (
      !this.vault.unlocked ||
      this.ended.has(sessionId) ||
      !this.sessions.has(sessionId) ||
      this.sessions.get(sessionId) === "none"
    )
      return [];
    return this.vault.value.accounts
      .filter((a) => a.links.some((l) => l.companyId === companyId))
      .map((a) => ({
        accountId: a.id,
        email: a.email,
        status: a.status,
        read: true,
        drafts:
          this.sessions.get(sessionId) === "draft" &&
          a.scopes.includes(COMPOSE) &&
          a.links.some((l) => l.companyId === companyId && l.drafts),
      }));
  }
  private authorize(
    companyId: string,
    sessionId: string,
    accountId: string,
    draft: boolean,
  ) {
    const permission = this.available(companyId, sessionId).find(
      (a) => a.accountId === accountId,
    );
    if (!permission || (draft && !permission.drafts))
      throw new Error(
        "Deze sessie heeft geen toestemming voor deze Gmail-actie.",
      );
    if (permission.status !== "connected")
      throw new Error("Verbind dit Gmail-account opnieuw via Koppelingen.");
    return this.account(accountId);
  }
  externalAvailable(companyId: string, sessionId: string) {
    if (
      !this.vault.unlocked ||
      this.ended.has(sessionId) ||
      !this.sessions.has(sessionId) ||
      !this.externalSessions.has(sessionId)
    )
      return [];
    return (this.vault.value.external || [])
      .filter((item) => item.companyId === companyId)
      .map(({ provider, label }) => ({ provider, label, read: true }));
  }
  private async externalTool(
    companyId: string,
    sessionId: string,
    name: keyof typeof externalTools,
    args: unknown,
  ) {
    const definition = externalTools[name];
    const input = definition.schema.parse(args) as any;
    const provider = externalProvider.parse(name.split("_")[0]);
    if (
      !this.externalAvailable(companyId, sessionId).some(
        (item) => item.provider === provider,
      )
    )
      throw new Error(
        "Deze sessie heeft geen toegang tot deze koppeling. Verbind de dienst bij Koppelingen en start of hervat het gesprek.",
      );
    const connection = this.externalConnection(companyId, provider);
    const json = (service: string, url: string, init: RequestInit) => {
      if (
        !this.externalAvailable(companyId, sessionId).some(
          (item) => item.provider === provider,
        )
      )
        throw new Error("Deze sessie heeft geen toegang meer tot deze koppeling.");
      return this.externalJson(service, url, init);
    };
    if (provider === "fireflies") {
      const query =
        name === "fireflies_list_transcripts"
          ? `query Transcripts($keyword: String, $fromDate: DateTime, $toDate: DateTime, $limit: Int, $skip: Int) {
              transcripts(keyword: $keyword, scope: all, fromDate: $fromDate, toDate: $toDate, limit: $limit, skip: $skip) {
                id title date duration host_email participants transcript_url summary { short_summary action_items topics_discussed }
              }
            }`
          : `query Transcript($id: String!) {
              transcript(id: $id) {
                id title date duration host_email participants transcript_url
                meeting_attendees { displayName email }
                sentences { index speaker_name text start_time end_time }
                summary { keywords action_items overview short_summary topics_discussed }
              }
            }`;
      const variables =
        name === "fireflies_list_transcripts"
          ? input
          : { id: input.transcriptId };
      const data = await json(
        "Fireflies",
        "https://api.fireflies.ai/graphql",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${connection.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query, variables }),
        },
      );
      if (data.errors?.length)
        throw new Error("Fireflies kon de gevraagde transcriptie niet lezen.");
      return {
        contentTrust: "untrusted_meeting_data",
        data:
          name === "fireflies_list_transcripts"
            ? data.data?.transcripts
            : data.data?.transcript,
      };
    }
    if (provider === "pocket") {
      const headers = { Authorization: `Bearer ${connection.apiKey}` };
      let path = "/recordings";
      if (name === "pocket_list_recordings") {
        const params = new URLSearchParams({
          page: String(input.page),
          limit: String(input.limit),
          ...(input.startDate ? { start_date: input.startDate } : {}),
          ...(input.endDate ? { end_date: input.endDate } : {}),
          ...(input.tagIds.length ? { tag_ids: input.tagIds.join(",") } : {}),
        });
        path += `?${params}`;
      } else if (name === "pocket_get_recording")
        path += `/${encodeURIComponent(input.recordingId)}?include_transcript=true&include_summarizations=true`;
      else path = "/tags";
      const data = await json(
        "Pocket",
        `https://public.heypocketai.com/api/v1/public${path}`,
        { headers },
      );
      return { contentTrust: "untrusted_meeting_data", ...data };
    }
    if (provider === "unipile") {
      const params = new URLSearchParams({
        limit: String(input.limit),
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.accountId ? { account_id: input.accountId } : {}),
      });
      const path =
        name === "unipile_list_accounts"
          ? "/accounts"
          : name === "unipile_list_chats"
            ? "/chats"
            : `/chats/${encodeURIComponent(input.chatId)}/messages`;
      const data = await json(
        "Unipile",
        `${(connection as Extract<StoredExternal, { provider: "unipile" }>).dsn}/api/v1${path}?${params}`,
        {
          headers: {
            "X-API-KEY": connection.apiKey,
            Accept: "application/json",
          },
        },
      );
      return { contentTrust: "untrusted_communication_data", data };
    }
    const githubHeaders = {
      Authorization: `Bearer ${connection.apiKey}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Benchdesk",
    };
    if (name === "github_list_repositories") {
      const params = new URLSearchParams({
        visibility: "all",
        affiliation: "owner,collaborator,organization_member",
        sort: "updated",
        page: String(input.page),
        per_page: String(input.limit),
      });
      const data = await json(
        "GitHub",
        `https://api.github.com/user/repos?${params}`,
        { headers: githubHeaders },
      );
      return {
        contentTrust: "untrusted_repository_data",
        repositories: (Array.isArray(data) ? data : []).map((repo: any) => ({
          id: repo.id,
          fullName: repo.full_name,
          private: repo.private,
          description: repo.description,
          url: repo.html_url,
          defaultBranch: repo.default_branch,
          updatedAt: repo.updated_at,
        })),
      };
    }
    if (name === "github_search_issues") {
      const params = new URLSearchParams({
        q: input.query,
        page: String(input.page),
        per_page: String(input.limit),
      });
      const data = await json(
        "GitHub",
        `https://api.github.com/search/issues?${params}`,
        { headers: githubHeaders },
      );
      return {
        contentTrust: "untrusted_repository_data",
        totalCount: data.total_count,
        incompleteResults: data.incomplete_results,
        items: (data.items || []).map((issue: any) => ({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          state: issue.state,
          url: issue.html_url,
          repositoryUrl: issue.repository_url,
          author: issue.user?.login,
          labels: (issue.labels || []).map((label: any) => label.name),
          updatedAt: issue.updated_at,
          isPullRequest: !!issue.pull_request,
        })),
      };
    }
    const base = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/${input.number}`;
    const [issue, comments] = await Promise.all([
      json("GitHub", base, { headers: githubHeaders }),
      json("GitHub", `${base}/comments?per_page=100`, {
        headers: githubHeaders,
      }),
    ]);
    return {
      contentTrust: "untrusted_repository_data",
      issue: {
        number: issue.number,
        title: issue.title,
        state: issue.state,
        body: String(issue.body || "").slice(0, 100000),
        url: issue.html_url,
        author: issue.user?.login,
        labels: (issue.labels || []).map((label: any) => label.name),
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
      },
      comments: (Array.isArray(comments) ? comments : []).map((comment: any) => ({
        id: comment.id,
        author: comment.user?.login,
        body: String(comment.body || "").slice(0, 30000),
        createdAt: comment.created_at,
        updatedAt: comment.updated_at,
      })),
    };
  }
  async tool(
    companyId: string,
    sessionId: string,
    name: string,
    args: unknown,
  ) {
    if (/^[a-z]+_/.test(name) && remoteMcp[name.split("_")[0] as ExternalProvider])
      return this.remoteTool(companyId, sessionId, name, args);
    if (Object.hasOwn(externalTools, name))
      return this.externalTool(
        companyId,
        sessionId,
        name as keyof typeof externalTools,
        args,
      );
    const definition = gmailTools[name as keyof typeof gmailTools];
    if (!definition) throw new Error("Onbekende Gmail-functie.");
    const input = definition.schema.parse(args) as any;
    if (name === "gmail_list_accounts")
      return { accounts: this.available(companyId, sessionId) };
    const draft = name === "gmail_create_draft";
    const a = this.authorize(companyId, sessionId, input.accountId, draft);
    const request = async (path: string, init: RequestInit = {}) => {
      let token = await this.token(a);
      // Permissions are checked again after token refresh, immediately before I/O.
      this.authorize(companyId, sessionId, input.accountId, draft);
      let result = await this.json(API + path, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });
      if (result.response.status === 401) {
        token = await this.token(a, true);
        this.authorize(companyId, sessionId, input.accountId, draft);
        result = await this.json(API + path, {
          ...init,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        });
      }
      if (!result.response.ok) {
        if (result.response.status === 401) {
          a.status = "reconnect";
          this.vault.save();
          this.changed();
        }
        throw new Error(
          result.response.status === 404
            ? "Gmail-bericht niet gevonden."
            : result.response.status === 429
              ? "Gmail is tijdelijk te druk. Probeer later opnieuw."
              : `Gmail-aanvraag geweigerd (${result.response.status}). Controleer de verbinding en rechten bij Koppelingen.`,
        );
      }
      this.authorize(companyId, sessionId, input.accountId, draft);
      return result.data;
    };
    if (name === "gmail_search") {
      const query = new URLSearchParams({
        q: input.query,
        maxResults: String(input.limit),
        ...(input.pageToken ? { pageToken: input.pageToken } : {}),
      });
      const list = await request("messages?" + query);
      const messages = (list.messages || []).slice(0, input.limit);
      const results: unknown[] = [];
      for (let i = 0; i < messages.length; i += 10)
        results.push(
          ...(await Promise.all(
            messages
              .slice(i, i + 10)
              .map(async (m: any) =>
                summarizeMessage(
                  await request(
                    `messages/${encodeURIComponent(m.id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
                  ),
                ),
              ),
          )),
        );
      this.authorize(companyId, sessionId, input.accountId, false);
      return {
        messages: results,
        nextPageToken: list.nextPageToken || null,
        resultSizeEstimate: list.resultSizeEstimate,
      };
    }
    if (name === "gmail_read_thread") {
      const thread = await request(
        `threads/${encodeURIComponent(input.threadId)}?format=full`,
      );
      const messages = thread.messages || [];
      return {
        id: thread.id,
        messages: messages
          .slice(-20)
          .map((m: any) => summarizeMessage(m, true)),
        omittedMessages: Math.max(0, messages.length - 20),
      };
    }
    const key = `${a.id}:${sessionId}:${input.requestId}`,
      hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const old = this.vault.value.receipts[key];
    if (old) {
      if (old.hash !== hash)
        throw new Error(
          "Deze requestId is al gebruikt voor een ander concept.",
        );
      if (old.status === "complete") return old.result;
      throw new Error(
        "Dit concept is mogelijk al gemaakt. Controleer eerst Gmail Concepten; herhaal deze aanvraag niet met een nieuwe requestId.",
      );
    }
    if (
      Object.keys(this.vault.value.receipts).filter((k) =>
        k.startsWith(`${a.id}:${sessionId}:`),
      ).length >= 200
    )
      throw new Error("Conceptlimiet voor deze sessie bereikt.");
    this.vault.value.receipts[key] = { hash, status: "pending" };
    this.vault.save();
    // Deliberately no automatic retry after a timeout: Google may have accepted it.
    const result = await request("drafts", {
      method: "POST",
      body: JSON.stringify({ message: { raw: draftMime(input, a.email) } }),
    });
    const receipt = {
      draftId: result.id,
      messageId: result.message?.id,
      sent: false,
    };
    this.vault.value.receipts[key] = {
      hash,
      status: "complete",
      result: receipt,
    };
    this.vault.save();
    return receipt;
  }
}
