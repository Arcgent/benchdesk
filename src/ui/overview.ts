import { t as tr } from "../shared/i18n";
import { availableToday } from "../shared/task-schedule";
import type { Project, Session, Snapshot, Task } from "../shared/types";
import { isBlocked, taskOrder } from "./primitives";

export function localDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function projectOverview(project: Project, snap: Snapshot) {
  const tasks = snap.tasks.filter(
    (t) => t.projectId === project.id && t.companyId === project.companyId,
  );
  const open = tasks.filter((t) => t.status !== "done");
  const done = tasks.length - open.length;
  const status = !tasks.length
    ? "empty"
    : !open.length
      ? "done"
      : open.some((t) => t.status === "review")
        ? "review"
        : open.every((t) => isBlocked(t, snap))
          ? "blocked"
          : "active";
  const deadlines =
    status === "done"
      ? []
      : [project.dueDate, ...open.map((t) => t.dueDate)].filter(Boolean).sort();
  return { total: tasks.length, done, status, deadline: deadlines[0] || "" };
}

export type AttentionItem = {
  task?: Task;
  session?: Session;
  kind: "review" | "waiting" | "blocked";
};
const recent = (s: Session) =>
  [s.updatedAt, s.memory?.updatedAt || "", s.createdAt].sort().at(-1)!;

export function todayOverview(
  snap: Snapshot,
  companyId: string,
  day = localDay(),
) {
  const tasks = taskOrder(
    snap.tasks.filter((t) => t.companyId === companyId && t.status !== "done"),
  );
  const sessions = snap.sessions.filter(
    (s) => s.companyId === companyId && (!s.purpose || s.purpose === "work"),
  );
  const attention: AttentionItem[] = [];
  const assigned = new Set<string>();
  for (const task of tasks.filter((t) => t.status === "review")) {
    attention.push({ task, kind: "review" });
    assigned.add(task.id);
  }
  for (const session of [...sessions].sort((a, b) =>
    recent(b).localeCompare(recent(a)),
  )) {
    if (
      !session.alive ||
      session.state !== "waiting" ||
      (session.taskId && assigned.has(session.taskId))
    )
      continue;
    const task = tasks.find((t) => t.id === session.taskId);
    attention.push({ task, session, kind: "waiting" });
    if (session.taskId) assigned.add(session.taskId);
  }
  for (const task of tasks.filter(
    (t) => !assigned.has(t.id) && isBlocked(t, snap),
  )) {
    attention.push({ task, kind: "blocked" });
    assigned.add(task.id);
  }

  // Prefer a live session within the same conversation; otherwise keep its latest checkpoint.
  const ordered = [...sessions].sort(
    (a, b) =>
      Number(!!b.alive) - Number(!!a.alive) ||
      recent(b).localeCompare(recent(a)),
  );
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const threads = new Set<string>();
  const taskIds = new Set(assigned);
  const candidates: Session[] = [];
  for (const session of ordered) {
    if (
      (session.alive && session.state === "waiting") ||
      (session.taskId && taskIds.has(session.taskId))
    )
      continue;
    if (snap.tasks.some((t) => t.id === session.taskId && t.status === "done"))
      continue;
    let root = session;
    const visited = new Set<string>();
    while (
      root.resumeFrom &&
      byId.has(root.resumeFrom) &&
      !visited.has(root.id)
    ) {
      visited.add(root.id);
      root = byId.get(root.resumeFrom)!;
    }
    const key = `${session.provider}:${session.accountConfigDir || ""}:${session.providerSessionId || root.id}`;
    if (threads.has(key)) continue;
    threads.add(key);
    candidates.push(session);
    if (session.taskId) taskIds.add(session.taskId);
  }
  const continuing = candidates
    .sort((a, b) => recent(b).localeCompare(recent(a)))
    .slice(0, 3);
  const continuedTasks = new Set(continuing.map((s) => s.taskId));
  const due = tasks.filter((t) => t.dueDate && t.dueDate <= day);
  const planned = due
    .filter((t) => !assigned.has(t.id) && !continuedTasks.has(t.id))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.rank - b.rank);
  return {
    attention,
    continuing,
    planned,
    dueCount: due.length,
    taskCount: tasks.length,
    waitingTaskCount: attention.filter((a) => a.task).length,
    activeCount: sessions.filter((s) => s.alive).length,
  };
}

// A stopped or explicitly closed conversation belongs to History, also on Today.
export function todayProOverview(
  snap: Snapshot,
  companyId: string,
  closedIds: string[] = [],
  day = localDay(),
) {
  const tasks = taskOrder(
    snap.tasks.filter(
      (t) => t.companyId === companyId && availableToday(t, day),
    ),
  );
  const sessions = snap.sessions.filter(
    (s) =>
      s.companyId === companyId &&
      s.alive &&
      !closedIds.includes(s.id) &&
      (!s.purpose || s.purpose === "work"),
  );
  const attention: AttentionItem[] = [];
  const assigned = new Set<string>();
  for (const task of tasks.filter((t) => t.status === "review")) {
    attention.push({ task, kind: "review" });
    assigned.add(task.id);
  }
  for (const session of [...sessions].sort((a, b) =>
    recent(b).localeCompare(recent(a)),
  )) {
    if (
      session.state !== "waiting" ||
      (session.taskId && assigned.has(session.taskId))
    )
      continue;
    const task = tasks.find((t) => t.id === session.taskId);
    if (session.taskId && (!task || task.status === "done")) continue;
    attention.push({ task, session, kind: "waiting" });
    if (task) assigned.add(task.id);
  }
  for (const task of tasks.filter(
    (t) => t.status !== "done" && !assigned.has(t.id) && isBlocked(t, snap),
  )) {
    attention.push({ task, kind: "blocked" });
    assigned.add(task.id);
  }
  const continuing = sessions
    .filter(
      (s) =>
        s.state !== "waiting" &&
        (!s.taskId ||
          (!assigned.has(s.taskId) &&
            tasks.some((t) => t.id === s.taskId && t.status !== "done"))),
    )
    .sort((a, b) => recent(b).localeCompare(recent(a)));
  const continued = new Set(continuing.map((s) => s.taskId));
  const planned = tasks
    .filter(
      (t) =>
        !assigned.has(t.id) &&
        !continued.has(t.id) &&
        (t.status !== "done" || localDay(new Date(t.updatedAt)) === day),
    )
    .sort(
      (a, b) =>
        Number(a.status === "done") - Number(b.status === "done") ||
        (a.dueDate || "9999").localeCompare(b.dueDate || "9999") ||
        a.rank - b.rank,
    );
  return { attention, continuing, planned, activeCount: sessions.length };
}

// ---- Rustig helpers: pure and node-safe (tests/overview.test.ts) ----
// Pending proposals other than the "three suggestions" block wait for the owner too.
export const waitingProposals = (snap: Snapshot, companyId: string) =>
  snap.proposals.filter(
    (p) =>
      p.companyId === companyId &&
      p.status === "pending" &&
      p.kind !== "suggestions",
  );

// One count for the page and the sidebar badge, so they can never disagree.
// `checks` carries optimistic task checks (task id → done) the snapshot has not confirmed yet.
export function todayCounts(
  snap: Snapshot,
  companyId: string,
  closedIds: string[] = [],
  day = localDay(),
  checks: Record<string, boolean> = {},
) {
  const { attention, planned } = todayProOverview(
    snap,
    companyId,
    closedIds,
    day,
  );
  const waiting = attention.length + waitingProposals(snap, companyId).length;
  const openPlanned = planned.filter(
    (t) => !(checks[t.id] ?? t.status === "done"),
  ).length;
  return {
    waiting,
    openPlanned,
    planned: planned.length,
    badge: waiting + openPlanned,
  };
}

// The headline is two sentences with their own keys: the second one is conditional.
// It only names a project the data backs, and "Alles loopt." only when something really runs.
export function todayHeadline(
  snap: Snapshot,
  attention: AttentionItem[],
  proposals = 0,
  activeCount = 0,
) {
  const count = attention.length + proposals;
  const approvals =
    !proposals && attention.every((a) => a.kind === "review" && a.task);
  const first = !count
    ? tr("Niets wacht op jou.")
    : approvals
      ? count === 1
        ? tr("Eén taak wacht op je akkoord.")
        : tr("{0} taken wachten op je akkoord.", count)
      : count === 1
        ? tr("Eén actie wacht op jou.")
        : tr("{0} acties wachten op jou.", count);
  const projectIds = new Set(attention.map((a) => a.task?.projectId || ""));
  const project =
    count && !proposals && projectIds.size === 1
      ? snap.projects.find((p) => projectIds.has(p.id))
      : undefined;
  const second = !count
    ? activeCount > 0
      ? tr("Alles loopt.")
      : ""
    : project
      ? tr("Daarna loopt {0} door.", project.name)
      : "";
  return { count, first, second, text: second ? `${first} ${second}` : first };
}

export const greetingPart = (hour: number) =>
  hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
export function greeting(hour: number, name = "") {
  const part = greetingPart(hour),
    first = name.trim().split(/\s+/)[0];
  if (!first)
    return part === "morning"
      ? tr("Goedemorgen")
      : part === "afternoon"
        ? tr("Goedemiddag")
        : tr("Goedenavond");
  return part === "morning"
    ? tr("Goedemorgen, {0}", first)
    : part === "afternoon"
      ? tr("Goedemiddag, {0}", first)
      : tr("Goedenavond, {0}", first);
}

// Bell + company switcher: what waits for the owner per company, from the same sources as Today's "Wacht op jou"
// (so `count` equals todayCounts(...).waiting for that company). Companies with nothing waiting are left out.
export function waitingByCompany(
  snap: Snapshot,
  closedIds: string[] = [],
  day = localDay(),
) {
  return snap.companies
    .map((company) => {
      const attention = todayProOverview(
          snap,
          company.id,
          closedIds,
          day,
        ).attention,
        proposals = waitingProposals(snap, company.id);
      return {
        company,
        attention,
        proposals,
        count: attention.length + proposals.length,
      };
    })
    .filter((group) => group.count > 0);
}
