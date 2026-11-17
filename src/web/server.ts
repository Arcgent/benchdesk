import { TerminalColors } from "../core/terminal-colors";
import { agentMethods } from "../shared/agents";
import { interactiveEnvironment } from "../runtime/terminal-env";
import { SessionFiles } from "../core/session-files";
import http, { type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  realpathSync,
  statSync,
  createReadStream,
} from "node:fs";
import { join, resolve, extname, basename, sep } from "node:path";
import { homedir } from "node:os";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { RpcClient } from "../runtime/rpc";
import {
  prepareRunner,
  ActiveRunnerUpgrade,
  type UpgradeSession,
} from "../runtime/upgrade";
import { inspectSchedules } from "../runtime/schedules";
import { seedPreview } from "./seed";
import { UsageService } from "../runtime/usage";
import type { Preferences } from "../shared/types";
import type { Snapshot } from "../shared/types";
import { brainAppMethods } from "../shared/brain-methods";

const usageService = new UsageService();
const terminalColors = new TerminalColors();
const sessionFiles = new SessionFiles();
const port = Number(process.env.WERK_WEB_PORT || 5173);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Ongeldige localhost-poort.");
const preview = process.env.WERK_WEB_PREVIEW !== "0";
const dataDir =
  process.env.WERK_DATA_DIR ||
  join(
    homedir(),
    "Library",
    "Application Support",
    preview ? "Werk-browser-preview" : "Werk",
  );
const uiRoot = resolve(__dirname, "../ui");
const runtimeDir = resolve(__dirname, "../runtime");
const socketPath = join(dataDir, "runner.sock"),
  tokenPath = join(dataDir, "control-token");
const cookie = randomBytes(32).toString("hex");
const cookieName = `werk_local_${port}`;
const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
const origins = new Set([...hosts].map((host) => `http://${host}`));
const streams = new Set<ServerResponse>();
let client: RpcClient | null = null,
  connecting: Promise<RpcClient> | null = null;
let upgradeSessions: UpgradeSession[] | null = null;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const run = promisify(execFile);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });

async function connect(): Promise<RpcClient> {
  if (client && !client.socket.destroyed) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    const attempt = async () => {
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
          for (const stream of streams) {
            if (stream.writableLength > 4_000_000) {
              stream.end();
              streams.delete(stream);
            } else stream.write(`data: ${JSON.stringify(event)}\n\n`);
          }
        });
        c.on("disconnected", () => {
          for (const stream of streams) stream.end();
          streams.clear();
        });
        client = c;
        return c;
      } catch (e) {
        c.close();
        throw e;
      }
    };
    try {
      if (existsSync(tokenPath)) return await attempt();
    } catch (e) {
      if (e instanceof ActiveRunnerUpgrade) {
        upgradeSessions = e.sessions;
        throw e;
      }
    }
    // Seed only this browser preview, before its first service starts.
    if (preview && !existsSync(join(dataDir, "werk.sqlite")))
      seedPreview(dataDir);
    const log = openSync(join(dataDir, "service.log"), "a", 0o600);
    const child = spawn(process.execPath, [join(runtimeDir, "runner.cjs")], {
      detached: true,
      stdio: ["ignore", log, log],
      env: {
        ...interactiveEnvironment(process.env),
        ELECTRON_RUN_AS_NODE: "1",
        WERK_DATA_DIR: dataDir,
      },
    });
    child.unref();
    closeSync(log);
    for (let i = 0; i < 40; i++) {
      await pause(150);
      try {
        return await attempt();
      } catch (e) {
        if (e instanceof ActiveRunnerUpgrade) {
          upgradeSessions = e.sessions;
          throw e;
        }
      }
    }
    throw new Error(
      `De achtergrondservice start niet. Bekijk ${join(dataDir, "service.log")}.`,
    );
  })().finally(() => {
    connecting = null;
  });
  return connecting;
}
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
  "task.criterion",
  "task.reorder",
  "task.submit",
  "task.return",
  "checkin.save",
  "artifact.add",
  "proposal.decide",
  "proposal.item",
  "suggestion.decide",
  "session.start",
  "session.screen",
  "session.write",
  "session.resize",
  "session.stop",
  "session.link",
  "session.message",
  "session.memory.save",
  "inventory",
  "preferences.get",
  "profile.save",
  "account.save",
  "account.remove",
  "accounts.refresh",
  "account.login",
  "account.logout",
  "backup.export",
  "backup.restore",
]);
let scan: Promise<unknown> | null = null;
async function call(method: string, params: any = {}) {
  if (["typesafe.configure", "typesafe.remove"].includes(method))
    throw new Error("Stel TypeSafe in via de desktop-app.");
  if (method === "terminal.theme") {
    if (params?.theme !== "light" && params?.theme !== "dark")
      throw new Error("Ongeldig thema voor gesprekken.");
    if (
      params?.preset !== undefined &&
      !["classic", "refined", "compact"].includes(params.preset)
    )
      throw new Error("Ongeldige weergave voor gesprekken.");
    terminalColors.theme = params.theme;
    terminalColors.preset = params.preset || "classic";
    return;
  }
  if (method === "session.files") {
    const snap = await (await connect()).call<Snapshot>("snapshot");
    return sessionFiles.list(snap, params?.id);
  }
  if (method === "app.info")
    return {
      dataDir,
      defaultWorkspace: preview
        ? join(dataDir, "voorbeeld-werkmap")
        : join(homedir(), "Documents"),
      homeDir: homedir(),
      platform: process.platform,
      version: "0.4.3",
      browser: true,
      preview,
    };
  if (method === "accounts.usage") {
    const prefs = await (await connect()).call<Preferences>("preferences.get");
    const account = prefs.accounts.find((a) => a.id === params?.id);
    if (!account) throw new Error("Account niet gevonden.");
    if (preview)
      return {
        accountId: account.id,
        state: "unavailable",
        windows: [],
        checkedAt: new Date().toISOString(),
        updatedAt: null,
        message: "De voorbeeldomgeving leest geen persoonlijk accountgebruik.",
      };
    usageService.prune(prefs.accounts);
    return usageService.read(account, params?.force === true);
  }
  if (method === "runtime.status") return { upgradeSessions };
  if (method === "runtime.stopLegacy") {
    if (!upgradeSessions?.some((s) => s.id === params.id))
      throw new Error("Dit gesprek is niet beschikbaar.");
    const legacy = new RpcClient(socketPath, {
      channel: "app",
      token: readFileSync(tokenPath, "utf8"),
    });
    try {
      return await legacy.call("session.stop", { id: params.id });
    } finally {
      legacy.close();
    }
  }
  if (method === "schedules.get") {
    try {
      return JSON.parse(
        readFileSync(join(dataDir, "schedule-overview.json"), "utf8"),
      );
    } catch {
      return null;
    }
  }
  if (method === "schedules.scan") {
    if (!scan)
      scan = (async () => {
        const snap = await (await connect()).call<Snapshot>("snapshot");
        const result = await inspectSchedules([
          ...new Set(
            [
              ...snap.companies.map((c) => c.workspacePath),
              ...snap.projects.map((p) => p.workspacePath),
            ].filter(Boolean),
          ),
        ]);
        writeFileSync(
          join(dataDir, "schedule-overview.json"),
          JSON.stringify(result),
          { mode: 0o600 },
        );
        return result;
      })().finally(() => {
        scan = null;
      });
    return scan;
  }
  if (!allowed.has(method)) throw new Error("Onbekende opdracht.");
  return (await connect()).call(method, params, 25000);
}
function canonical(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
async function authorizedPath(path: string) {
  if (typeof path !== "string" || !path || path.length > 8000)
    throw new Error("Ongeldig pad.");
  const snap = (await call("snapshot")) as Snapshot;
  const paths = [
    ...snap.companies.flatMap((c) => [c.workspacePath, ...c.sources]),
    ...snap.projects.map((p) => p.workspacePath),
    ...snap.artifacts.map((a) => a.path),
    ...snap.sessions.map((s) => s.outputDir),
  ];
  if (
    !paths.some((p) => canonical(p) === canonical(path)) &&
    !(await sessionFiles.authorizes(path))
  )
    throw new Error("Koppel dit bestand eerst aan een bedrijf of taak.");
}
async function previewFile(path: string) {
  await authorizedPath(path);
  const name = basename(path),
    ext = extname(path).toLowerCase();
  if (/^https?:\/\//.test(path))
    return { kind: "external", name, content: path };
  const stat = statSync(path);
  if (!stat.isFile()) return { kind: "external", name, content: "" };
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
    ].includes(ext) &&
    stat.size <= 1_000_000
  )
    return { kind: "text", name, content: readFileSync(path, "utf8") };
  const mime: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
  };
  if (mime[ext] && stat.size < 20_000_000)
    return {
      kind: ext === ".pdf" ? "pdf" : "image",
      name,
      content: `data:${mime[ext]};base64,${readFileSync(path).toString("base64")}`,
    };
  return {
    kind: "external",
    name,
    content: "Open dit document in de bijbehorende app.",
  };
}
async function dialog(files: boolean) {
  if (process.platform !== "darwin")
    throw new Error("Vul het volledige bestandspad in het formulier in.");
  const script = files
    ? 'var app=Application.currentApplication();app.includeStandardAdditions=true;JSON.stringify(app.chooseFile({withPrompt:"Koppel bestanden aan Benchdesk",multipleSelectionsAllowed:true}).map(function(f){return f.toString()}));'
    : 'var app=Application.currentApplication();app.includeStandardAdditions=true;JSON.stringify(app.chooseFolder({withPrompt:"Kies de werkmap voor Benchdesk"}).toString());';
  try {
    const { stdout } = await run(
      "osascript",
      ["-l", "JavaScript", "-e", script],
      { timeout: 120000 },
    );
    return JSON.parse(stdout.trim());
  } catch (e: any) {
    if (/\(-128\)|cancel/i.test(e.stderr || "")) return files ? [] : null;
    throw new Error(
      "De bestandskiezer kon niet worden geopend. Vul het pad rechtstreeks in.",
    );
  }
}
async function action(name: string, params: any) {
  if (name === "call") return call(params.method, params.params);
  if (name === "preview") return previewFile(params.path);
  if (name === "folder") return dialog(false);
  if (name === "files") return dialog(true);
  if (name === "open") {
    await authorizedPath(params.path);
    const external = /^https?:\/\//.test(params.path);
    const document =
      /\.(pdf|docx|xlsx|pptx|csv|txt|md|png|jpe?g|gif|webp|json|html)$/i.test(
        params.path,
      );
    if (process.platform !== "darwin")
      throw new Error("Open dit pad in je bestandsbeheerder.");
    await run("open", [
      ...(!external && !document && !statSync(params.path).isDirectory()
        ? ["-R"]
        : []),
      params.path,
    ]);
    return;
  }
  throw new Error("Onbekende browseractie.");
}
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  const json = (status: number, value: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  };
  if (!hosts.has(req.headers.host || ""))
    return json(403, { error: "Alleen localhost is toegestaan." });
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const authenticated = (req.headers.cookie || "")
    .split(";")
    .some((entry) => entry.trim() === `${cookieName}=${cookie}`);
  if (url.pathname.startsWith("/api/")) {
    if (
      !authenticated ||
      (req.headers.origin && !origins.has(req.headers.origin)) ||
      req.headers["sec-fetch-site"] === "cross-site"
    )
      return json(403, {
        error: "Open Benchdesk via localhost en probeer opnieuw.",
      });
    if (url.pathname === "/api/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(": connected\n\n");
      streams.add(res);
      const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 15000);
      req.on("close", () => {
        streams.delete(res);
        clearInterval(heartbeat);
      });
      void connect().catch(() => {});
      return;
    }
    if (
      req.method !== "POST" ||
      !origins.has(req.headers.origin || "") ||
      !req.headers["content-type"]?.startsWith("application/json")
    )
      return json(403, { error: "Ongeldige aanvraagbron." });
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 22_000_000)
          return json(413, { error: "De aanvraag is te groot." });
      }
      json(200, {
        result:
          (await action(url.pathname.slice(5), JSON.parse(body || "{}"))) ??
          null,
      });
    } catch (e) {
      json(400, { error: (e as Error).message });
    }
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD")
    return json(405, { error: "Ongeldige methode." });
  let file: string;
  try {
    file = resolve(
      uiRoot,
      `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`,
    );
  } catch {
    return json(400, { error: "Ongeldig pad." });
  }
  if (
    !file.startsWith(uiRoot + sep) ||
    !existsSync(file) ||
    !statSync(file).isFile() ||
    !mime[extname(file)]
  )
    return json(404, { error: "Niet gevonden." });
  if (file.endsWith("index.html"))
    res.setHeader(
      "Set-Cookie",
      `${cookieName}=${cookie}; HttpOnly; SameSite=Strict; Path=/`,
    );
  res.setHeader("Content-Type", mime[extname(file)]);
  if (req.method === "HEAD") res.end();
  else createReadStream(file).pipe(res);
});
server.listen(port, "127.0.0.1", () => {
  writeFileSync(join(dataDir, "web.pid"), String(process.pid), { mode: 0o600 });
  console.log(
    `Benchdesk: http://localhost:${port} (${preview ? "voorbeeldgegevens" : "eigen gegevens"})`,
  );
  void connect().catch((e) => console.error(e.message));
});
server.on("error", (e) => {
  console.error(e.message);
  process.exit(1);
});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    for (const stream of streams) stream.end();
    client?.close();
    server.close(() => process.exit(0));
  });
