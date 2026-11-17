import http from "node:http";
import {
  randomBytes,
  randomInt,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, statSync, createReadStream } from "node:fs";
import { resolve, sep, extname } from "node:path";
import { z } from "zod";
import type { Snapshot, Session } from "../shared/types";

type Call = <T = any>(method: string, params?: any) => Promise<T>;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const uuid = z.string().uuid();
const messageInput = z
  .object({
    id: uuid,
    message: z.string().trim().min(1).max(30000),
    clientMessageId: uuid,
  })
  .strict();
const visible = (s: Session) => !s.purpose || s.purpose === "work";

// This listener is loopback-only. Remote traffic must arrive through an HTTPS
// reverse proxy such as Tailscale Serve, with an explicitly configured origin.
export function createMobileServer(options: {
  origin: string;
  uiRoot: string;
  call: Call;
  station: string;
  now?: () => number;
}) {
  const origin = new URL(options.origin);
  if (
    origin.origin !== options.origin ||
    (origin.protocol !== "https:" &&
      !(
        origin.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(origin.hostname)
      ))
  )
    throw new Error(
      "Gebruik een HTTPS-adres of localhost voor de mobiele app.",
    );
  const now = options.now || Date.now;
  // Cookies are scoped to hosts, not ports. Keep separate station/preview
  // origins from overwriting one another's pairing in the same browser.
  const cookieSuffix = digest(origin.origin).slice(0, 12);
  const cookieName =
    origin.protocol === "https:"
      ? `__Host-benchdesk_mobile_${cookieSuffix}`
      : `benchdesk_mobile_local_${cookieSuffix}`;
  const secure = origin.protocol === "https:" ? "; Secure" : "";
  let pairing = "",
    expires = 0,
    attempts = 0;
  const devices = new Map<string, number>();
  // Keep accepted/in-flight PTY message IDs for this bridge lifetime. Fail closed
  // when full rather than evicting IDs and risking duplicate commands on retry.
  const messages = new Map<string, { text: string; result: Promise<any> }>();
  function newPairing() {
    pairing = String(randomInt(10_000_000, 100_000_000));
    expires = now() + 10 * 60_000;
    attempts = 0;
    return { code: pairing, expiresAt: new Date(expires).toISOString() };
  }
  const summarize = (s: Session, snapshot: Snapshot) => ({
    id: s.id,
    provider: s.provider,
    state: s.state,
    alive: !!s.alive,
    agentRunning: !!s.agentRunning,
    transport: s.transport || "pty",
    updatedAt: s.updatedAt,
    title:
      snapshot.agentConversations?.find((c) => c.sessionId === s.id)?.title ||
      snapshot.tasks.find((t) => t.id === s.taskId)?.title ||
      `${s.provider === "shell" ? "Terminal" : s.provider === "codex" ? "Codex" : "Claude"} · vrij gesprek`,
    company:
      snapshot.companies.find((c) => c.id === s.companyId)?.name || "Benchdesk",
    canSend:
      s.provider !== "shell" && (s.transport === "chat" || !!s.agentRunning),
    memory: s.memory?.summary || "",
  });
  const server = http.createServer(async (req, res) => {
    const json = (status: number, value: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(value));
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (req.headers.host !== origin.host)
      return json(403, { error: "Onbekend basisstationadres." });
    let url: URL;
    try {
      url = new URL(req.url || "/", origin);
    } catch {
      return json(400, { error: "Ongeldig adres." });
    }
    if (url.pathname.startsWith("/api/")) {
      if (
        req.headers["sec-fetch-site"] === "cross-site" ||
        (req.headers.origin && req.headers.origin !== origin.origin)
      )
        return json(403, { error: "Ongeldige aanvraagbron." });
      if (!["GET", "POST"].includes(req.method || ""))
        return json(405, { error: "Ongeldige methode." });
      if (
        req.method === "POST" &&
        (req.headers.origin !== origin.origin ||
          !req.headers["content-type"]?.startsWith("application/json"))
      )
        return json(403, { error: "Ongeldige aanvraagbron." });
      try {
        let body: any = {};
        if (req.method === "POST") {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 128_000)
              return json(413, { error: "Bericht te groot." });
            chunks.push(chunk);
          }
          body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        }
        if (url.pathname === "/api/pair" && req.method === "POST") {
          if (!pairing || now() >= expires || attempts >= 5)
            return json(429, {
              error:
                "Koppelcode verlopen of geblokkeerd. Start de mobiele koppeling opnieuw op je laptop.",
            });
          attempts++;
          const supplied =
            typeof body.code === "string" ? body.code.replace(/\s/g, "") : "";
          if (
            !timingSafeEqual(
              Buffer.from(digest(supplied)),
              Buffer.from(digest(pairing)),
            )
          )
            return json(403, { error: "De koppelcode klopt niet." });
          pairing = "";
          for (const [key, expiry] of devices)
            if (expiry <= now()) devices.delete(key);
          const token = randomBytes(32).toString("hex");
          devices.set(digest(token), now() + 30 * 86400_000);
          res.setHeader(
            "Set-Cookie",
            `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}`,
          );
          return json(200, { ok: true });
        }
        const token =
          (req.headers.cookie || "")
            .split(";")
            .map((v) => v.trim())
            .find((v) => v.startsWith(cookieName + "="))
            ?.slice(cookieName.length + 1) || "";
        if (!token || (devices.get(digest(token)) || 0) <= now())
          return json(401, {
            error: "Koppel deze telefoon met Benchdesk op je laptop.",
          });
        if (url.pathname === "/api/logout" && req.method === "POST") {
          devices.delete(digest(token));
          res.setHeader(
            "Set-Cookie",
            `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`,
          );
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/sessions" && req.method === "GET") {
          const snapshot = await options.call<Snapshot>("snapshot");
          return json(200, {
            station: options.station,
            sessions: snapshot.sessions
              .filter(visible)
              .sort(
                (a, b) =>
                  Number(!!b.alive) - Number(!!a.alive) ||
                  b.updatedAt.localeCompare(a.updatedAt),
              )
              .map((s) => summarize(s, snapshot)),
          });
        }
        if (
          (url.pathname === "/api/session" && req.method === "GET") ||
          (url.pathname === "/api/message" && req.method === "POST")
        ) {
          const id = uuid.parse(
            req.method === "GET" ? url.searchParams.get("id") : body.id,
          );
          const snapshot = await options.call<Snapshot>("snapshot");
          const session = snapshot.sessions.find(
            (s) => s.id === id && visible(s),
          );
          if (!session) return json(404, { error: "Gesprek niet gevonden." });
          if (req.method === "GET") {
            const afterSequence = z.coerce
              .number()
              .int()
              .nonnegative()
              .parse(url.searchParams.get("after") || 0);
            const chat =
              session.transport === "chat" && session.conversationId
                ? await options.call("chat.read", {
                    id: session.conversationId,
                    afterSequence,
                  })
                : null;
            return json(200, {
              session: summarize(session, snapshot),
              chat: chat
                ? {
                    items: chat.items,
                    nextSequence: chat.nextSequence,
                    more: chat.more,
                  }
                : null,
              frame: chat ? null : await options.call("session.screen", { id }),
            });
          }
          const p = messageInput.parse(body);
          if (!summarize(session, snapshot).canSend)
            return json(409, {
              error:
                "Hervat dit agentgesprek op je laptop voordat je een bericht stuurt.",
            });
          if (session.transport === "chat" && session.conversationId)
            return json(
              200,
              await options.call("chat.send", {
                ...p,
                id: session.conversationId,
              }),
            );
          const key = `${id}:${p.clientMessageId}`,
            old = messages.get(key);
          if (old && old.text !== p.message)
            return json(409, { error: "Dit bericht-ID is al gebruikt." });
          if (!old && messages.size >= 1000)
            return json(409, {
              error:
                "Start de mobiele koppeling opnieuw voordat je verder gaat.",
            });
          // Retain even an ambiguous timeout: retrying must never execute twice.
          const entry = old || {
            text: p.message,
            result: options.call("session.message", { id, message: p.message }),
          };
          messages.set(key, entry);
          return json(200, await entry.result);
        }
        return json(404, { error: "Niet gevonden." });
      } catch (error) {
        return json(
          error instanceof z.ZodError || error instanceof SyntaxError
            ? 400
            : 503,
          {
            error:
              error instanceof z.ZodError
                ? "Ongeldige invoer."
                : (error as Error).message,
          },
        );
      }
    }
    if (!["GET", "HEAD"].includes(req.method || ""))
      return json(405, { error: "Ongeldige methode." });
    const root = resolve(options.uiRoot);
    let file: string;
    try {
      file = resolve(
        root,
        "." +
          decodeURIComponent(
            url.pathname === "/" ? "/index.html" : url.pathname,
          ),
      );
    } catch {
      return json(400, { error: "Ongeldig pad." });
    }
    const mime: Record<string, string> = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".woff2": "font/woff2",
      ".woff": "font/woff",
      ".svg": "image/svg+xml",
      ".webmanifest": "application/manifest+json",
    };
    if (
      !file.startsWith(root + sep) ||
      !mime[extname(file)] ||
      !existsSync(file) ||
      !statSync(file).isFile()
    )
      return json(404, { error: "Niet gevonden." });
    res.setHeader("Content-Type", mime[extname(file)]);
    if (req.method === "HEAD") return res.end();
    const stream = createReadStream(file);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return { server, newPairing, revokeAll: () => devices.clear() };
}
