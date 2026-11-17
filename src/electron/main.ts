import { t as tr, getLanguage, setLanguage } from "../shared/i18n";
import { agentMethods } from "../shared/agents";
import { DesktopComputer } from "./computer";
import { clipboardFiles } from "./clipboard-files";
import { TerminalColors } from "../core/terminal-colors";
import { interactiveEnvironment } from "../runtime/terminal-env";
import { SessionFiles } from "../core/session-files";
import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Menu,
  nativeTheme,
  type IpcMainInvokeEvent,
} from "electron";
import { join, dirname, extname, basename } from "node:path";
import { pathToFileURL } from "node:url";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  statSync,
  renameSync,
  realpathSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { RpcClient } from "../runtime/rpc";
import {
  prepareRunner,
  ActiveRunnerUpgrade,
  type UpgradeSession,
} from "../runtime/upgrade";
import { UsageService } from "../runtime/usage";
import type { Preferences } from "../shared/types";
import type { Snapshot } from "../shared/types";
import type { ScheduleOverview } from "../shared/schedules";
import { brainAppMethods } from "../shared/brain-methods";
import { inspectSchedules } from "../runtime/schedules";
import { integrationKey } from "./integration-key";
let window: BrowserWindow | null = null,
  client: RpcClient | null = null,
  connecting: Promise<RpcClient> | null = null,
  quitting = false,
  // Every pane asks for its files every few seconds; they share one snapshot instead of one each.
  filesSnapshot: { at: number; value: Promise<Snapshot> } | null = null;
const usageService = new UsageService();
const terminalColors = new TerminalColors();
const sessionFiles = new SessionFiles();
const root = join(__dirname, ".."),
  index = join(root, "ui", "index.html");
app.setName("Benchdesk");
// Keep the existing profile and runner socket when changing the display name.
// Live terminals and saved work must not move into a new, empty profile.
app.setPath(
  "userData",
  process.env.WERK_DATA_DIR || join(app.getPath("appData"), "Werk"),
);
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  const dataDir = app.getPath("userData");
  const languagePath = join(dataDir, "ui-language.json");
  try {
    const saved = JSON.parse(readFileSync(languagePath, "utf8"));
    if (saved.language === "en" || saved.language === "nl")
      setLanguage(saved.language);
  } catch {
    /* A new installation starts in Dutch. */
  }
  // The renderer keeps its theme in localStorage, which the main process cannot read before the window
  // exists. Mirror it like the language, so the window paints the right background before any css loads.
  const themePath = join(dataDir, "ui-theme.json");
  // Rustig --bg per theme (src/ui/rustig/tokens.css).
  const windowBackground = { light: "#ffffff", dark: "#212121" };
  let storedTheme: "light" | "dark" | null = null;
  try {
    const saved = JSON.parse(readFileSync(themePath, "utf8"));
    if (saved.theme === "light" || saved.theme === "dark")
      storedTheme = saved.theme;
  } catch {
    /* First start: follow the system appearance. */
  }
  // Codex probes OSC 10/11 as soon as its TUI starts. Initialise the responder
  // from the persisted app theme before any session output can arrive; otherwise
  // a dark Benchdesk window can receive Codex's light composer colours until the
  // renderer has finished sending terminal.theme.
  terminalColors.theme =
    storedTheme ?? (nativeTheme.shouldUseDarkColors ? "dark" : "light");
  let scheduleScan: Promise<ScheduleOverview> | null = null;
  let upgradeSessions: UpgradeSession[] | null = null;
  function trusted(event: IpcMainInvokeEvent) {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame?.url.split("#")[0] !== pathToFileURL(index).href
    )
      throw new Error(tr("Ongeldige aanvraagbron."));
  }
  async function connect(): Promise<RpcClient> {
    if (client && !client.socket.destroyed) return client;
    if (connecting) return connecting;
    connecting = (async () => {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const socketPath = join(dataDir, "runner.sock"),
        tokenPath = join(dataDir, "control-token");
      const attempt = async () => {
        if (!existsSync(tokenPath)) throw new Error(tr("Nog niet gestart"));
        const c = new RpcClient(socketPath, {
          channel: "app",
          token: readFileSync(tokenPath, "utf8"),
        });
        try {
          await prepareRunner(c);
          upgradeSessions = null;
          await c.call("subscribe");
          c.on("event", (event) => {
            if (event.type === "terminal") {
              const reply = terminalColors.push(event.sessionId, event.data);
              if (reply)
                void c
                  .call("session.write", { id: event.sessionId, data: reply })
                  .catch(() => {});
            }
            if (window && !window.isDestroyed())
              window.webContents.send("werk:event", event);
          });
          // The runner drops a client whose replies back up (runner.ts send()). Reconnect right away instead
          // of on the next call, and tell the renderer so the panes fetch their screen again.
          c.once("disconnected", () => {
            if (client === c) client = null;
            if (quitting) return;
            setTimeout(() => {
              if (quitting || client) return;
              void connect()
                .then(() => {
                  if (window && !window.isDestroyed())
                    window.webContents.send("werk:event", {
                      type: "reconnected",
                    });
                })
                .catch(() => {});
            }, 250);
          });
          client = c;
          return c;
        } catch (e) {
          c.close();
          throw e;
        }
      };
      try {
        return await attempt();
      } catch (e) {
        if (e instanceof ActiveRunnerUpgrade) {
          upgradeSessions = e.sessions;
          throw e;
        }
      }
      const log = openSync(join(dataDir, "service.log"), "a", 0o600);
      const runner = spawn(
        process.execPath,
        [join(root, "runtime", "runner.cjs")],
        {
          detached: true,
          stdio: ["ignore", log, log],
          env: {
            ...interactiveEnvironment(process.env),
            ELECTRON_RUN_AS_NODE: "1",
            WERK_DATA_DIR: dataDir,
          },
        },
      );
      runner.unref();
      closeSync(log);
      for (let i = 0; i < 35; i++) {
        await new Promise((r) => setTimeout(r, 150));
        try {
          return await attempt();
        } catch {}
      }
      throw new Error(
        `De achtergrondservice start niet. Bekijk ${join(dataDir, "service.log")}.`,
      );
    })().finally(() => {
      connecting = null;
    });
    return connecting;
  }
  // The window, its panes and the file checks each ask for the full snapshot (several MB). Requests
  // that overlap share one runner call, so replies no longer pile up on the connection. A change
  // sent after that call started bumps the generation and forces a fresh snapshot: the runner
  // handles one connection's requests in order, so that one includes the change.
  const readOnlyMethods = new Set([
    "snapshot",
    "chat.read",
    "agent.search",
    "agent.routine.list",
    "brain.overview",
    "brain.page",
    "brain.source",
    "brain.source.draft",
    "brain.search",
    "typesafe.status",
    "typesafe.test",
    "task.history",
    "session.screen",
    "session.resize",
    "session.write",
    "session.files",
    "inventory",
    "preferences.get",
    "integrations.get",
    "accounts.usage",
    "app.info",
    "app.language",
    "runtime.status",
    "schedules.get",
    "schedules.scan",
    "terminal.theme",
  ]);
  let generation = 0,
    snapshotCall: { generation: number; value: Promise<Snapshot> } | null =
      null;
  function snapshot(): Promise<Snapshot> {
    if (snapshotCall?.generation === generation) return snapshotCall.value;
    const call = {
      generation,
      value: connect().then((c) => c.call<Snapshot>("snapshot")),
    };
    snapshotCall = call;
    const done = () => {
      if (snapshotCall === call) snapshotCall = null;
    };
    call.value.then(done, done);
    return call.value;
  }
  async function unlockOptionalVaults(runtime: RpcClient, vaults: string[]) {
    if (!vaults.some((name) => existsSync(join(dataDir, name)))) return;
    try {
      await runtime.call("integrations.unlock", {
        key: integrationKey(dataDir),
      });
    } catch (error) {
      // Secure storage enriches conversations with Gmail/TypeSafe, but a
      // temporarily unavailable keychain must never block the core flow.
      console.warn(
        "Optionele beveiligde opslag is niet beschikbaar; de kernflow gaat door:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  const computer = new DesktopComputer(dataDir, connect);
  const allowed = new Set([
    ...agentMethods,
    ...brainAppMethods,
    "typesafe.status",
    "typesafe.configure",
    "typesafe.remove",
    "typesafe.test",
    "snapshot",
    "company.save",
    "project.save",
    "department.save",
    "department.remove",
    "goal.save",
    "task.save",
    "task.history",
    "task.patch",
    "task.remove",
    "task.complete",
    "task.move",
    "checkin.save",
    "artifact.add",
    "proposal.decide",
    "session.start",
    "session.screen",
    "session.write",
    "session.resize",
    "session.stop",
    "inventory",
    "task.criterion",
    "task.reorder",
    "task.submit",
    "task.return",
    "proposal.item",
    "suggestion.decide",
    "preferences.get",
    "profile.save",
    "account.save",
    "account.remove",
    "accounts.refresh",
    "account.login",
    "account.logout",
    "session.link",
    "session.message",
    "session.memory.save",
  ]);
  ipcMain.handle("werk:call", async (event, method, params) => {
    trusted(event);
    if (!readOnlyMethods.has(method)) generation++;
    if (method === "app.language") {
      if (params?.language !== "en" && params?.language !== "nl")
        throw new Error("Invalid interface language.");
      if (getLanguage() !== params.language || !existsSync(languagePath)) {
        mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        writeFileSync(
          languagePath + ".tmp",
          JSON.stringify({ language: params.language }),
          { mode: 0o600 },
        );
        renameSync(languagePath + ".tmp", languagePath);
        setLanguage(params.language);
        setApplicationMenu();
      }
      return;
    }
    if (typeof method === "string" && method.startsWith("computer."))
      return computer.ui(method, params);
    if (
      [
        "typesafe.status",
        "typesafe.configure",
        "typesafe.remove",
        "typesafe.test",
        "integrations.get",
        "integrations.configure",
        "integrations.connect",
        "integrations.cancel",
        "integrations.links",
        "integrations.remove",
        "integrations.session",
        "integrations.provider.configure",
        "integrations.provider.test",
        "integrations.provider.remove",
      ].includes(method)
    ) {
      const runtime = await connect();
      await runtime.call("integrations.unlock", {
        key: integrationKey(dataDir),
      });
      const result = await runtime.call<any>(method, params);
      if (method === "integrations.connect") {
        const url = new URL(result.url);
        if (
          url.origin !== "https://accounts.google.com" ||
          url.pathname !== "/o/oauth2/v2/auth"
        )
          throw new Error(tr("Ongeldige Google-inloglink."));
        try {
          await shell.openExternal(url.href);
        } catch {
          await runtime.call("integrations.cancel");
          throw new Error(
            tr("De browser kon niet worden geopend. Probeer opnieuw."),
          );
        }
        return { id: result.id };
      }
      return result;
    }
    if (["session.start", "chat.start", "chat.send", "brain.search"].includes(method)) {
      const runtime = await connect();
      await unlockOptionalVaults(
        runtime,
        method !== "brain.search"
          ? ["integrations.vault"]
          : ["integrations.vault", "typesafe.vault"],
      );
    }
    if (method === "accounts.usage") {
      const prefs = await (
        await connect()
      ).call<Preferences>("preferences.get");
      const account = prefs.accounts.find((a) => a.id === params?.id);
      if (!account) throw new Error(tr("Account niet gevonden."));
      usageService.prune(prefs.accounts);
      return usageService.read(account, params?.force === true);
    }
    if (method === "runtime.status") return { upgradeSessions };
    if (method === "runtime.stopLegacy") {
      if (!upgradeSessions?.some((s) => s.id === params?.id))
        throw new Error(tr("Dit gesprek is niet beschikbaar."));
      const legacy = new RpcClient(join(dataDir, "runner.sock"), {
        channel: "app",
        token: readFileSync(join(dataDir, "control-token"), "utf8"),
      });
      try {
        return await legacy.call("session.stop", { id: params.id });
      } finally {
        legacy.close();
      }
    }
    if (method === "schedules.get") {
      try {
        const result = JSON.parse(
          readFileSync(join(dataDir, "schedule-overview.json"), "utf8"),
        );
        return Array.isArray(result.jobs) &&
          Array.isArray(result.sources) &&
          typeof result.inspectedAt === "string"
          ? result
          : null;
      } catch {
        return null;
      }
    }
    if (method === "schedules.scan") {
      if (!scheduleScan)
        scheduleScan = (async () => {
          const snap = await snapshot();
          const workspaces = [
            ...new Set(
              [
                ...snap.companies.map((c) => c.workspacePath),
                ...snap.projects.map((p) => p.workspacePath),
              ].filter(Boolean),
            ),
          ];
          const result = await inspectSchedules(workspaces);
          const path = join(dataDir, "schedule-overview.json");
          writeFileSync(path + ".tmp", JSON.stringify(result), { mode: 0o600 });
          renameSync(path + ".tmp", path);
          return result;
        })().finally(() => {
          scheduleScan = null;
        });
      return scheduleScan;
    }
    if (method === "terminal.theme") {
      if (params?.theme !== "light" && params?.theme !== "dark")
        throw new Error(tr("Ongeldig thema voor gesprekken."));
      if (
        params?.preset !== undefined &&
        !["classic", "refined", "compact"].includes(params.preset)
      )
        throw new Error(tr("Ongeldige weergave voor gesprekken."));
      const theme: "light" | "dark" = params.theme;
      terminalColors.theme = theme;
      terminalColors.preset = params.preset || "classic";
      if (storedTheme !== theme || !existsSync(themePath)) {
        mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        writeFileSync(themePath + ".tmp", JSON.stringify({ theme }), {
          mode: 0o600,
        });
        renameSync(themePath + ".tmp", themePath);
        storedTheme = theme;
      }
      window?.setBackgroundColor(windowBackground[theme]);
      return;
    }
    if (method === "session.files") {
      if (!filesSnapshot || Date.now() - filesSnapshot.at > 2000) {
        const value = snapshot();
        filesSnapshot = { at: Date.now(), value };
        value.catch(() => {
          if (filesSnapshot?.value === value) filesSnapshot = null;
        });
      }
      return sessionFiles.list(await filesSnapshot.value, params?.id);
    }
    if (method === "app.info")
      return {
        dataDir,
        defaultWorkspace:
          process.env.WERK_WORKSPACE || join(homedir(), "Documents"),
        version: app.getVersion(),
        homeDir: homedir(),
        platform: process.platform,
      };
    if (!allowed.has(method)) throw new Error(tr("Onbekende opdracht."));
    if (method === "snapshot") return snapshot();
    return (await connect()).call(
      method,
      params,
      method === "inventory" || method === "accounts.refresh" ? 22000 : 15000,
    );
  });
  ipcMain.handle("werk:clipboard-files", async (event) => {
    trusted(event);
    return clipboardFiles();
  });
  ipcMain.handle("werk:folder", async (event) => {
    trusted(event);
    const result = await dialog.showOpenDialog(window!, {
      properties: ["openDirectory"],
      title: tr("Koppel je bestaande werkmap"),
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("werk:files", async (event) => {
    trusted(event);
    const result = await dialog.showOpenDialog(window!, {
      properties: ["openFile", "multiSelections"],
      title: tr("Koppel bestanden"),
    });
    return result.canceled ? [] : result.filePaths;
  });
  async function authorizedPath(path: string) {
    if (typeof path !== "string" || path.length > 8000)
      throw new Error(tr("Ongeldig pad."));
    const snap = await snapshot();
    const paths = [
      ...snap.companies.flatMap((c) => [c.workspacePath, ...c.sources]),
      ...snap.projects.map((p) => p.workspacePath),
      ...snap.artifacts.map((a) => a.path),
      ...snap.sessions.map((s) => s.outputDir),
    ];
    const canonical = (value: string) => {
      if (/^https?:\/\//.test(value)) return value;
      try {
        return realpathSync(value);
      } catch {
        return value;
      }
    };
    if (
      !paths.map(canonical).includes(canonical(path)) &&
      !(await sessionFiles.authorizes(path))
    )
      throw new Error(tr("Koppel dit bestand eerst aan een bedrijf of taak."));
  }
  ipcMain.handle("werk:open", async (event, path: string) => {
    trusted(event);
    await authorizedPath(path);
    if (/^https?:\/\//.test(path)) {
      await shell.openExternal(new URL(path).href);
      return;
    }
    if (statSync(path).isDirectory()) {
      await shell.openPath(path);
      return;
    }
    if (
      ![
        ".pdf",
        ".docx",
        ".xlsx",
        ".pptx",
        ".csv",
        ".txt",
        ".md",
        ".markdown",
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".json",
        ".html",
      ].includes(extname(path).toLowerCase())
    ) {
      shell.showItemInFolder(path);
      return;
    }
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });
  ipcMain.handle("werk:preview", async (event, path: string) => {
    trusted(event);
    await authorizedPath(path);
    const name = basename(path);
    if (/^https?:\/\//.test(path))
      return { kind: "external", content: path, name };
    const stat = statSync(path);
    if (!stat.isFile()) return { kind: "external", content: "", name };
    const ext = extname(path).toLowerCase();
    if (
      [
        ".md",
        ".markdown",
        ".txt",
        ".csv",
        ".json",
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".py",
        ".html",
        ".css",
        ".yaml",
        ".yml",
        ".toml",
        ".sh",
      ].includes(ext)
    ) {
      if (stat.size > 1_000_000)
        return {
          kind: "external",
          content: tr("Dit bestand is te groot voor de voorvertoning."),
          name,
        };
      return { kind: "text", content: readFileSync(path, "utf8"), name };
    }
    if (
      [".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf"].includes(ext) &&
      stat.size < 20_000_000
    ) {
      const mime: Record<string, string> = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".pdf": "application/pdf",
      };
      return {
        kind: ext === ".pdf" ? "pdf" : "image",
        content: `data:${mime[ext]};base64,${readFileSync(path).toString("base64")}`,
        name,
      };
    }
    return {
      kind: "external",
      content: tr("Open dit document in de bijbehorende app."),
      name,
    };
  });
  ipcMain.handle("werk:backup", async (event) => {
    trusted(event);
    const result = await dialog.showSaveDialog(window!, {
      title: tr("Taakgegevens exporteren"),
      defaultPath: `Benchdesk-backup-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: tr("Benchdesk back-up"), extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return null;
    const data = await (await connect()).call("backup.export");
    writeFileSync(result.filePath, JSON.stringify(data, null, 2), {
      mode: 0o600,
    });
    return result.filePath;
  });
  ipcMain.handle("werk:restore", async (event) => {
    trusted(event);
    const selection = await dialog.showOpenDialog(window!, {
      title: tr("Benchdesk-back-up selecteren"),
      properties: ["openFile"],
      filters: [{ name: tr("Benchdesk back-up"), extensions: ["json"] }],
    });
    if (selection.canceled) return false;
    const response = await dialog.showMessageBox(window!, {
      type: "question",
      buttons: [tr("Annuleren"), tr("Herstellen")],
      defaultId: 0,
      cancelId: 0,
      message: tr("Huidige taakgegevens vervangen?"),
      detail: tr(
        "Benchdesk bewaart eerst een kopie van de huidige gegevens. Je bestaande werkbestanden worden niet verplaatst.",
      ),
    });
    if (response.response !== 1) return false;
    generation++;
    const path = selection.filePaths[0];
    if (statSync(path).size > 20_000_000)
      throw new Error(tr("De back-up is te groot."));
    await (
      await connect()
    ).call("backup.restore", {
      backup: JSON.parse(readFileSync(path, "utf8")),
    });
    return true;
  });
  async function createWindow() {
    window = new BrowserWindow({
      show: process.env.WERK_TEST_HIDDEN !== "1",
      width: 1280,
      height: 800,
      minWidth: 1100,
      minHeight: 720,
      title: "Benchdesk",
      backgroundColor:
        windowBackground[
          storedTheme ?? (nativeTheme.shouldUseDarkColors ? "dark" : "light")
        ],
      titleBarStyle: "hiddenInset",
      // Rustig shell: no top bar. The lights line up with the sidebar logo (10 + 8px) inside the 40px mac inset.
      trafficLightPosition: { x: 18, y: 14 },
      webPreferences: {
        preload: join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    window.on("closed", () => {
      window = null;
    });
    await window.loadFile(index);
    await connect().catch(() => {});
  }
  function setApplicationMenu() {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "Benchdesk",
          submenu: [
            { role: "about", label: tr("Over Benchdesk") },
            { type: "separator" },
            { role: "hide", label: tr("Benchdesk verbergen") },
            { role: "hideOthers", label: tr("Andere verbergen") },
            { role: "unhide", label: tr("Alles tonen") },
            { type: "separator" },
            { role: "quit", label: tr("Benchdesk afsluiten") },
          ],
        },
        {
          label: tr("Bewerken"),
          submenu: [
            { role: "undo", label: tr("Ongedaan maken") },
            { role: "redo", label: tr("Opnieuw uitvoeren") },
            { type: "separator" },
            { role: "cut", label: tr("Knippen") },
            { role: "copy", label: tr("Kopiëren") },
            { role: "paste", label: tr("Plakken") },
            { role: "selectAll", label: tr("Alles selecteren") },
          ],
        },
        {
          label: tr("Venster"),
          submenu: [
            { role: "minimize", label: tr("Minimaliseren") },
            { role: "zoom", label: tr("Zoomen") },
            { type: "separator" },
            { role: "front", label: tr("Alles naar voren") },
            { role: "reload", label: tr("Opnieuw laden") },
          ],
        },
      ]),
    );
  }
  app.whenReady().then(() => {
    setApplicationMenu();
    void computer
      .start()
      .catch((e) =>
        console.error("Computerbediening niet gestart:", e.message),
      );
    void createWindow();
    app.on("activate", () => {
      if (!window) void createWindow();
      else window.show();
    });
  });
  app.on("window-all-closed", () => {});
  app.on("before-quit", () => {
    quitting = true;
    computer.close();
    client?.close();
  });
}
