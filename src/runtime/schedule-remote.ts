import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseToml } from "smol-toml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  identity,
  clean,
  cronLabel,
  nextCron,
  mapLimit,
} from "./schedule-local";
import type { ScheduleSource, ScheduledJob } from "../shared/schedules";

type Connection = {
  name: string;
  origin: string;
  url?: string;
  headers: Record<string, string>;
  disabled: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
};
export function remoteConnection(
  name: string,
  config: any,
  origin: string,
): Connection {
  let url = config.url;
  const headers = { ...config.http_headers, ...config.headers };
  const args: string[] = Array.isArray(config.args) ? config.args : [];
  // Read mcp-remote configuration without running its shell command.
  if (!url && args.some((x) => /mcp-remote/.test(x)))
    url = args.find((x) => /^https?:\/\//.test(x));
  for (let i = 0; i < args.length - 1; i++)
    if (args[i] === "--header") {
      const colon = args[i + 1].indexOf(":");
      if (colon > 0)
        headers[args[i + 1].slice(0, colon)] = args[i + 1]
          .slice(colon + 1)
          .trim();
    }
  if (config.bearer_token_env_var && process.env[config.bearer_token_env_var])
    headers.Authorization = `Bearer ${process.env[config.bearer_token_env_var]}`;
  for (const [key, variable] of Object.entries(config.env_http_headers || {}))
    if (typeof variable === "string" && process.env[variable])
      headers[key] = process.env[variable];
  return {
    name,
    url,
    headers,
    origin,
    disabled: config.enabled === false || config.disabled === true,
    command: config.command,
    args,
    env: config.env,
  };
}
async function connections(workspaces: string[], home: string) {
  const all: Connection[] = [],
    issues: ScheduleSource[] = [];
  const paths = [
    join(home, ".claude.json"),
    join(home, ".claude/settings.json"),
    join(home, "Library/Application Support/Claude/claude_desktop_config.json"),
    join(process.env.CODEX_HOME || join(home, ".codex"), "config.toml"),
    ...workspaces.flatMap((x) => [
      join(x, ".mcp.json"),
      join(x, ".codex/config.toml"),
    ]),
  ];
  for (const path of new Set(paths)) {
    try {
      const raw = await readFile(path, "utf8");
      const value: any = path.endsWith(".toml")
        ? parseToml(raw)
        : JSON.parse(raw);
      const add = (servers: any) => {
        for (const [name, config] of Object.entries(servers || {}))
          all.push(remoteConnection(name, config, path));
      };
      add(value.mcpServers || value.mcp_servers);
      if (value.projects)
        for (const workspace of workspaces)
          add(value.projects[workspace]?.mcpServers);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        issues.push({
          id: identity(path),
          name: "Configuratiebestand",
          location: path,
          status: "error",
          message: "Koppelingen in dit bestand konden niet worden gelezen.",
          count: 0,
        });
    }
  }
  // Distinct credentials can represent different workspaces on one service.
  const unique = new Map<string, Connection>();
  for (const item of all)
    unique.set(
      identity(
        JSON.stringify([
          item.url || item.name,
          Object.entries(item.headers).sort(),
          item.disabled,
        ]),
      ),
      item,
    );
  return { all: [...unique.values()], issues };
}
export function toolData(result: any): any {
  if (result.isError) throw new Error("De dienst weigerde de leesaanvraag.");
  const structured = result.structuredContent;
  let data = structured;
  if (!data) {
    const text = (result.content || [])
      .filter((x: any) => x.type === "text")
      .map((x: any) => x.text)
      .join("\n");
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("De dienst leverde geen leesbaar gegevensoverzicht.");
    }
  }
  if (data?.statusCode >= 400 || data?.error)
    throw new Error("De dienst meldt een fout bij het ophalen.");
  return data;
}
export function pageItems(
  data: any,
  fields = ["items", "automations", "schedules"],
): any[] {
  if (Array.isArray(data)) return data;
  for (const field of fields)
    if (Array.isArray(data?.[field])) return data[field];
  throw new Error(
    "De dienst leverde geen herkenbare lijst; de bron is niet als leeg bevestigd.",
  );
}
const nextDate = (value: unknown) => {
  const n = value ? new Date(value as string | number).getTime() : NaN;
  return Number.isFinite(n) ? new Date(n).toISOString() : undefined;
};
function base(
  source: ScheduleSource,
  id: string,
  title: unknown,
): ScheduledJob {
  return {
    id: identity(`${source.id}:${id}`),
    sourceId: source.id,
    title: clean(title || "Naamloze automatisering"),
    kind: "event",
    status: "unknown",
    schedule: "Op gebeurtenis",
    timezone: "Niet van toepassing",
    origin: source.location,
    description: "",
  };
}
export function campaignJobs(
  items: any[],
  source: ScheduleSource,
  now = new Date(),
): ScheduledJob[] {
  return items.map((item) => {
    const job = base(source, item.id, item.name);
    job.kind = "scheduled";
    job.status =
      item.status === 1
        ? "enabled"
        : item.status === 3
          ? "completed"
          : item.status === 0 || item.status === 2
            ? "paused"
            : "unknown";
    const windows: any[] = item.campaign_schedule?.schedules || [];
    job.schedule =
      windows
        .map((w) => {
          const days = Object.entries(w.days || {})
            .filter(([, on]) => on)
            .map(
              ([day]) =>
                ["zo", "ma", "di", "wo", "do", "vr", "za"][Number(day)],
            )
            .join(", ");
          return `${days || "Dagen niet opgegeven"} · ${clean(w.timing?.from)}–${clean(w.timing?.to)}`;
        })
        .join("; ") || "Verzendvenster niet beschikbaar";
    job.timezone =
      [...new Set(windows.map((w) => clean(w.timezone)).filter(Boolean))].join(
        ", ",
      ) || "Niet opgegeven";
    job.description =
      "Terugkerend verzendvenster in Instantly. Een open venster bevestigt niet dat er op dat moment e-mails worden verzonden.";
    if (job.status === "enabled") {
      const starts: string[] = [];
      for (const w of windows) {
        const [hour, minute] = String(w.timing?.from || "").split(":");
        const dayValues = Object.entries(w.days || {})
          .filter(([, on]) => on)
          .map(([day]) => day)
          .join(",");
        if (
          !w.timezone ||
          !dayValues ||
          !/^\d+$/.test(hour) ||
          !/^\d+$/.test(minute)
        )
          continue;
        try {
          const parts = Object.fromEntries(
            new Intl.DateTimeFormat("en-US", {
              timeZone: w.timezone,
              weekday: "short",
              hour: "2-digit",
              minute: "2-digit",
              hourCycle: "h23",
            })
              .formatToParts(now)
              .map((p) => [p.type, p.value]),
          );
          const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
            parts.weekday,
          );
          const time = `${parts.hour}:${parts.minute}`;
          if (w.days?.[day] && time >= w.timing.from && time < w.timing.to)
            job.nextRunLabel = "Verzendvenster nu open";
          const next = nextCron(
            `${minute} ${hour} * * ${dayValues}`,
            w.timezone,
            now,
          );
          if (next.nextRunAt) starts.push(next.nextRunAt);
          if (next.issue) job.issue = next.issue;
        } catch {
          job.issue = "De ingestelde tijdzone kan niet worden gelezen.";
        }
      }
      if (!job.nextRunLabel) {
        job.nextRunAt = starts.sort()[0];
        job.nextRunLabel = "Volgend verzendvenster";
      }
    }
    return job;
  });
}
export function workflowJobs(
  data: any,
  source: ScheduleSource,
  now = new Date(),
): ScheduledJob[] {
  const workflow = data.workflow || data;
  const active = workflow.active === true && !workflow.isArchived;
  // Read the published trigger when a newer, unpublished draft also exists.
  const published =
    active && workflow.activeVersion?.nodes ? workflow.activeVersion : workflow;
  const timezone = published.settings?.timezone || workflow.settings?.timezone;
  const nodes: any[] = published.nodes || [];
  const jobs: ScheduledJob[] = [];
  for (const node of nodes) {
    if (/manualTrigger|executeWorkflowTrigger/i.test(node.type)) continue;
    if (!/trigger|cron|webhook|\.interval$/i.test(node.type)) continue;
    const timed = /scheduleTrigger|\.cron$|\.interval$/.test(node.type);
    const rules = timed
      ? node.parameters?.rule?.interval ||
        node.parameters?.triggerTimes?.item || [{}]
      : [{}];
    for (const [i, rule] of rules.entries()) {
      const job = base(
        source,
        `${workflow.id}:${node.id || node.name}:${i}`,
        `${workflow.name} · ${node.name}`,
      );
      job.status = active && !node.disabled ? "enabled" : "paused";
      job.kind = timed ? "scheduled" : "event";
      job.timezone = timed
        ? timezone || "Instelling in n8n"
        : "Niet van toepassing";
      job.description = `Workflow in n8n. ${active ? "Gepubliceerd" : "Niet actief"}. Trigger: ${clean(node.name)}.`;
      if (timed) {
        const field = rule.field || rule.mode;
        const hour = rule.triggerAtHour ?? rule.hour ?? 0,
          minute = rule.triggerAtMinute ?? rule.minute ?? 0;
        const every =
          rule.minutesInterval ??
          rule.hoursInterval ??
          rule.daysInterval ??
          rule.weeksInterval ??
          1;
        let expression = rule.expression || rule.cronExpression;
        if (
          !expression &&
          ["weeks", "everyWeek"].includes(field) &&
          every === 1
        )
          expression = `${minute} ${hour} * * ${(rule.triggerAtDay || [rule.weekday ?? 1]).join(",")}`;
        if (!expression && ["days", "everyDay"].includes(field) && every === 1)
          expression = `${minute} ${hour} * * *`;
        if (
          !expression &&
          ["hours", "everyHour"].includes(field) &&
          every === 1
        )
          expression = `${minute} * * * *`;
        if (!expression && field === "minutes" && 60 % every === 0)
          expression = `*/${every} * * * *`;
        if (!expression && field === "everyMinute") expression = "* * * * *";
        if (expression) {
          job.schedule = cronLabel(expression);
          job.description += ` Schema: ${clean(expression)}.`;
          if (timezone && job.status === "enabled")
            Object.assign(job, nextCron(expression, timezone, now));
        } else
          job.schedule = `Elke ${every} ${({ seconds: "seconden", minutes: "minuten", hours: "uur", days: "dagen", weeks: "weken", months: "maanden" } as any)[field] || clean(field || "periode")}`;
        if (!timezone) job.nextRunLabel = "Tijdzone staat in de n8n-instantie";
        else if (!expression)
          job.nextRunLabel = "Exacte start wordt door n8n bepaald";
      } else
        job.schedule = /webhook/i.test(node.type)
          ? "Bij een webhook"
          : /chatTrigger/i.test(node.type)
            ? "Bij een chatbericht"
            : `Bij ${clean(node.name)}`;
      jobs.push(job);
    }
  }
  return jobs;
}
export async function collectRemoteSchedules(
  workspaces: string[],
  now = new Date(),
  home = homedir(),
) {
  const found = await connections(workspaces, home);
  const sources = found.issues,
    jobs: ScheduledJob[] = [];
  await mapLimit(found.all, 4, async (connection) => {
    const id = identity(
      JSON.stringify([connection.name, connection.url, connection.headers]),
    );
    let host = "Lokale koppeling";
    try {
      if (connection.url) host = new URL(connection.url).hostname;
    } catch {}
    const source: ScheduleSource = {
      id,
      name: clean(connection.name),
      location: host,
      status: "unsupported",
      message:
        "Koppeling gevonden. Deze dienst heeft nog geen ondersteunde leesverbinding voor terugkerende taken in Benchdesk.",
      count: 0,
    };
    sources.push(source);
    if (connection.disabled) {
      source.message = "Deze koppeling is uitgeschakeld in je configuratie.";
      return;
    }
    const provider = /(^|\.)blotato\.com$/.test(host)
      ? "blotato"
      : /(^|\.)instantly\.ai$/.test(host)
        ? "instantly"
        : /n8n/i.test(connection.name)
          ? "n8n"
          : /^hostinger(?:-mcp)?$/i.test(connection.name)
            ? "hostinger"
            : null;
    if (
      !provider ||
      (!connection.url && !(provider === "hostinger" && connection.command))
    )
      return;
    const client = new Client({ name: "benchdesk-schedules", version: "0.1.0" });
    client.onerror = () => {};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    const call = async (name: string, args: any = {}) =>
      toolData(
        await client.callTool({ name, arguments: args }, undefined, {
          timeout: 12000,
          signal: controller.signal,
        }),
      );
    try {
      const transport =
        !connection.url && connection.command
          ? new StdioClientTransport({
              command: connection.command,
              args: connection.args,
              env: {
                ...process.env,
                PATH: [
                  join(home, ".local/bin"),
                  join(home, ".npm-global/bin"),
                  "/opt/homebrew/bin",
                  "/usr/local/bin",
                  process.env.PATH || "",
                ].join(":"),
                ...connection.env,
              } as Record<string, string>,
              stderr: "pipe",
            })
          : new StreamableHTTPClientTransport(new URL(connection.url!), {
              requestInit: { headers: connection.headers },
              fetch: (url, options) =>
                fetch(url, {
                  ...options,
                  redirect: "error",
                  signal: AbortSignal.any([
                    controller.signal,
                    AbortSignal.timeout(15000),
                    ...(options?.signal ? [options.signal] : []),
                  ]),
                }),
            });
      await client.connect(transport, { timeout: 12000 });
      source.status = "ok";
      source.message = "Actueel uit de dienst opgehaald.";
      if (provider === "hostinger") {
        source.location = "Hostinger · hostingaccounts";
        source.message =
          "Cronjobs op hostingwebsites gecontroleerd. Cronjobs binnen VPS-servers zijn niet via deze hosting-API uitleesbaar.";
        const accounts = new Set<string>();
        for (const agency of [false, true]) {
          for (let page = 1; page <= 30; page++) {
            const data = await call(
              agency
                ? "agency-hosting_listAgencyPlanWebsitesV1"
                : "hosting_listWebsitesV1",
              { page, per_page: 100 },
            );
            const websites = pageItems(data, ["data"]);
            for (const website of websites) {
              const account = agency
                ? website.uid || website.website_uid
                : website.username || website.account?.username;
              if (!account) {
                source.status = "partial";
                source.message =
                  "Een hostingaccount kon niet aan de cronlijst worden gekoppeld.";
                continue;
              }
              const key = `${agency}:${account}`;
              if (accounts.has(key)) continue;
              accounts.add(key);
              for (let jobPage = 1; jobPage <= 30; jobPage++) {
                const value = await call(
                  agency
                    ? "agency-hosting_listWebsiteCronJobsV1"
                    : "hosting_listAccountCronJobsV1",
                  agency
                    ? { website_uid: account, page: jobPage, per_page: 100 }
                    : { username: account },
                );
                const cronjobs = pageItems(value, ["data", "items"]);
                for (const item of cronjobs) {
                  const job = base(
                    source,
                    `${account}:${item.uid || item.uuid || item.id}`,
                    `${website.domain || account} · cronjob`,
                  );
                  job.kind = "cron";
                  job.status = "enabled";
                  job.schedule = cronLabel(
                    item.time || item.schedule || "Schema niet opgegeven",
                  );
                  job.timezone = "Tijdzone van de hostingserver";
                  job.description =
                    "Cronjob op Hostinger. Het commando blijft in de oorspronkelijke dienst; het exacte volgende tijdstip vereist de servertijdzone.";
                  jobs.push(job);
                }
                if (!agency || !value.meta || jobPage * 100 >= value.meta.total)
                  break;
                if (jobPage === 30) source.status = "partial";
              }
            }
            if (!data.meta || page * 100 >= data.meta.total) break;
            if (page === 30) source.status = "partial";
          }
        }
      } else if (provider === "n8n") {
        const data = await call("search_workflows", { limit: 200 });
        const workflows = pageItems(data, ["data", "workflows"]);
        if (
          (data.count ?? workflows.length) > workflows.length ||
          workflows.length === 200
        ) {
          source.status = "partial";
          source.message =
            "De dienst toont maximaal 200 workflows; niet alles kon worden bevestigd.";
        }
        await mapLimit(workflows, 4, async (workflow) => {
          try {
            if (workflow.availableInMCP === false)
              throw new Error("MCP access disabled");
            jobs.push(
              ...workflowJobs(
                await call("get_workflow_details", { workflowId: workflow.id }),
                source,
                now,
              ),
            );
          } catch {
            source.status = "partial";
            source.message = "Niet alle workflowdetails waren toegankelijk.";
            jobs.push({
              ...base(source, workflow.id, workflow.name),
              kind: "unverified",
              schedule: "Niet uitgelezen",
              issue:
                workflow.availableInMCP === false
                  ? "MCP-toegang staat uit voor deze workflow. De planning is daardoor niet uitleesbaar."
                  : "Triggerdetails konden niet worden opgehaald.",
              description:
                "Deze workflow is in de dienst gevonden; de planning is nog niet bevestigd.",
            });
          }
        });
      } else {
        const endpoints =
          provider === "instantly"
            ? ["list_campaigns", "agent_items_list"]
            : ["blotato_list_automations", "blotato_list_schedules"];
        for (const endpoint of endpoints) {
          let cursor: string | undefined;
          const seen = new Set<string>();
          for (let page = 0; page < 30; page++) {
            const data = await call(endpoint, {
              limit:
                provider === "instantly"
                  ? 100
                  : endpoint.endsWith("schedules")
                    ? 50
                    : 250,
              ...(cursor
                ? {
                    [provider === "instantly" ? "starting_after" : "cursor"]:
                      cursor,
                  }
                : {}),
            });
            const items = pageItems(data);
            if (endpoint === "list_campaigns")
              jobs.push(...campaignJobs(items, source, now));
            else
              for (const item of items) {
                const job = base(
                  source,
                  `${endpoint}:${item.id || item.resource_id}`,
                  item.name ||
                    item.post?.target?.title ||
                    item.post?.content?.text?.slice(0, 100) ||
                    item.post?.text?.slice(0, 100) ||
                    "Geplande publicatie",
                );
                if (endpoint.endsWith("list_schedules")) {
                  job.kind = "once";
                  job.status = "enabled";
                  job.nextRunAt = nextDate(
                    item.scheduledTime || item.scheduledAt || item.publishAt,
                  );
                  job.schedule = "Eenmalige publicatie";
                  job.timezone = "Tijdstip van de dienst";
                  job.description = "Geplande publicatie in Blotato.";
                  if (!job.nextRunAt) {
                    job.status = "unknown";
                    job.issue =
                      "Het publicatietijdstip ontbreekt in het antwoord.";
                  }
                } else {
                  job.status =
                    item.isActive === true || item.status === "Active"
                      ? "enabled"
                      : item.isActive === false ||
                          ["Paused", "Draft"].includes(item.status)
                        ? "paused"
                        : item.status === "Error"
                          ? "error"
                          : "unknown";
                  job.schedule =
                    provider === "blotato"
                      ? "Bij een reactie of privébericht"
                      : "Doorlopende agent / automatisering";
                  job.description =
                    provider === "blotato"
                      ? "DM-automatisering in Blotato; reageert op de ingestelde triggers."
                      : "Agent of automatisering uit het Instantly-overzicht. De dienst geeft hier geen exact startmoment.";
                }
                jobs.push(job);
              }
            cursor =
              data.next_starting_after ||
              data.nextCursor ||
              data.next_cursor ||
              data.pagination?.nextCursor;
            if (!cursor) break;
            if (seen.has(cursor) || page === 29) {
              source.status = "partial";
              source.message = "Niet alle pagina’s zijn opgehaald.";
              break;
            }
            seen.add(cursor);
          }
        }
      }
    } catch {
      source.status = jobs.some((j) => j.sourceId === source.id)
        ? "partial"
        : "error";
      source.message =
        "Ophalen is niet gelukt. Controleer de verbinding en je toegang in de oorspronkelijke dienst.";
    } finally {
      clearTimeout(timer);
      controller.abort();
      await client.close().catch(() => {});
    }
    source.count = jobs.filter((j) => j.sourceId === id).length;
  });
  return { jobs, sources };
}
