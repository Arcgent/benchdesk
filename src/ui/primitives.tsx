import { t as tr, locale } from "../shared/i18n";
import {
  labels,
  type Checkin,
  type Goal,
  type Project,
  type Session,
  type Snapshot,
  type Task,
} from "../shared/types";
import { localDate } from "../shared/task-schedule";
export const providerName = (provider: string) =>
  provider === "claude"
    ? "Claude Code"
    : provider === "codex"
      ? "Codex"
      : tr("Zelf doen");
// The executor as the conversation list and the pane name it ("Zelf" for your own shell).
export const assistantName = (provider: string) =>
  provider === "claude"
    ? "Claude Code"
    : provider === "codex"
      ? "Codex"
      : tr("Zelf");
export const resumable = (s: Session) =>
  s.provider !== "shell" && !!s.providerSessionId;
export const monogram = (name: string) =>
  name
    .trim()
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase() || "W";
export const shortPath = (path: string, home?: string) =>
  path
    ? "…/" + path.replace(/\/$/, "").split("/").slice(-2).join("/")
    : tr("Geen werkmap");
export function formatDate(value: string, relative = false) {
  if (!value) return tr("Geen datum");
  const d = new Date(value.length === 10 ? value + "T12:00:00" : value);
  if (Number.isNaN(d.getTime())) return tr("Geen datum");
  if (relative) {
    const today = new Date(),
      tomorrow = new Date();
    tomorrow.setDate(today.getDate() + 1);
    if (d.toDateString() === today.toDateString()) return tr("vandaag");
    if (d.toDateString() === tomorrow.toDateString()) return tr("morgen");
  }
  return d
    .toLocaleDateString(locale(), {
      weekday: "short",
      day: "numeric",
      month: "short",
    })
    .replace(/\./g, "");
}
export const formatTime = (date: string) =>
  new Date(date).toLocaleTimeString(locale(), {
    hour: "2-digit",
    minute: "2-digit",
  });
export function duration(session: Session) {
  const minutes = Math.max(
    0,
    Math.floor(
      ((session.alive ? Date.now() : new Date(session.updatedAt).getTime()) -
        new Date(session.createdAt).getTime()) /
        60000,
    ),
  );
  return minutes < 60
    ? `${minutes} min`
    : tr("{0} u {1}", Math.floor(minutes / 60), minutes % 60);
}
export const taskOrder = (tasks: Task[]) =>
  [...tasks].sort(
    (a, b) => a.rank - b.rank || a.createdAt.localeCompare(b.createdAt),
  );
export const isBlocked = (task: Task, snap: Snapshot) =>
  task.status === "blocked" ||
  (task.status !== "done" &&
    task.dependencies.some(
      (id) => snap.tasks.find((t) => t.id === id)?.status !== "done",
    ));
export const taskProvider = (task: Task) => {
  if (task.kind === "human" || task.provider === "shell") return tr("Jij");
  const provider = providerName(task.provider || "claude");
  return task.model
    ? `${provider} · ${task.model
        .replace(/^gpt-/, "GPT-")
        .replace(/-(astra|sol|luna)$/i, (_, name) =>
          ` ${name[0].toUpperCase()}${name.slice(1)}`,
        )}`
    : provider;
};
// Recurring work keeps one task (and its completion history), but each scheduled
// occurrence needs its own conversation. A session from before the current
// scheduled date belongs to an earlier occurrence.
export const sessionInCurrentOccurrence = (
  task: Pick<Task, "id" | "recurrence" | "scheduledDate">,
  session: Pick<Session, "taskId" | "createdAt">,
) =>
  session.taskId === task.id &&
  (task.recurrence === "none" ||
    !task.scheduledDate ||
    localDate(new Date(session.createdAt)) >= task.scheduledDate);
// Minimaal (Profiel → Stijl) avoids the word "Terminal" in the UI (README Copy-regels): your own conversation
// without a task is a "Vrij gesprek" there. Read from <html> so every caller of sessionTitle follows the style.
const minimalDesign = () =>
  typeof document !== "undefined" &&
  document.documentElement.dataset.design === "minimaal";
export function sessionTitle(session: Session, snap: Snapshot) {
  if (session.conversationId) {
    const c = snap.agentConversations?.find(c => c.id === session.conversationId);
    if (c) return `${c.profile.name} · ${c.title || tr("Nieuw gesprek")}`;
  }
  if (session.purpose === "login")
    return tr("Inloggen bij {0}", providerName(session.provider));
  if (session.purpose === "logout")
    return tr("Uitloggen bij {0}", providerName(session.provider));
  return (
    snap.tasks.find((t) => t.id === session.taskId)?.title ||
    (session.mode === "suggestions"
      ? tr("AI-voorstellen voor je bedrijf")
      : session.mode === "planning"
        ? tr("Prioriteitenadvies")
        : session.mode === "intake"
          ? tr("Bedrijfsintake")
          : session.provider === "shell"
            ? tr(minimalDesign() ? "Vrij gesprek" : "Terminal")
            : tr("Vrije werkruimte"))
  );
}
export function waitingSession(session: Session, snap: Snapshot) {
  if (session.state === "waiting" && session.alive) return true;
  if (snap.tasks.find((t) => t.id === session.taskId)?.status !== "review")
    return false;
  const resultSession = snap.events.find(
    (e) => e.taskId === session.taskId && e.kind === "result",
  )?.sessionId;
  if (resultSession) return resultSession === session.id;
  return (
    [...snap.sessions]
      .filter((s) => s.taskId === session.taskId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.id ===
    session.id
  );
}
export const dockSessions = (snap: Snapshot) =>
  snap.sessions
    .filter((s) => s.alive || waitingSession(s, snap))
    .sort(
      (a, b) =>
        Number(waitingSession(b, snap)) - Number(waitingSession(a, snap)) ||
        a.createdAt.localeCompare(b.createdAt),
    );
// ---- Rustig helpers: pure and node-safe (tests/ui-helpers.test.ts). Never import rz.tsx, Theme or language here. ----
export type Tone = "accent" | "blue" | "warn" | "muted" | "danger" | "text2";
export type StatusKind = "task" | "project" | "account";
// Colours are derived, never stored: every company.color in the data is the same green.
export const companyPalette = [
  "var(--accent)",
  "#3b6fd6",
  "#7c5cd6",
  "#d99a2b",
  "#c96a3a",
  "#5c9c6f",
];
export const projectPalette = ["#d99a2b", "#3b6fd6", "#7c5cd6", "#5c9c6f"];
export function companyTint(id: string, snap: Pick<Snapshot, "companies">) {
  const index = snap.companies.findIndex((c) => c.id === id);
  return companyPalette[Math.max(0, index) % companyPalette.length];
}
// Position among the company's projects by age: stable, because projects cannot be deleted.
export function projectTint(
  project: Pick<Project, "id" | "companyId">,
  snap: Pick<Snapshot, "projects">,
) {
  const index = snap.projects
    .filter((p) => p.companyId === project.companyId)
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )
    .findIndex((p) => p.id === project.id);
  return projectPalette[Math.max(0, index) % projectPalette.length];
}
const tones: Record<StatusKind, Record<string, Tone>> = {
  task: {
    todo: "muted",
    in_progress: "blue",
    blocked: "warn",
    review: "accent",
    done: "muted",
  },
  project: {
    active: "blue",
    blocked: "warn",
    review: "accent",
    done: "accent",
    empty: "muted",
  },
  account: {
    logged_in: "accent",
    logged_out: "warn",
    expired: "warn",
    unknown: "muted",
  },
};
export const statusTone = (kind: StatusKind, value: string): Tone =>
  Object.hasOwn(tones[kind], value) ? tones[kind][value] : "muted";
export function statusLabel(kind: "task" | "project", value: string) {
  if (kind === "task")
    return Object.hasOwn(labels, value)
      ? tr(labels[value as keyof typeof labels])
      : value;
  return value === "active"
    ? tr("Actief")
    : value === "blocked"
      ? tr("Geblokkeerd")
      : value === "review"
        ? tr("Wacht op jou")
        : value === "done"
          ? tr("Afgerond")
          : value === "empty"
            ? tr("Nog geen taken")
            : value;
}
export type ConversationStatus = {
  key:
    | "waiting"
    | "paused"
    | "closed"
    | "error"
    | "busy"
    | "starting"
    | "open"
    | "interrupted"
    | "unknown";
  label: string;
  tone: Tone;
};
// One vocabulary for Vandaag, the sidebar dots and the pane header. `unknown` is real
// (Codex before its hooks are approved) and must never read as "Bezig".
export function conversationStatus(
  session: Session,
  snap: Snapshot,
): ConversationStatus {
  if (waitingSession(session, snap))
    return { key: "waiting", label: tr("Wacht op jou"), tone: "accent" };
  // An agent chat only runs during a turn; in between it is ready, not paused.
  if (session.transport === "chat")
    return session.alive
      ? { key: "busy", label: tr("Bezig"), tone: "blue" }
      : session.state === "error"
        ? { key: "error", label: tr("Fout"), tone: "warn" }
        : { key: "open", label: tr("Klaar"), tone: "muted" };
  if (!session.alive)
    return session.provider !== "shell" && session.providerSessionId
      ? { key: "paused", label: tr("Gepauzeerd"), tone: "muted" }
      : { key: "closed", label: tr("Afgesloten"), tone: "muted" };
  if (session.state === "error")
    return { key: "error", label: tr("Fout"), tone: "warn" };
  if (session.provider !== "shell" && !session.agentRunning)
    return { key: "paused", label: tr("Gepauzeerd"), tone: "muted" };
  if (session.state === "working")
    return { key: "busy", label: tr("Bezig"), tone: "blue" };
  if (session.state === "starting")
    return { key: "starting", label: tr("Start…"), tone: "blue" };
  if (session.state === "interrupted")
    return { key: "interrupted", label: tr("Onderbroken"), tone: "muted" };
  if (session.state === "unknown")
    return { key: "unknown", label: tr("Status onbekend"), tone: "muted" };
  if (session.state === "ended")
    return { key: "closed", label: tr("Afgesloten"), tone: "muted" };
  return { key: "open", label: tr("Open"), tone: "muted" };
}
// "30 sep": day and month without the weekday formatDate adds.
export function formatDayMonth(value: string) {
  if (!value) return "";
  const d = new Date(value.length === 10 ? value + "T12:00:00" : value);
  if (Number.isNaN(d.getTime())) return "";
  return d
    .toLocaleDateString(locale(), { day: "numeric", month: "short" })
    .replace(/\./g, "");
}
// Usage bars show what is LEFT. Boundaries are strict: exactly 50 is warn, exactly 20 is danger.
export const remainingTone = (pct: number): Tone =>
  pct > 50 ? "accent" : pct > 20 ? "warn" : "danger";
export const goalPct = (goal: Pick<Goal, "baseline" | "current" | "target">) =>
  goal.target === goal.baseline
    ? goal.current === goal.target
      ? 100
      : 0
    : Math.max(
        0,
        Math.min(
          100,
          (100 * (goal.current - goal.baseline)) /
            (goal.target - goal.baseline),
        ),
      );
const dayNumber = (day: string) => Date.parse(`${day}T12:00:00Z`) / 86400000;
// Goals have no start date, so "behind" is only claimed when it can be shown: the deadline passed
// without reaching the target, or progress is below the straight line from the first check-in to the deadline.
export function goalBehind(goal: Goal, checkins: Checkin[], day = localDate()) {
  if (!goal.dueDate || goalPct(goal) >= 100) return false;
  if (goal.dueDate < day) return true;
  const first = checkins
    .flatMap((c) =>
      (c.measurements || [])
        .filter((m) => m.goalId === goal.id)
        .map((m) => ({ at: c.createdAt, value: m.before })),
    )
    .sort((a, b) => a.at.localeCompare(b.at))[0];
  if (!first || goal.target === first.value) return false;
  const start = dayNumber(localDate(new Date(first.at))),
    end = dayNumber(goal.dueDate),
    now = dayNumber(day);
  if (end <= start || now <= start) return false;
  return (
    (goal.current - first.value) / (goal.target - first.value) + 1e-9 <
    (now - start) / (end - start)
  );
}
// One reading of a goal for Vandaag and Je bedrijf, so both screens always agree.
export function goalView(
  goal: Goal,
  snap: Pick<Snapshot, "projects">,
  checkins: Checkin[],
  day = localDate(),
) {
  const money = goal.unit.trim() === "€",
    unit = money ? "" : goal.unit.trim(),
    number = (value: number) =>
      (money ? "€" : "") + value.toLocaleString(locale()),
    lower = goal.target < goal.baseline,
    pct = goalPct(goal),
    projects = snap.projects.filter(
      (p) => p.companyId === goal.companyId && p.goalId === goal.id,
    ).length;
  return {
    title: goal.title,
    primary: goal.primary,
    label: goal.primary
      ? tr("Belangrijkste doel")
      : goal.metric.trim() || unit || tr("Doel"),
    big: [number(goal.current), lower ? unit : ""].filter(Boolean).join(" "),
    sub: lower
      ? tr("nu · doel {0}", number(goal.target))
      : tr("van {0}", [number(goal.target), unit].filter(Boolean).join(" ")),
    pct,
    tone: (goalBehind(goal, checkins, day) ? "warn" : "accent") as Tone,
    meta:
      projects === 0
        ? tr("Nog geen project gekoppeld")
        : projects === 1
          ? tr("1 project draagt bij")
          : tr("{0} projecten dragen bij", projects),
    due: goal.dueDate ? tr("tot {0}", formatDayMonth(goal.dueDate)) : "",
    late: !!goal.dueDate && goal.dueDate < day && pct < 100,
    measurable: goal.target !== goal.baseline,
    projects,
  };
}
