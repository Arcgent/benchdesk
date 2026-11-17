import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { parse as parseToml } from "smol-toml";
import type { ScheduledJob, ScheduleSource } from "../shared/schedules";

const exec = promisify(execFile);
export const identity = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 20);
export const clean = (value: unknown, length = 500) =>
  String(value ?? "")
    .replace(/[\x00-\x08\x0b-\x1f]/g, "")
    .slice(0, length);
export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
export async function mapLimit<T, R>(
  values: T[],
  limit: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const output: R[] = new Array(values.length);
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (index < values.length) {
        const current = index++;
        output[current] = await fn(values[current]);
      }
    }),
  );
  return output;
}
export function nextCron(
  expression: string,
  timezone: string,
  now = new Date(),
) {
  try {
    return {
      nextRunAt: CronExpressionParser.parse(expression, {
        tz: timezone,
        currentDate: now,
      })
        .next()
        .toDate()
        .toISOString(),
    };
  } catch {
    return {
      issue: "Planning of tijdzone is niet geldig; controleer de bron.",
    };
  }
}
export function nextAutomationRule(
  rule: string,
  timezone: string,
  now = new Date(),
): string | undefined {
  const fields: Record<string, string> = Object.fromEntries(
    rule
      .replace(/^RRULE:/, "")
      .split(";")
      .map((part) => part.split("=")),
  );
  // Only translate rules whose next start is independent of an unseen anchor.
  // More complex recurrence remains visible in its original form.
  if (
    Object.keys(fields).some(
      (k) =>
        ![
          "FREQ",
          "INTERVAL",
          "BYDAY",
          "BYHOUR",
          "BYMINUTE",
          "BYSECOND",
        ].includes(k),
    ) ||
    (fields.INTERVAL && fields.INTERVAL !== "1") ||
    (fields.BYSECOND && fields.BYSECOND !== "0")
  )
    return;
  const hour = fields.BYHOUR,
    minute = fields.BYMINUTE;
  if (
    !minute ||
    !/^\d+(,\d+)*$/.test(minute) ||
    (fields.FREQ !== "HOURLY" && (!hour || !/^\d+(,\d+)*$/.test(hour)))
  )
    return;
  const week = fields.BYDAY?.split(",").map(
    (d) =>
      (
        ({ SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }) as Record<
          string,
          number
        >
      )[d],
  );
  if (week?.some((d) => d === undefined)) return;
  if (
    !["HOURLY", "DAILY", "WEEKLY"].includes(fields.FREQ) ||
    (fields.FREQ === "WEEKLY" && !week?.length)
  )
    return;
  return nextCron(
    `${minute} ${fields.FREQ === "HOURLY" ? "*" : hour} * * ${week?.join(",") || "*"}`,
    timezone,
    now,
  ).nextRunAt;
}
const days = ["zo", "ma", "di", "wo", "do", "vr", "za"];
export function cronLabel(expression: string) {
  const parts = expression.trim().split(/\s+/);
  if (parts.length === 6 && parts[0] === "0") parts.shift();
  if (parts.length !== 5) return expression;
  const [m, h, d, month, day] = parts;
  if (d === "*" && month === "*" && day === "*") {
    if (h === "*" && m === "*") return "Elke minuut";
    if (h === "*" && /^\*\/\d+$/.test(m)) return `Elke ${m.slice(2)} minuten`;
    if (/^\d+$/.test(m) && h === "*")
      return `Elk uur om :${m.padStart(2, "0")}`;
    if (/^\d+$/.test(m) && /^\*\/\d+$/.test(h))
      return `Elke ${h.slice(2)} uur, minuut ${m}`;
  }
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && d === "*" && month === "*") {
    const time = `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
    if (day === "*") return `Dagelijks om ${time}`;
    if (day === "1-5") return `Werkdagen om ${time}`;
    if (/^[0-7](,[0-7])*$/.test(day))
      return `${day
        .split(",")
        .map((x) => days[Number(x) % 7])
        .join(", ")} om ${time}`;
  }
  return expression;
}
export function parseCrontab(
  text: string,
  sourceId: string,
  origin: string,
  now = new Date(),
  system = false,
): ScheduledJob[] {
  const jobs: ScheduledJob[] = [];
  let timezone = localZone();
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    let line = raw.trim();
    if (!line) continue;
    // A commented schedule remains visible as paused; ordinary comments do not.
    const paused = line.startsWith("#");
    if (paused) line = line.slice(1).trim();
    const assignment = line.match(/^(?:CRON_TZ|TZ)\s*=\s*["']?([^"'\s]+)/);
    if (assignment && !paused) {
      timezone = assignment[1];
      continue;
    }
    const match = line.match(
      /^(@\w+|(?:[\d*\/?,\-A-Za-z]+\s+){4}[\d*\/?,\-A-Za-z]+)\s+(.+)$/,
    );
    if (!match || (!match[1].startsWith("@") && !/^[\d*]/.test(match[1])))
      continue;
    const expression = match[1].replace(/\s+/g, " ");
    let command = match[2];
    if (system) command = command.replace(/^\S+\s+/, "");
    const script = command.match(
      /(?:^|\s)([\w./~-]+\.(?:py|sh|mjs|cjs|js|rb))(?=\s|$)/,
    )?.[1];
    const cwd = command.match(
      /(?:^|[;&]\s*)cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&]+))/,
    );
    const directory = cwd?.[1] || cwd?.[2] || cwd?.[3];
    const missing = directory?.startsWith("/") && !existsSync(directory);
    const calendar: { nextRunAt?: string; issue?: string } =
      expression === "@reboot" ? {} : nextCron(expression, timezone, now);
    jobs.push({
      id: identity(`${sourceId}:${index}:${line}`),
      sourceId,
      title: script ? basename(script) : `Cronjob ${jobs.length + 1}`,
      kind: expression === "@reboot" ? "service" : "cron",
      status: paused
        ? "paused"
        : missing || calendar.issue
          ? "error"
          : "enabled",
      schedule:
        expression === "@reboot" ? "Bij het opstarten" : cronLabel(expression),
      timezone,
      ...(!paused ? calendar : {}),
      origin: `${origin}:${index + 1}`,
      description: `Schema: ${expression}.${directory ? ` Werkmap: ${clean(directory)}.` : ""} Uitvoering en laatste resultaat worden niet door crontab bijgehouden.`,
      ...(missing
        ? { issue: "De ingestelde werkmap bestaat niet op deze Mac." }
        : {}),
      system,
    });
  }
  return jobs;
}
export function launchdJob(
  plist: any,
  sourceId: string,
  origin: string,
  now = new Date(),
): ScheduledJob | null {
  if (!plist.Label) return null;
  const calendar = plist.StartCalendarInterval;
  const interval = plist.StartInterval;
  const system = origin.startsWith("/System/");
  if (
    !calendar &&
    !interval &&
    (system ||
      !(
        plist.RunAtLoad ||
        plist.KeepAlive ||
        plist.WatchPaths ||
        plist.QueueDirectories
      ))
  )
    return null;
  const timezone = localZone();
  let schedule = "Bij het inloggen of opstarten";
  let nextRunAt: string | undefined;
  let issue: string | undefined;
  if (calendar) {
    const expressions = (Array.isArray(calendar) ? calendar : [calendar]).map(
      (c: any) =>
        [
          c.Minute ?? "*",
          c.Hour ?? "*",
          c.Day ?? "*",
          c.Month ?? "*",
          c.Weekday ?? "*",
        ].join(" "),
    );
    schedule = expressions.map(cronLabel).join(" · ");
    const computed = expressions.map((x: string) => nextCron(x, timezone, now));
    nextRunAt = computed
      .flatMap((x: any) => (x.nextRunAt ? [x.nextRunAt] : []))
      .sort()[0];
    issue = computed.find((x: any) => x.issue)?.issue;
  } else if (interval) {
    schedule =
      interval % 3600 === 0
        ? `Elke ${interval / 3600} uur`
        : interval % 60 === 0
          ? `Elke ${interval / 60} minuten`
          : `Elke ${interval} seconden`;
  } else if (plist.WatchPaths || plist.QueueDirectories)
    schedule = "Bij wijzigingen in gekoppelde mappen";
  else if (plist.KeepAlive) schedule = "Blijft actief / wordt opnieuw gestart";
  return {
    id: identity(origin),
    sourceId,
    title: clean(plist.Label),
    kind:
      calendar || interval
        ? "scheduled"
        : plist.WatchPaths || plist.QueueDirectories
          ? "event"
          : "service",
    status: plist.Disabled === true ? "paused" : "unknown",
    schedule,
    timezone,
    ...(plist.Disabled !== true && nextRunAt ? { nextRunAt } : {}),
    ...(!calendar && interval
      ? { nextRunLabel: "Interval; eerstvolgende start niet bekend" }
      : {}),
    origin,
    description: `Programma: ${clean(plist.Program || plist.ProgramArguments?.[0] || "Niet opgegeven")}.${plist.WorkingDirectory ? ` Werkmap: ${clean(plist.WorkingDirectory)}.` : ""}`,
    issue,
    system,
  };
}
async function directories(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
export async function collectLocalSchedules(
  now = new Date(),
  home = homedir(),
) {
  const jobs: ScheduledJob[] = [],
    sources: ScheduleSource[] = [];
  const addSource = (id: string, name: string, location: string) => {
    const source: ScheduleSource = {
      id,
      name,
      location,
      status: "ok",
      message: "",
      count: 0,
    };
    sources.push(source);
    return source;
  };
  const cron = addSource(
    "mac-crontab",
    "Crontab",
    "Deze Mac · huidige gebruiker",
  );
  try {
    const result = await exec("/usr/bin/crontab", ["-l"], {
      timeout: 5000,
      maxBuffer: 1_000_000,
    });
    jobs.push(...parseCrontab(result.stdout, cron.id, "crontab -l", now));
  } catch (e: any) {
    if (!/no crontab/i.test(String(e.stderr))) {
      cron.status = "error";
      cron.message = "Crontab kon niet worden gelezen.";
    }
  }
  const systemCron = addSource(
    "system-cron",
    "Systeemcrontab",
    "Deze Mac · /etc/crontab en /etc/cron.d",
  );
  try {
    const paths = [
      "/etc/crontab",
      ...(await directories("/etc/cron.d"))
        .filter((x) => x.isFile())
        .map((x) => join("/etc/cron.d", x.name)),
    ];
    for (const path of paths)
      if (existsSync(path))
        jobs.push(
          ...parseCrontab(
            await readFile(path, "utf8"),
            systemCron.id,
            path,
            now,
            true,
          ),
        );
    systemCron.message =
      "Leesbare systeemcrontabs. Afzonderlijke crontabs van andere gebruikers vereisen hun toegang.";
    systemCron.status = "partial";
  } catch {
    systemCron.status = "error";
    systemCron.message = "Systeemcrontabs zijn niet leesbaar.";
  }
  let loaded = new Map<string, { running: boolean; exit: number }>();
  let userDisabled = "",
    systemDisabled = "";
  const uid = process.getuid?.() ?? 0;
  const controls = await Promise.allSettled([
    exec("/bin/launchctl", ["list"], { timeout: 5000 }),
    exec("/bin/launchctl", ["print-disabled", `gui/${uid}`], { timeout: 5000 }),
    exec("/bin/launchctl", ["print-disabled", "system"], { timeout: 5000 }),
  ]);
  if (controls[0].status === "fulfilled")
    loaded = new Map(
      controls[0].value.stdout
        .split("\n")
        .slice(1)
        .flatMap((line) => {
          const [pid, code, label] = line.trim().split(/\s+/);
          return label
            ? [[label, { running: pid !== "-", exit: Number(code) }] as const]
            : [];
        }),
    );
  if (controls[1].status === "fulfilled")
    userDisabled = controls[1].value.stdout;
  if (controls[2].status === "fulfilled")
    systemDisabled = controls[2].value.stdout;
  for (const [path, title] of [
    [join(home, "Library/LaunchAgents"), "Mac · eigen achtergrondtaken"],
    ["/Library/LaunchAgents", "Mac · geïnstalleerde apps"],
    ["/Library/LaunchDaemons", "Mac · systeemdiensten"],
    ["/System/Library/LaunchAgents", "macOS · geplande taken"],
    ["/System/Library/LaunchDaemons", "macOS · geplande systeemdiensten"],
  ]) {
    const source = addSource(identity(path), title, path);
    try {
      const files = (await directories(path)).filter(
        (x) => x.isFile() && x.name.endsWith(".plist"),
      );
      await mapLimit(files, 6, async (file) => {
        const origin = join(path, file.name);
        try {
          if ((await stat(origin)).size > 1_000_000) throw new Error("large");
          const raw = await readFile(origin);
          if (
            !raw.subarray(0, 6).equals(Buffer.from("bplist")) &&
            !/StartCalendarInterval|StartInterval|KeepAlive|RunAtLoad|WatchPaths|QueueDirectories/.test(
              raw.toString(),
            )
          )
            return;
          const { stdout } = await exec(
            "/usr/bin/plutil",
            ["-convert", "json", "-o", "-", origin],
            { timeout: 4000, maxBuffer: 1_000_000 },
          );
          const plist = JSON.parse(stdout),
            job = launchdJob(plist, source.id, origin, now);
          if (!job) return;
          const override = (
            path.includes("LaunchDaemons") ? systemDisabled : userDisabled
          )
            .split("\n")
            .find((line) => line.includes(`"${plist.Label}"`));
          const disabled = override
            ? /=>\s*true/.test(override)
            : plist.Disabled === true;
          let state = loaded.get(plist.Label);
          if (!state && path.includes("LaunchDaemons")) {
            try {
              const { stdout: service } = await exec(
                "/bin/launchctl",
                ["print", `system/${plist.Label}`],
                { timeout: 2500, maxBuffer: 500000 },
              );
              state = {
                running: /state = running/.test(service),
                exit: Number(
                  service.match(/last exit code = (-?\d+)/)?.[1] || 0,
                ),
              };
            } catch {}
          }
          job.status = disabled
            ? "paused"
            : job.issue || (state && state.exit !== 0 && !state.running)
              ? "error"
              : state
                ? "enabled"
                : "unknown";
          if (state)
            job.lastResult = state.running
              ? "Proces draait op dit moment"
              : `Laatst gemelde afsluitcode: ${state.exit}`;
          else if (!disabled)
            job.issue ||=
              "Configuratie gevonden; niet als geladen taak bevestigd.";
          if (disabled) delete job.nextRunAt;
          jobs.push(job);
        } catch {
          source.status = "partial";
          source.message =
            "Niet alle configuratiebestanden konden worden gelezen.";
        }
      });
    } catch {
      source.status = "error";
      source.message = "Deze map is niet toegankelijk.";
    }
  }
  const codexDir = join(
    process.env.CODEX_HOME || join(home, ".codex"),
    "automations",
  );
  const codex = addSource(
    "codex-automations",
    "Codex · lokale automatiseringen",
    codexDir,
  );
  try {
    for (const entry of await directories(codexDir)) {
      if (!entry.isDirectory()) continue;
      const origin = join(codexDir, entry.name, "automation.toml");
      try {
        const value = parseToml(await readFile(origin, "utf8")) as any;
        const status = value.status === "ACTIVE" ? "enabled" : "paused";
        let nextRunAt: string | undefined;
        try {
          if (status === "enabled" && value.rrule)
            nextRunAt = nextAutomationRule(
              value.rrule,
              value.timezone || localZone(),
              now,
            );
        } catch {}
        jobs.push({
          id: identity(origin),
          sourceId: codex.id,
          title: clean(value.name || entry.name),
          kind: "scheduled",
          status,
          schedule: clean(value.rrule || "Schema niet gevonden"),
          timezone: value.timezone || localZone(),
          nextRunAt,
          ...(!nextRunAt && status === "enabled"
            ? { nextRunLabel: "Het exacte tijdstip staat in Codex" }
            : {}),
          origin,
          description:
            "Lokale Codex-automatisering. Laatste uitvoering is niet in dit configuratiebestand bevestigd.",
        });
      } catch {
        codex.status = "partial";
        codex.message = "Een automatisering kon niet worden gelezen.";
      }
    }
  } catch {
    codex.status = "error";
    codex.message = "Automatiseringen zijn niet leesbaar.";
  }
  const claudeDir = join(
    process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
    "scheduled-tasks",
  );
  const claude = addSource(
    "claude-schedules",
    "Claude · lokale terugkerende taken",
    claudeDir,
  );
  try {
    for (const entry of await directories(claudeDir)) {
      if (!entry.isDirectory()) continue;
      jobs.push({
        id: identity(join(claudeDir, entry.name)),
        sourceId: claude.id,
        title: entry.name,
        kind: "scheduled",
        status: "unknown",
        schedule: "Bekijk de planning in Claude",
        timezone: localZone(),
        origin: join(claudeDir, entry.name, "SKILL.md"),
        description:
          "Lokale taakmap gevonden. De map alleen bevestigt niet of de taak nog is ingeschakeld.",
        issue:
          "Actuele planning en status zijn niet beschikbaar via de taakmap.",
      });
    }
    claude.status = "partial";
    claude.message =
      "Lokale taakmappen gecontroleerd. Cloudroutines en tijdelijke /loop-taken zijn alleen in Claude zelf op te vragen.";
  } catch {
    claude.status = "error";
    claude.message = "Claude-taakmappen zijn niet leesbaar.";
  }
  for (const source of sources)
    source.count = jobs.filter((x) => x.sourceId === source.id).length;
  return { jobs, sources };
}
