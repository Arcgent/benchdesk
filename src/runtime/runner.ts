import { BrainService } from "./brain";
import { ChatService } from "./chats";
import { agentMethods, agentToolNames } from "../shared/agents";
import { JevService } from "./jev";
import { MAX_SOCKET_BUFFER } from "./rpc";
import { brainTools, brainId } from "../shared/brain";
import { availableToday } from "../shared/task-schedule";
import { sessionContextInput } from "../shared/context";
import net from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  chmodSync,
  appendFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import * as pty from "node-pty";
import { z } from "zod";
import { Store, folder } from "../core/store";
import { adapterConfig, benchdeskInstructions, promptFor, shellQuote, toml } from "./adapters";
import { inventory } from "./inventory";
import { PreferenceStore } from "../core/preferences";
import { accountEnvironment, authArgs, inspectAccount } from "./accounts";
import { homedir } from "node:os";
import { IntegrationService } from "./integrations";
import { gmailAccess, gmailConnect, gmailLink } from "../shared/integrations";
import type { AppEvent, Provider, Mode } from "../shared/types";
const require = createRequire(__filename);
const { Terminal } = require("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize");
type Live = {
  process: pty.IPty;
  term: any;
  serializer: any;
  sequence: number;
  appliedSequence: number;
  agentRunning: boolean;
  pending: string;
  timer?: NodeJS.Timeout;
  cols: number;
  rows: number;
  pendingFeedback?: string;
};
const dataDir = process.env.WERK_DATA_DIR!;
if (!dataDir) throw new Error("WERK_DATA_DIR ontbreekt.");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const socketPath = join(dataDir, "runner.sock"),
  tokenPath = join(dataDir, "control-token"),
  runtimeDir = __dirname;
const controlToken = existsSync(tokenPath)
  ? readFileSync(tokenPath, "utf8")
  : randomBytes(32).toString("hex");
writeFileSync(tokenPath, controlToken, { mode: 0o600 });
chmodSync(tokenPath, 0o600);
let store: Store;
let preferences: PreferenceStore;
let brain: BrainService;
let chats: ChatService;
const jev = new JevService(join(dataDir, "typesafe.vault"));
const lives = new Map<string, Live>(),
  clients = new Set<net.Socket>();
let shuttingDown = false;
// People never read a full path (README copy rule): the last two segments, like shortPath in the UI.
const shortDir = (path: string) =>
  path.split("/").filter(Boolean).slice(-2).join("/") || path;
function send(socket: net.Socket, data: any) {
  if (socket.destroyed) return;
  if (socket.writableLength > MAX_SOCKET_BUFFER) {
    socket.destroy();
    return;
  }
  socket.write(JSON.stringify(data) + "\n");
}
function broadcast(event: AppEvent) {
  for (const socket of clients) send(socket, { event });
}
function changed() {
  broadcast({ type: "changed" });
}
const integrations = new IntegrationService(
  join(dataDir, "integrations.vault"),
  changed,
);
function snapshot() {
  const result = store.snapshot();
  result.sessions = result.sessions.map((row) => ({
    ...row,
    alive: lives.has(row.id) || chats.active.has(row.id),
    agentRunning: lives.get(row.id)?.agentRunning || chats.active.has(row.id),
  }));
  return result;
}
function flush(sessionId: string) {
  const live = lives.get(sessionId);
  if (!live || !live.pending) return;
  const data = live.pending;
  live.pending = "";
  live.timer = undefined;
  const sequence = ++live.sequence;
  live.term.write(data, () => {
    live.appliedSequence = sequence;
  });
  broadcast({ type: "terminal", sessionId, data, sequence });
}
async function screen(sessionId: string) {
  const live = lives.get(sessionId);
  if (!live) {
    try {
      return JSON.parse(
        readFileSync(
          join(dataDir, "sessions", sessionId, "screen.json"),
          "utf8",
        ),
      );
    } catch {
      return {
        screen:
          "\r\nGesprek beëindigd. Hervat het opgeslagen gesprek om verder te werken.\r\n",
        cols: 100,
        rows: 30,
        sequence: 0,
      };
    }
  }
  flush(sessionId);
  return new Promise<any>((resolve) =>
    live.term.write("", () =>
      resolve({
        screen: live.serializer.serialize(),
        cols: live.cols,
        rows: live.rows,
        sequence: live.appliedSequence,
      }),
    ),
  );
}
async function persistScreen(sessionId: string) {
  try {
    const frame = await screen(sessionId);
    writeFileSync(
      join(dataDir, "sessions", sessionId, "screen.json"),
      JSON.stringify(frame),
      { mode: 0o600 },
    );
  } catch {}
}
function environment(extra: Record<string, string>) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env))
    if (
      key === "ELECTRON_RUN_AS_NODE" ||
      key === "CLAUDECODE" ||
      key === "CODEX_THREAD_ID" ||
      key.startsWith("NODETERM_") ||
      key.startsWith("BMONE_")
    )
      delete env[key];
  env.PATH = (env.PATH || "")
    .split(":")
    .filter((p) => !p.includes("bmone-title-hooks"))
    .join(":");
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  return env as Record<string, string>;
}
async function startSession(params: any, authAction?: "login" | "logout") {
  if (!authAction && (!params.mode || params.mode === "work")) {
    const previous = params.resumeFrom ? store.session(params.resumeFrom) : null;
    if (previous?.transport === "chat") {
      if (previous.companyId !== params.companyId || previous.taskId !== (params.taskId || null)) throw new Error("Gesprek hoort bij een andere taak of bedrijf.");
      return previous.id;
    }
    const agentId = Object.hasOwn(params, "agentId") ? params.agentId : params.taskId ? store.task(params.taskId).agentId : null;
    if (agentId) {
      const conversation = chats.start({ ...params, agentId });
      if (conversation.taskId) chats.send({ id: conversation.id, message: "Werk aan de gekoppelde taak. Lees de opdracht en criteria, stel vragen als er iets ontbreekt en lever het resultaat ter beoordeling op.", clientMessageId: randomUUID() });
      return conversation.sessionId;
    }
  }
  const input = z
    .object({
      companyId: z.string(),
      taskId: z.string().nullable().default(null),
      provider: z.enum(["shell", "claude", "codex"]),
      mode: z
        .enum(["work", "planning", "intake", "suggestions"])
        .default("work"),
      resumeFrom: z.string().optional(),
      accountId: z.string().nullable().optional(),
      gmailAccess: gmailAccess.optional(),
      contextOptions: sessionContextInput.optional(),
      brainIntent: z.enum(["update", "question"]).optional(),
      brainPageId: brainId.optional(),
    })
    .parse(params);
  if (input.mode === "suggestions") {
    if (input.taskId || input.provider === "shell")
      throw new Error(
        "AI-voorstellen gebruiken een bedrijfsgesprek met Claude of Codex.",
      );
    const snap = store.snapshot();
    if (
      !snap.projects.some((p) => p.companyId === input.companyId) ||
      !snap.goals.some((g) => g.companyId === input.companyId)
    )
      throw new Error("Voeg eerst een project en bedrijfsdoel toe.");
    if (
      [...lives.entries()].some(([id, live]) => {
        const s = store.session(id);
        return (
          live.agentRunning &&
          s.companyId === input.companyId &&
          s.mode === "suggestions" &&
          ["starting", "working", "waiting", "unknown"].includes(s.state)
        );
      })
    )
      throw new Error(
        "Er worden al voorstellen voor dit bedrijf gemaakt. Open dat gesprek.",
      );
  }
  const company = store.company(input.companyId),
    task = input.taskId ? store.task(input.taskId) : null;
  if (task && task.companyId !== company.id)
    throw new Error("De taak hoort niet bij dit bedrijf.");
  if (task && task.status === "done")
    throw new Error("Heropen eerst de afgeronde taak.");
  if (task && !availableToday(task))
    throw new Error(
      `Deze taak staat gepland voor ${task.scheduledDate}. Pas de plandatum aan om eerder te starten.`,
    );
  if (
    task &&
    task.dependencies.some((dep) => store.task(dep).status !== "done")
  )
    throw new Error("Rond eerst de afhankelijkheden af.");
  if (task && input.provider !== "shell")
    for (const sid of chats.active.keys())
      if (store.session(sid).taskId === task.id) throw new Error("Er werkt al een agent aan deze taak.");
  if (task && input.provider !== "shell")
    for (const [sid, live] of lives)
      if (store.session(sid).taskId === task.id && live.agentRunning)
        throw new Error("Er werkt al een agent aan deze taak.");
  const project = task
    ? store.snapshot().projects.find((p) => p.id === task.projectId)
    : null;
  const cwd = folder(project?.workspacePath || company.workspacePath);
  let resumeId: string | undefined;
  const account = input.resumeFrom
    ? null
    : preferences.resolve(input.provider, input.companyId, input.accountId);
  let accountId = account?.id || null;
  let accountConfigDir = account?.configDir || "";
  if (input.resumeFrom) {
    const previous = store.session(input.resumeFrom);
    if (
      previous.companyId !== company.id ||
      previous.taskId !== input.taskId ||
      previous.provider !== input.provider
    )
      throw new Error("Hervatten kan alleen binnen dezelfde taak en provider.");
    if (lives.get(previous.id)?.agentRunning)
      throw new Error("Dit gesprek draait nog.");
    if (!previous.providerSessionId)
      throw new Error(
        "Geen gesprek-ID geregistreerd. Start een nieuw gesprek; de taakcontext blijft beschikbaar.",
      );
    resumeId = previous.providerSessionId;
    if (input.accountId && input.accountId !== previous.accountId)
      throw new Error("Hervat het gesprek met het oorspronkelijke account.");
    accountId = previous.accountId || null;
    accountConfigDir = previous.accountConfigDir || "";
    for (const [sid, live] of lives)
      if (
        live.agentRunning &&
        store.session(sid).providerSessionId === resumeId
      )
        throw new Error("Dit gesprek is al actief.");
  }
  const outputDir = cwd;
  const token = randomBytes(32).toString("hex");
  const sessionId = store.createSession({
    ...input,
    cwd,
    outputDir,
    token,
    providerSessionId: resumeId,
    accountId,
    accountConfigDir,
    purpose: authAction || "work",
  });
  const sessionDir = join(dataDir, "sessions", sessionId);
  integrations.sessionAccess(
    sessionId,
    authAction || input.provider === "shell" ? "none" : input.gmailAccess,
    input.resumeFrom,
    !authAction && input.provider !== "shell",
  );
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const config = adapterConfig(
    input.provider,
    runtimeDir,
    process.execPath,
    resumeId,
  );
  let argv = config.args;
  if (input.provider === "claude" && !authAction) {
    writeFileSync(
      join(sessionDir, "settings.json"),
      JSON.stringify({ hooks: config.hooks }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(sessionDir, "mcp.json"),
      JSON.stringify({ mcpServers: { werk_task_context: config.mcp } }),
      { mode: 0o600 },
    );
    const threadId = resumeId || randomUUID();
    store.setSession(sessionId, { providerSessionId: threadId });
    argv = [
      ...argv,
      ...(!resumeId ? ["--session-id", threadId] : []),
      "--settings",
      join(sessionDir, "settings.json"),
      "--mcp-config",
      join(sessionDir, "mcp.json"),
    ];
  }
  if (authAction) {
    if (!accountConfigDir) throw new Error("Kies eerst een account.");
    mkdirSync(accountConfigDir, { recursive: true, mode: 0o700 });
    argv = authArgs(input.provider, authAction);
  } else if (input.provider !== "shell") {
    const instructions = benchdeskInstructions(input.mode);
    if (input.provider === "claude") {
      const instructionFile = join(sessionDir, "benchdesk-instructions.md");
      writeFileSync(instructionFile, instructions, { mode: 0o600 });
      argv.push("--append-system-prompt-file", instructionFile);
    } else {
      argv.push("-c", `developer_instructions=${toml(instructions)}`);
      if (task?.model) argv.push("-c", `model=${toml(task.model)}`);
    }
    argv.push(promptFor(input.mode, task?.title) + (input.brainIntent === "update" ? " Werk het bedrijfsbrein bij: verwerk beschikbare bronnen in begrensde batches met list_brain_pending, read_brain_source en save_brain_changes. Laat de resterende wachtrij staan als het contextbudget op is. Maak geen taken aan." : input.brainPageId ? ` Gebruik wikipagina ${input.brainPageId} als startpunt; lees eerst de sectie-index.` : ""));
  }
  const launchFile = join(sessionDir, "launch.json");
  writeFileSync(
    launchFile,
    JSON.stringify({
      provider: input.provider,
      args: argv,
      accountConfigDir,
      authAction,
    }),
    { mode: 0o600 },
  );
  const shell = process.env.SHELL || "/bin/zsh";
  const shellArgs =
    input.provider === "shell"
      ? ["-il"]
      : [
          "-ilc",
          `ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} ${shellQuote(join(runtimeDir, "launch.cjs"))}; exec ${shellQuote(shell)} -il`,
        ];
  const env = environment({
    WERK_SOCKET: socketPath,
    WERK_SESSION_ID: sessionId,
    WERK_SESSION_TOKEN: token,
    WERK_LAUNCH_FILE: launchFile,
    ...accountEnvironment(input.provider, accountConfigDir),
  });
  try {
    const process = pty.spawn(shell, shellArgs, {
      cwd,
      env,
      cols: 100,
      rows: 30,
      name: "xterm-256color",
    });
    const term = new Terminal({
      cols: 100,
      rows: 30,
      scrollback: 3000,
      allowProposedApi: true,
    });
    const serializer = new SerializeAddon();
    term.loadAddon(serializer);
    const live: Live = {
      process,
      term,
      serializer,
      sequence: 0,
      appliedSequence: 0,
      agentRunning: input.provider !== "shell",
      pending: "",
      cols: 100,
      rows: 30,
    };
    lives.set(sessionId, live);
    process.onData((data) => {
      live.pending += data;
      if (live.pending.length > 32000) flush(sessionId);
      else if (!live.timer) live.timer = setTimeout(() => flush(sessionId), 24);
    });
    process.onExit(async ({ exitCode }) => {
      integrations.endSession(sessionId);
      flush(sessionId);
      await persistScreen(sessionId);
      if (live.timer) clearTimeout(live.timer);
      lives.delete(sessionId);
      term.dispose();
      store.setSession(sessionId, {
        state: exitCode === 0 ? "ended" : "interrupted",
        error: exitCode === 0 ? "" : `Gesprek beëindigd (code ${exitCode}).`,
        tokenHash: "",
      });
      store.event(
        company.id,
        input.taskId,
        sessionId,
        "session_end",
        "Gesprek beëindigd. Taakstatus is behouden.",
      );
      changed();
    });
    if (task) {
      store.patchTask(task.id, { status: "in_progress" });
    }
    store.setSession(sessionId, {
      state: input.provider === "shell" ? "idle" : "starting",
    });
    store.event(
      company.id,
      input.taskId,
      sessionId,
      "session_start",
      input.provider === "shell"
        ? `Vrij gesprek gestart in ${shortDir(cwd)}.`
        : `${input.provider === "claude" ? "Claude Code" : "Codex"} gestart in ${shortDir(cwd)}.`,
    );
    changed();
    return sessionId;
  } catch (e) {
    store.setSession(sessionId, {
      state: "error",
      error: (e as Error).message,
      tokenHash: "",
    });
    throw e;
  }
}
async function agentMethod(sessionId: string, method: string, params: any) {
  const live = lives.get(sessionId);
  if (!live && !chats.active.has(sessionId)) throw new Error("Sessie is niet meer actief.");
  if (method === "hook") {
    const outcome = store.hook(sessionId, params);
    if (outcome?.contextTurn) brain.reset(sessionId, outcome.contextTurn);
    if (
      params.name === "Stop" &&
      live?.pendingFeedback &&
      store.session(sessionId).state === "idle"
    ) {
      const message = live.pendingFeedback;
      live.pendingFeedback = undefined;
      live.process.write(
        `\x1b[200~${message.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")}\x1b[201~\r`,
      );
    }
    changed();
    return { ok: true, ...outcome };
  }
  if (method === "launch.start" && live) {
    live.agentRunning = true;
    store.setSession(sessionId, { state: "unknown" });
    changed();
    return { ok: true };
  }
  if (method === "launch.end" && live) {
    live.agentRunning = false;
    store.setSession(sessionId, {
      state: params.error ? "error" : "idle",
      error: String(params.error || "").slice(0, 2000),
    });
    await persistScreen(sessionId);
    const session = store.session(sessionId);
    if (session.accountId && session.purpose !== "work") {
      const account = preferences.value.accounts.find(
        (a) => a.id === session.accountId,
      );
      if (account) {
        const result = await inspectAccount(account);
        preferences.setStatus(account.id, result.status, result.email);
      }
    }
    changed();
    return { ok: true };
  }
  // Tools of connected providers with their own MCP server, listed by werk_task_context.
  if (method === "remote_tools") {
    const session = store.session(sessionId);
    return integrations.remoteTools(session.companyId, sessionId, (provider) =>
      chats.permitsIntegration(sessionId, provider),
    );
  }
  if (method === "tool")
    return chats.gateway.run(
      sessionId,
      { source: "werk", tool: String(params.name), input: params.arguments || {} },
      () => dispatchTool(sessionId, params),
    );
  throw new Error("Deze functie is niet beschikbaar voor agents.");
}
async function dispatchTool(sessionId: string, params: any) {
  if ((agentToolNames as readonly string[]).includes(params.name)) return chats.agentTool(sessionId, params.name, params.arguments || {});
  if (params.name === "get_task_context" || Object.hasOwn(brainTools, String(params.name))) {
    const result = await brain.tool(sessionId, String(params.name), params.arguments || {});
    if (["save_brain_changes", "patch_session_memory"].includes(params.name)) changed();
    if (params.name !== "get_task_context") return result;
    const session = store.session(sessionId);
    return {
      ...result,
      integrations: {
        gmail: chats.permitsIntegration(sessionId, "gmail") ? integrations.available(session.companyId, sessionId) : [],
        external: integrations.externalAvailable(session.companyId, sessionId).filter(i => chats.permitsIntegration(sessionId, i.provider)),
      },
    };
  }
  if (
    /^(gmail_|fireflies_|pocket_|unipile_|github_|blotato_)/.test(
      String(params.name),
    )
  ) {
    const session = store.session(sessionId);
    if (!chats.permitsIntegration(sessionId, String(params.name).split("_")[0])) throw new Error("Deze koppeling is niet toegestaan voor deze agent.");
    return integrations.tool(
      session.companyId,
      sessionId,
      String(params.name),
      params.arguments || {},
    );
  }
  const result = store.agentCall(
    sessionId,
    String(params.name),
    params.arguments || {},
  );
  if (["report_progress", "submit_result"].includes(params.name)) brain.sync(store.session(sessionId).companyId);
  changed();
  if (params.name === "save_session_memory") {
    brain.sync(store.session(sessionId).companyId);
    const memory = store.session(sessionId).memory!;
    return { revision: memory.revision, updatedAt: memory.updatedAt };
  }
  return result;
}
async function appMethod(method: string, params: any, socket: net.Socket) {
  if (method === "ping") return { version: 17, pid: process.pid };
  if ((agentMethods as readonly string[]).includes(method)) return chats.app(method, params);
  if (method === "integrations.unlock") {
    integrations.vault.unlock(z.string().parse(params.key));
    jev.vault.unlock(z.string().parse(params.key));
    return { ok: true };
  }
  if (method.startsWith("brain.") || method.startsWith("typesafe.")) {
    const companyId = z.string().uuid().parse(params.companyId);
    store.company(companyId);
    if (method === "typesafe.status") return jev.status(companyId);
    if (method === "typesafe.configure") return jev.configure(companyId, params.apiKey);
    if (method === "typesafe.remove") { jev.remove(companyId); return { ok: true }; }
    if (method === "typesafe.test") return jev.test(companyId);
    brain.sync(companyId);
    if (method === "brain.overview") return store.brain.overview(companyId);
    if (method === "brain.page") return store.brain.page(companyId, brainId.parse(params.pageId), params.revision === undefined ? undefined : z.number().int().positive().parse(params.revision));
    if (method === "brain.source") return store.brain.source(companyId, brainId.parse(params.sourceId));
    if (method === "brain.source.draft") return store.brain.sourceDraft(companyId, brainId.parse(params.sourceId));
    if (method === "brain.source.decide") return store.brain.decideSource(companyId, brainId.parse(params.sourceId), z.enum(["accept", "dismiss"]).parse(params.action), params.title, params.body);
    if (method === "brain.search") return brain.search(companyId, z.string().trim().min(1).max(500).parse(params.query));
    if (method === "brain.suggestion.decide") return store.brain.decideSuggestion(companyId, brainId.parse(params.suggestionId), z.enum(["accept", "dismiss"]).parse(params.action), z.record(z.string().trim().min(1).max(6000)).default({}).parse(params.edits));
    if (method === "brain.correct") return store.brain.correct(companyId, brainId.parse(params.pageId), brainId.parse(params.sectionId), z.number().int().positive().parse(params.expectedRevision), z.string().trim().min(1).max(6000).parse(params.body));
    throw new Error("Onbekende wiki-opdracht.");
  }
  if (method === "integrations.get") return integrations.overview();
  if (method === "integrations.configure") {
    integrations.configure(params);
    return { ok: true };
  }
  if (method === "integrations.connect") {
    const input = gmailConnect.parse(params);
    store.company(input.companyId);
    return integrations.begin(input);
  }
  if (method === "integrations.cancel") {
    integrations.cancel();
    return { ok: true };
  }
  if (method === "integrations.links") {
    const links = z.array(gmailLink).parse(params.links);
    for (const link of links) store.company(link.companyId);
    integrations.links(z.string().uuid().parse(params.id), links);
    return { ok: true };
  }
  if (method === "integrations.remove") {
    integrations.remove(z.string().uuid().parse(params.id));
    return { ok: true };
  }
  if (method === "integrations.session") {
    const session = store.session(params.id);
    if (
      (!lives.has(session.id) && session.transport !== "chat") ||
      session.purpose !== "work" ||
      session.provider === "shell"
    )
      throw new Error("Dit gesprek kan geen Gmail-toegang krijgen.");
    integrations.sessionAccess(session.id, gmailAccess.parse(params.access));
    return { ok: true };
  }
  if (method.startsWith("integrations.provider."))
    store.company(z.string().uuid().parse(params.companyId));
  if (method === "integrations.provider.configure")
    return integrations.configureExternal(params);
  if (method === "integrations.provider.test")
    return integrations.testExternal(params.companyId, params.provider);
  if (method === "integrations.provider.remove") {
    integrations.removeExternal(params.companyId, params.provider);
    return { ok: true };
  }
  if (method === "subscribe") {
    clients.add(socket);
    return { ok: true };
  }
  if (method === "snapshot") return snapshot();
  if (method === "session.memory.save")
    return store.saveSessionMemory(
      params.id,
      params.value,
      params.expectedRevision,
      "user",
    );
  if (method === "company.save")
    return store.saveCompany(params.value, params.id);
  if (method === "department.save")
    return store.saveDepartment(params.value, params.id);
  if (method === "department.remove") return store.removeDepartment(params.id);
  if (method === "project.save")
    return store.saveProject(params.value, params.id);
  if (method === "goal.save") return store.saveGoal(params.value, params.id);
  if (method === "task.save") return store.saveTask(params.value, params.id);
  if (method === "task.history") return store.taskHistory(params.id);
  if (method === "task.patch") return store.patchTask(params.id, params.patch);
  if (method === "task.remove") {
    const task = store.task(params.id);
    if (
      [...lives.keys(), ...chats.active.keys()].some(
        (sessionId) => store.session(sessionId).taskId === task.id,
      )
    )
      throw new Error("Stop eerst het actieve gesprek van deze taak.");
    return store.removeTask(task.id);
  }
  if (method === "task.criterion")
    return store.reviewCriterion(params.id, params.criterionId, params.patch);
  if (method === "task.reorder")
    return store.reorderTasks(params.projectId, params.taskIds);
  if (method === "task.submit") {
    const task = store.task(params.id);
    if (task.status === "done") throw new Error("Heropen eerst de taak.");
    store.patchTask(task.id, { status: "review" });
    store.event(
      task.companyId,
      task.id,
      null,
      "result",
      "Door jou ingediend ter beoordeling.",
    );
    return;
  }
  if (method === "task.return") {
    const message = store.returnTask(params.id);
    const chat = store.snapshot().sessions.filter(s => s.taskId === params.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (chat?.transport === "chat" && chat.conversationId) return chats.feedback(chat.conversationId, message);
    const active = [...lives.entries()].find(
      ([sid, live]) =>
        live.agentRunning && store.session(sid).taskId === params.id,
    );
    if (active) {
      const [sid, live] = active;
      if (store.session(sid).state === "idle")
        live.process.write(
          `\x1b[200~${message.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")}\x1b[201~\r`,
        );
      else live.pendingFeedback = message;
      return { sessionId: sid, queued: store.session(sid).state !== "idle" };
    }
    return { sessionId: null, queued: false };
  }
  if (method === "task.complete")
    return store.completeTask(
      params.id,
      z
        .string()
        .max(30000)
        .parse(params.note || ""),
    );
  if (method === "task.move") {
    const a = store.task(params.id),
      b = store.task(params.otherId);
    if (a.companyId !== b.companyId)
      throw new Error("Taken horen niet bij hetzelfde bedrijf.");
    store.sql.transaction(() => {
      store.sql.prepare("UPDATE tasks SET rank=? WHERE id=?").run(b.rank, a.id);
      store.sql.prepare("UPDATE tasks SET rank=? WHERE id=?").run(a.rank, b.id);
      store.bump(a.companyId);
    })();
    return;
  }
  if (method === "checkin.save")
    return store.checkin(params.companyId, params.note, params.values || []);
  if (method === "artifact.add")
    return store.addArtifact(params.taskId, params.path);
  if (method === "proposal.decide")
    return store.decideProposal(params.id, params.accept === true);
  if (method === "suggestion.decide")
    return store.decideSuggestion(params.id, params.index, params.accept);
  if (method === "proposal.item")
    return store.decidePriorityItem(
      params.id,
      params.taskId,
      params.accept === true,
    );
  if (method === "preferences.get") return preferences.value;
  if (method === "profile.save") return preferences.profile(params.value);
  if (method === "account.save") {
    for (const id of params.value.companyIds || []) store.company(id);
    return preferences.save(params.value, params.id);
  }
  if (method === "account.remove") {
    if (
      [...lives.keys(), ...chats.active.keys()].some(
        (sid) => store.session(sid).accountId === params.id,
      )
    )
      throw new Error(
        "Stop eerst de gesprekken van dit account voordat je het verwijdert.",
      );
    preferences.remove(params.id);
    return;
  }
  if (method === "accounts.refresh") {
    const accounts = params.id
      ? [preferences.account(params.id)]
      : preferences.value.accounts;
    await Promise.all(
      accounts.map(async (account) => {
        const result = await inspectAccount(account);
        preferences.setStatus(account.id, result.status, result.email);
      }),
    );
    return preferences.value;
  }
  if (method === "account.login" || method === "account.logout") {
    const account = preferences.account(params.id);
    if (
      method === "account.logout" &&
      [...lives.keys(), ...chats.active.keys()].some(
        (sid) => store.session(sid).accountId === account.id,
      )
    )
      throw new Error(
        "Stop eerst de gesprekken van dit account voordat je uitlogt.",
      );
    return startSession(
      {
        companyId: params.companyId,
        provider: account.provider,
        accountId: account.id,
      },
      method === "account.login" ? "login" : "logout",
    );
  }
  if (method === "session.link") {
    const session = store.session(params.id),
      task = store.task(params.taskId);
    if (
      session.taskId ||
      session.provider !== "shell" ||
      session.companyId !== task.companyId
    )
      throw new Error(
        "Koppelen kan alleen bij een vrij gesprek van hetzelfde bedrijf.",
      );
    store.setSession(session.id, { taskId: task.id });
    return;
  }
  if (method === "session.start") return startSession(params);
  if (method === "session.message") {
    const chat = store.session(params.id);
    if (chat.conversationId) return chats.send({ id: chat.conversationId, message: params.message, clientMessageId: randomUUID() });
    const message = z
      .string()
      .trim()
      .min(1)
      .max(30000)
      .parse(params.message)
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
    const session = store.session(params.id),
      live = lives.get(session.id);
    if (!live?.agentRunning || session.provider === "shell")
      throw new Error("Hervat eerst het agentgesprek.");
    if (session.state === "idle")
      live.process.write(`\x1b[200~${message}\x1b[201~\r`);
    else
      live.pendingFeedback = [live.pendingFeedback, message]
        .filter(Boolean)
        .join("\n\n");
    return { queued: session.state !== "idle" };
  }
  if (method === "session.screen") {
    z.string().uuid().parse(params.id);
    return screen(params.id);
  }
  if (method === "session.write") {
    const p = z
      .object({ id: z.string().uuid(), data: z.string().max(100000) })
      .parse(params);
    const live = lives.get(p.id);
    if (!live) throw new Error("Dit gesprek is beëindigd.");
    live.process.write(p.data);
    return;
  }
  if (method === "session.resize") {
    const p = z
      .object({
        id: z.string().uuid(),
        cols: z.number().int().min(2).max(500),
        rows: z.number().int().min(2).max(200),
      })
      .parse(params);
    const live = lives.get(p.id);
    if (live) {
      live.cols = p.cols;
      live.rows = p.rows;
      live.process.resize(p.cols, p.rows);
      live.term.resize(p.cols, p.rows);
    }
    return;
  }
  if (method === "session.stop") {
    if (store.session(params.id).transport === "chat") { await chats.interrupt(params.id); return; }
    integrations.endSession(params.id);
    const live = lives.get(params.id);
    if (live) {
      flush(params.id);
      await persistScreen(params.id);
      live.process.kill();
    }
    return;
  }
  if (method === "inventory") {
    const c = params.companyId ? store.company(params.companyId) : null;
    return inventory(
      folder(params.cwd || c?.workspacePath || homedir()),
      runtimeDir,
    );
  }
  if (method === "backup.export") return store.export();
  if (method === "backup.restore") {
    if (lives.size || chats.active.size)
      throw new Error(
        "Sluit eerst de open gesprekken voordat je een back-up herstelt.",
      );
    const before = join(dataDir, `before-restore-${Date.now()}.json`);
    writeFileSync(before, JSON.stringify(store.export()), { mode: 0o600 });
    store.restore(params.backup);
    return { ok: true };
  }
  if (method === "shutdown") {
    if (lives.size || chats.active.size) throw new Error("Er zijn nog actieve gesprekken.");
    setTimeout(() => shutdown(), 100);
    return { ok: true };
  }
  throw new Error("Onbekende opdracht.");
}
const server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  let buffer = "";
  let queue = Promise.resolve();
  socket.on("data", (data: string) => {
    buffer += data;
    if (buffer.length > MAX_SOCKET_BUFFER) {
      socket.destroy();
      return;
    }
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      queue = queue.then(async () => {
        let msg: any;
        try {
          msg = JSON.parse(line);
          if (typeof msg.id !== "string")
            throw new Error("Ongeldige aanvraag.");
          let result;
          if (msg.channel === "app" && msg.token === controlToken) {
            result = await appMethod(msg.method, msg.params || {}, socket);
            // The mutation already succeeded; a wiki sync failure must not report
            // it as failed or skip the change broadcast. The next sync retries.
            try {
              brain.captureMutation(msg.method, msg.params || {}, result);
            } catch (e) {
              survive("brain.capture", e);
            }
            if (
              ![
                "snapshot",
                "chat.read",
                "agent.search",
                "agent.routine.list",
                "brain.overview", "brain.page", "brain.source", "brain.source.draft", "brain.search", "typesafe.status", "typesafe.test",
                "task.history",
                "session.screen",
                "session.resize",
                "session.write",
                "inventory",
                "subscribe",
                "ping",
                "backup.export",
                "preferences.get",
                "integrations.get",
                "integrations.unlock",
              ].includes(msg.method)
            )
              changed();
          } else if (msg.channel === "agent") {
            store.authenticate(msg.sessionId, msg.token);
            result = await agentMethod(
              msg.sessionId,
              msg.method,
              msg.params || {},
            );
          } else throw new Error("Toegang geweigerd.");
          send(socket, { id: msg.id, result: result ?? null });
        } catch (e) {
          send(socket, { id: msg?.id, error: (e as Error).message });
        }
      });
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => clients.delete(socket));
});
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (chats) await Promise.all([...chats.active.keys()].map(id => chats.interrupt(id)));
  integrations.close();
  clearInterval(timer);
  for (const sid of lives.keys()) await persistScreen(sid);
  for (const live of lives.values()) live.process.kill();
  for (const c of clients) c.destroy();
  server.close();
  setTimeout(() => {
    store?.close();
    try {
      unlinkSync(socketPath);
    } catch {}
    process.exit(0);
  }, 300);
}
const timer = setInterval(() => {
  if (chats && !shuttingDown) chats.tickRoutines();
  if (store && store.refreshRecurringTasks()) changed();
  for (const sid of lives.keys()) void persistScreen(sid);
}, 8000);
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
// The runner owns every live terminal, so one stray error must not take them all down. On 23 Oct
// 2026 it died on an AbortError that claude-agent-sdk threw from ProcessTransport.write after a turn
// had been aborted; nothing awaited that call, so no try/catch here could catch it. Expected aborts
// get one line in service.log, anything else the full error, and the runner keeps serving.
function survive(kind: string, error: unknown) {
  const aborted =
    error instanceof Error &&
    (error.name === "AbortError" || error.constructor?.name === "AbortError");
  if (aborted)
    console.error(`${new Date().toISOString()} ${kind} ignored: ${error.message}`);
  else console.error(`${new Date().toISOString()} ${kind}:`, error);
}
process.on("unhandledRejection", (error) => survive("unhandledRejection", error));
process.on("uncaughtException", (error) => survive("uncaughtException", error));
async function boot() {
  if (existsSync(socketPath)) {
    const active = await new Promise<boolean>((resolve) => {
      const probe = net.createConnection(socketPath);
      probe.once("connect", () => {
        probe.destroy();
        resolve(true);
      });
      probe.once("error", () => resolve(false));
    });
    if (active) {
      clearInterval(timer);
      process.exit(0);
    }
    unlinkSync(socketPath);
  }
  store = new Store(join(dataDir, "werk.sqlite"));
  preferences = new PreferenceStore(join(dataDir, "preferences.json"));
  brain = new BrainService(store, jev);
  chats = new ChatService({
    store, preferences, runtimeDir, socketPath, environment, broadcast,
    taskActive: (taskId, except) => [...lives.keys(), ...chats.active.keys()].some(id => id !== except && store.session(id).taskId === taskId && (lives.get(id)?.agentRunning || chats.active.has(id))),
    resetContext: (sessionId, turnId) => brain.reset(sessionId, turnId),
    sessionAccess: (sessionId, access) => { integrations.sessionAccess(sessionId, access, undefined, true); },
    endAccess: (sessionId) => { integrations.endSession(sessionId); },
  });
  store.recover();
  store.agents.pruneAudit();
  chats.resetRoutineClock();
  // A runner that cannot listen is useless: exit so the app can start a new one, instead of
  // lingering behind the uncaughtException guard above. Once listening, log and keep serving.
  server.on("error", (error) => {
    if (server.listening) return survive("server error", error);
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
  server.listen(socketPath, () => {
    chmodSync(socketPath, 0o600);
    writeFileSync(join(dataDir, "runner.pid"), String(process.pid), {
      mode: 0o600,
    });
  });
}
boot().catch((e) => {
  process.stderr.write(e.message + "\n");
  process.exit(1);
});
