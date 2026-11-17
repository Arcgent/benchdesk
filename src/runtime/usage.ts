import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AssistantAccount } from "../shared/types";
import type { AccountUsage, UsageWindow } from "../shared/usage";
import { shellQuote } from "./adapters";

type Reading = { windows: UsageWindow[]; plan?: string; blocked?: boolean };
class UsageError extends Error {}
const number = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= 0;
function date(value: unknown): string | null {
  if (typeof value !== "string" && !number(value)) return null;
  const time = new Date(typeof value === "number" ? value * 1000 : value);
  return Number.isFinite(time.getTime()) ? time.toISOString() : null;
}
export function parseClaudeUsage(value: any): Reading {
  const labels: Record<string, string> = {
    five_hour: "5 uur",
    seven_day: "7 dagen",
    seven_day_opus: "Opus · 7 dagen",
    seven_day_sonnet: "Sonnet · 7 dagen",
    seven_day_oauth_apps: "OAuth-apps · 7 dagen",
    seven_day_cowork: "Cowork · 7 dagen",
  };
  return {
    windows: Object.entries(labels).flatMap(([id, label]) => {
      const w = value?.[id];
      return number(w?.utilization)
        ? [
            {
              id,
              label,
              usedPercent: w.utilization,
              resetsAt: date(w.resets_at),
            },
          ]
        : [];
    }),
  };
}
export function parseCodexUsage(value: any): Reading {
  const buckets =
    value?.rateLimitsByLimitId &&
    typeof value.rateLimitsByLimitId === "object" &&
    Object.keys(value.rateLimitsByLimitId).length
      ? Object.entries(value.rateLimitsByLimitId)
      : [["codex", value?.rateLimits]];
  const windows: UsageWindow[] = [];
  let plan: string | undefined,
    blocked = value?.ordinaryUsageAllowed === false;
  for (const [id, raw] of buckets) {
    const b = raw as any;
    if (typeof b?.planType === "string") plan = b.planType.slice(0, 80);
    if (b?.spendControlReached === true) blocked = true;
    for (const key of ["primary", "secondary"]) {
      const w = b?.[key];
      if (!number(w?.usedPercent)) continue;
      const mins = w.windowDurationMins;
      const duration =
        number(mins) && mins > 0
          ? mins % 1440 === 0
            ? `${mins / 1440} dagen`
            : mins % 60 === 0
              ? `${mins / 60} uur`
              : `${mins} min`
          : key === "primary"
            ? "Huidig venster"
            : "Extra venster";
      const name =
        typeof b.limitName === "string"
          ? b.limitName.slice(0, 80)
          : String(id).slice(0, 80);
      windows.push({
        id: `${id}-${key}`,
        label: id === "codex" ? duration : `${name} · ${duration}`,
        usedPercent: w.usedPercent,
        resetsAt: date(w.resetsAt),
      });
    }
  }
  return { windows, plan, blocked };
}

// Claude Code's credential store is scoped by CLAUDE_CONFIG_DIR. Never fall
// back to the personal keychain entry for a separate company account.
export function claudeKeychainServices(configDir: string) {
  const scoped = `Claude Code-credentials-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`;
  return configDir === join(homedir(), ".claude")
    ? [scoped, "Claude Code-credentials"]
    : [scoped];
}
async function claudeCredentials(configDir: string) {
  if (process.platform === "darwin") {
    for (const service of claudeKeychainServices(configDir)) {
      try {
        const { stdout } = await promisify(execFile)(
          "/usr/bin/security",
          [
            "find-generic-password",
            "-a",
            userInfo().username,
            "-s",
            service,
            "-w",
          ],
          { timeout: 2500, maxBuffer: 100_000 },
        );
        return JSON.parse(stdout)?.claudeAiOauth;
      } catch {
        /* Try this account's plaintext fallback, never log secrets. */
      }
    }
  }
  try {
    return JSON.parse(
      await readFile(join(configDir, ".credentials.json"), "utf8"),
    )?.claudeAiOauth;
  } catch {
    return null;
  }
}
async function readClaude(account: AssistantAccount): Promise<Reading> {
  const auth = await claudeCredentials(account.configDir);
  if (typeof auth?.accessToken !== "string" || !auth.accessToken)
    throw new UsageError(
      "Geen Claude-abonnementsgegevens beschikbaar. Log in met dit account om gebruik te bekijken.",
    );
  if (typeof auth.expiresAt === "number" && auth.expiresAt <= Date.now())
    throw new UsageError(
      "Claude-login is verlopen. Open een Claude-gesprek of log opnieuw in en vernieuw daarna.",
    );
  const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "Benchdesk/0.2.3",
    },
    signal: AbortSignal.timeout(8000),
    redirect: "error",
  });
  if (response.status === 429)
    throw new UsageError(
      "Claude beperkt het opvragen tijdelijk. Probeer het over enkele minuten opnieuw.",
    );
  if (response.status === 401 || response.status === 403)
    throw new UsageError(
      "Claude geeft geen toegang tot usage. Controleer je login en abonnement.",
    );
  if (!response.ok)
    throw new UsageError("Claude-gebruik is tijdelijk niet beschikbaar.");
  return parseClaudeUsage(await response.json());
}

// Read-only app-server RPC: no thread or model turn is started. Credentials
// remain inside Codex; only normalized quota fields leave this module.
export function readCodex(account: AssistantAccount): Promise<Reading> {
  return new Promise((resolve, reject) => {
    const command =
      "exec " +
      [
        "env",
        "-u",
        "OPENAI_API_KEY",
        "-u",
        "CODEX_API_KEY",
        "-u",
        "CODEX_ACCESS_TOKEN",
        `CODEX_HOME=${account.configDir}`,
        "codex",
        "app-server",
      ]
        .map(shellQuote)
        .join(" ");
    const child = spawn(process.env.SHELL || "/bin/zsh", ["-ilc", command], {
      cwd: homedir(),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        CLAUDECODE: undefined,
      },
      stdio: ["pipe", "pipe", "ignore"],
      detached: true,
    });
    let buffer = "",
      settled = false;
    const finish = (
      reading?: Reading,
      message = "Codex-gebruik kon niet worden opgehaald. Controleer je login en CLI-versie.",
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill();
      }
      if (reading) resolve(reading);
      else reject(new UsageError(message));
    };
    const timer = setTimeout(
      () =>
        finish(
          undefined,
          "Codex reageert niet op de usage-controle. Probeer het later opnieuw.",
        ),
      12000,
    );
    const send = (value: any) =>
      child.stdin.write(JSON.stringify(value) + "\n");
    child.on("error", () => finish());
    child.on("exit", () => finish());
    child.stdin.on("error", () => finish());
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 1_000_000) return finish();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (settled) return;
        if (msg.id === 1) {
          if (msg.error) return finish();
          send({ method: "initialized" });
          send({
            id: 2,
            method: "account/read",
            params: { refreshToken: false },
          });
        } else if (msg.id === 2) {
          if (msg.error) return finish();
          if (
            !["chatgpt", "chatgptAuthTokens"].includes(
              msg.result?.account?.type,
            )
          )
            return finish(
              undefined,
              "Geen ChatGPT-abonnement gevonden. API-accounts bieden hier geen abonnementslimieten.",
            );
          send({ id: 3, method: "account/rateLimits/read" });
        } else if (msg.id === 3) {
          if (msg.error) return finish();
          finish(parseCodexUsage(msg.result));
        }
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "benchdesk", version: "0.2.3" },
        capabilities: {},
      },
    });
  });
}

export class UsageService {
  private cache = new Map<string, { time: number; value: AccountUsage }>();
  private pending = new Map<string, Promise<AccountUsage>>();
  constructor(
    private reader: (a: AssistantAccount) => Promise<Reading> = (a) =>
      a.provider === "claude" ? readClaude(a) : readCodex(a),
    private now = Date.now,
  ) {}
  async read(account: AssistantAccount, force = false): Promise<AccountUsage> {
    const key = JSON.stringify([
      account.id,
      account.provider,
      account.configDir,
      account.email,
      account.status,
    ]);
    const cached = this.cache.get(key),
      now = this.now();
    // At most once/minute, including manual refresh. Share concurrent requests.
    if (cached && now - cached.time < (force ? 60_000 : 300_000))
      return cached.value;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const work = (async (): Promise<AccountUsage> => {
      const checkedAt = new Date(this.now()).toISOString();
      let value: AccountUsage;
      try {
        const reading = await this.reader(account);
        value = {
          ...reading,
          accountId: account.id,
          checkedAt,
          updatedAt: reading.windows.length ? checkedAt : null,
          state: reading.windows.length ? "available" : "unavailable",
          message: reading.windows.length
            ? ""
            : "De provider geeft voor dit account geen gebruikspercentages terug.",
        };
      } catch (e) {
        // Never return provider errors: they can include credentials and payloads.
        value = {
          accountId: account.id,
          checkedAt,
          updatedAt: cached?.value.updatedAt || null,
          state: cached?.value.windows.length ? "stale" : "unavailable",
          windows: cached?.value.windows || [],
          plan: cached?.value.plan,
          blocked: cached?.value.blocked,
          message:
            e instanceof UsageError
              ? e.message
              : "Gebruik is tijdelijk niet beschikbaar. Probeer het later opnieuw.",
        };
      }
      this.cache.set(key, { time: this.now(), value });
      return value;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    return work;
  }
  prune(accounts: AssistantAccount[]) {
    const ids = new Set(accounts.map((a) => a.id));
    for (const key of this.cache.keys())
      if (!ids.has(JSON.parse(key)[0])) this.cache.delete(key);
  }
}
