import test from "node:test";
import assert from "node:assert/strict";
import {
  projectInput,
  taskInput,
  type Snapshot,
  type Session,
} from "../src/shared/types";
import {
  greeting,
  greetingPart,
  localDay,
  projectOverview,
  todayCounts,
  todayHeadline,
  todayOverview,
  todayProOverview,
  waitingByCompany,
} from "../src/ui/overview";
import { setLanguage } from "../src/shared/i18n";

const stamp = "2026-09-16T10:00:00.000Z";
const project = {
  ...projectInput.parse({
    companyId: "a",
    name: "Cold email",
    dueDate: "2026-10-01",
  }),
  id: "p",
  createdAt: stamp,
};
function task(id: string, patch = {}) {
  return {
    ...taskInput.parse({ companyId: "a", projectId: "p", title: id, ...patch }),
    id,
    rank: 0,
    priorityReason: "",
    priorityEvidence: [],
    confidence: "",
    resultSummary: "",
    createdAt: stamp,
    updatedAt: stamp,
  };
}
function session(id: string, patch: Partial<Session> = {}): Session {
  return {
    id,
    companyId: "a",
    taskId: null,
    provider: "codex",
    mode: "work",
    state: "idle",
    providerSessionId: null,
    cwd: "/tmp",
    outputDir: "/tmp",
    createdAt: stamp,
    updatedAt: stamp,
    error: "",
    alive: true,
    ...patch,
  };
}
const snapshot = (patch: Partial<Snapshot> = {}): Snapshot => ({
  companies: [],
  departments: [],
  projects: [project],
  tasks: [],
  sessions: [],
  events: [],
  goals: [],
  artifacts: [],
  proposals: [],
  checkins: [],
  ...patch,
});

test("project rows derive progress and earliest outstanding deadline, including overdue work", () => {
  const snap = snapshot({
    tasks: [
      task("done", { status: "done", dueDate: "2026-01-01" }),
      task("open", { dueDate: "2026-09-20" }),
      task("late", { dueDate: "2026-09-12" }),
      task("foreign", { companyId: "b", dueDate: "2026-02-01" }),
    ],
  });
  assert.deepEqual(projectOverview(project, snap), {
    total: 3,
    done: 1,
    status: "active",
    deadline: "2026-09-12",
  });
  snap.tasks = snap.tasks.map((t) => ({ ...t, status: "done" }));
  assert.deepEqual(projectOverview(project, snap), {
    total: 3,
    done: 3,
    status: "done",
    deadline: "",
  });
  assert.deepEqual(projectOverview({ ...project, dueDate: "" }, snapshot()), {
    total: 0,
    done: 0,
    status: "empty",
    deadline: "",
  });
  assert.equal(
    projectOverview(
      project,
      snapshot({ tasks: [task("review", { status: "review" })] }),
    ).status,
    "review",
  );
  assert.equal(
    projectOverview(
      project,
      snapshot({ tasks: [task("blocked", { dependencies: ["unfinished"] })] }),
    ).status,
    "blocked",
  );
});

test("today separates attention, continuation and today's deadlines without duplicate tasks", () => {
  const snap = snapshot({
    tasks: [
      task("review", { status: "review", dueDate: "2026-09-16" }),
      task("blocked", { dependencies: ["review"], dueDate: "2026-09-16" }),
      task("continue", { dueDate: "2026-09-16" }),
      task("today", { dueDate: "2026-09-16" }),
      task("late", { dueDate: "2026-09-15" }),
      task("future", { dueDate: "2026-09-17" }),
      task("unscheduled"),
      task("done", { status: "done", dueDate: "2026-09-16" }),
      task("foreign", { companyId: "b", status: "review" }),
    ],
    sessions: [
      session("review-session", { taskId: "review", state: "waiting" }),
      session("continue-session", { taskId: "continue" }),
      session("login", { purpose: "login" }),
      session("foreign-session", { companyId: "b", state: "waiting" }),
      session("done-session", { taskId: "done", alive: false }),
    ],
  });
  const result = todayOverview(snap, "a", "2026-09-16");
  assert.deepEqual(
    result.attention.map((a) => a.task?.id),
    ["review", "blocked"],
  );
  assert.deepEqual(
    result.continuing.map((s) => s.id),
    ["continue-session"],
  );
  assert.deepEqual(
    result.planned.map((t) => t.id),
    ["late", "today"],
  );
  assert.equal(result.waitingTaskCount, 2);
  assert.equal(result.activeCount, 2);
});

test("waiting terminals are actionable even without a task; ended waiting sessions aren't current requests", () => {
  const snap = snapshot({
    sessions: [
      session("live", { state: "waiting" }),
      session("ended", { state: "waiting", alive: false }),
    ],
  });
  const result = todayOverview(snap, "a", "2026-09-16");
  assert.deepEqual(
    result.attention.map((a) => a.session?.id),
    ["live"],
  );
  assert.deepEqual(
    result.continuing.map((s) => s.id),
    ["ended"],
  );
  assert.equal(result.waitingTaskCount, 0);
});

test("continuation groups resumed conversations and preserves separate account threads", () => {
  const snap = snapshot({
    sessions: [
      session("old", { alive: false, providerSessionId: "thread" }),
      session("new", {
        alive: false,
        providerSessionId: "thread",
        resumeFrom: "old",
        updatedAt: "2026-09-16T11:00:00.000Z",
      }),
      session("other-account", {
        alive: false,
        providerSessionId: "thread",
        accountConfigDir: "/other-account",
      }),
      session("auth", { purpose: "login" }),
    ],
  });
  assert.deepEqual(
    todayOverview(snap, "a").continuing.map((s) => s.id),
    ["new", "other-account"],
  );
  snap.sessions[0].alive = true;
  assert.ok(todayOverview(snap, "a").continuing.some((s) => s.id === "old"));
  assert.ok(!todayOverview(snap, "a").continuing.some((s) => s.id === "new"));
  assert.equal(localDay(new Date(2026, 8, 16, 23, 59)), "2026-09-16");
});

test("Today Pro separates waiting, live conversations and scheduled work without reviving history", () => {
  const snap = snapshot({
    tasks: [
      task("review", { status: "review" }),
      task("blocked", { dependencies: ["review"] }),
      task("daily", { recurrence: "daily", scheduledDate: "2026-09-16" }),
      task("later", { scheduledDate: "2026-09-17" }),
      task("ongoing", { status: "in_progress" }),
      task("stopped", { status: "in_progress" }),
      task("answer"),
    ],
    sessions: [
      session("live", { taskId: "ongoing" }),
      session("old", { taskId: "stopped", alive: false }),
      session("hidden"),
      session("waiting", { taskId: "answer", state: "waiting" }),
      session("review-waiting", { taskId: "review", state: "waiting" }),
      session("login", { purpose: "login" }),
    ],
  });
  const v = todayProOverview(snap, "a", ["hidden"], "2026-09-16");
  assert.deepEqual(
    v.attention.map((a) => a.task?.id),
    ["review", "answer", "blocked"],
  );
  assert.deepEqual(
    v.continuing.map((s) => s.id),
    ["live"],
  );
  assert.deepEqual(
    v.planned.map((t) => t.id),
    ["daily", "stopped"],
  );
  assert.equal(v.activeCount, 3);
});

test("Today Pro shows today's completions and available recurring work, excluding other companies and future tasks", () => {
  const snap = snapshot({
    tasks: [
      task("today-done", { status: "done" }),
      {
        ...task("old-done", { status: "done" }),
        updatedAt: "2026-09-14T12:00:00.000Z",
      },
      task("future-review", { status: "review", scheduledDate: "2026-09-20" }),
      task("weekly", { recurrence: "weekly", scheduledDate: "2026-09-16" }),
      task("other", { companyId: "b" }),
      task("overdue", { dueDate: "2026-09-01" }),
    ],
    sessions: [
      session("foreign", { companyId: "b" }),
      session("future", { taskId: "future-review" }),
    ],
  });
  const v = todayProOverview(snap, "a", [], "2026-09-16");
  assert.deepEqual(
    v.planned.map((t) => t.id),
    ["overdue", "weekly", "today-done"],
  );
  assert.equal(v.attention.length, 0);
  assert.equal(v.continuing.length, 0);
});

const proposal = (id: string, patch = {}) => ({
  id,
  companyId: "a",
  sessionId: "s",
  kind: "priorities" as const,
  payload: {},
  basisRevision: 1,
  status: "pending",
  createdAt: stamp,
  ...patch,
});

test("todayCounts gives the page and the sidebar badge one number, including optimistic checks", () => {
  const snap = snapshot({
    tasks: [
      task("review", { status: "review" }),
      task("open-1"),
      task("open-2"),
      task("done-today", { status: "done" }),
      task("later", { scheduledDate: "2026-09-20" }),
      task("elsewhere", { companyId: "b" }),
    ],
    sessions: [session("asks", { state: "waiting" })],
    proposals: [
      proposal("priorities"),
      proposal("suggestions", { kind: "suggestions" }),
      proposal("decided", { status: "accepted" }),
      proposal("foreign", { companyId: "b" }),
    ],
  });
  const counts = todayCounts(snap, "a", [], "2026-09-16");
  assert.deepEqual(counts, {
    waiting: 3, // review task + waiting conversation + one pending proposal
    openPlanned: 2,
    planned: 3,
    badge: 5,
  });
  const page = todayProOverview(snap, "a", [], "2026-09-16");
  assert.equal(
    counts.openPlanned,
    page.planned.filter((t) => t.status !== "done").length,
    "same source as the page",
  );
  assert.equal(
    todayCounts(snap, "a", ["asks"], "2026-09-16").waiting,
    2,
    "a conversation closed on the canvas no longer waits on Today",
  );
  const optimistic = todayCounts(snap, "a", [], "2026-09-16", {
    "open-1": true,
    "done-today": false,
  });
  assert.equal(optimistic.openPlanned, 2, "one checked, one reopened");
  assert.equal(
    todayCounts(snap, "a", [], "2026-09-16", { "open-1": true }).badge,
    4,
    "the badge drops the moment the check is clicked",
  );
  assert.deepEqual(todayCounts(snapshot(), "a", [], "2026-09-16"), {
    waiting: 0,
    openPlanned: 0,
    planned: 0,
    badge: 0,
  });
});

test("todayHeadline only says what the data backs", () => {
  const other = { ...project, id: "q", name: "Website" };
  const snap = snapshot({ projects: [project, other] });
  const review = (id: string, projectId = "p") => ({
    task: task(id, { status: "review", projectId }),
    kind: "review" as const,
  });
  assert.deepEqual(todayHeadline(snap, [], 0, 2), {
    count: 0,
    first: "Niets wacht op jou.",
    second: "Alles loopt.",
    text: "Niets wacht op jou. Alles loopt.",
  });
  assert.equal(
    todayHeadline(snap, [], 0, 0).text,
    "Niets wacht op jou.",
    'no running conversation, so no "Alles loopt."',
  );
  assert.equal(
    todayHeadline(snap, [review("one")], 0, 1).text,
    "Eén taak wacht op je akkoord. Daarna loopt Cold email door.",
  );
  const two = todayHeadline(snap, [review("one"), review("two")]);
  assert.equal(two.first, "2 taken wachten op je akkoord.");
  assert.equal(two.second, "Daarna loopt Cold email door.");
  assert.equal(
    todayHeadline(snap, [review("one"), review("two", "q")]).text,
    "2 taken wachten op je akkoord.",
    "two projects: no project is named",
  );
  assert.equal(
    todayHeadline(snap, [review("one", "gone")]).text,
    "Eén taak wacht op je akkoord.",
    "an unknown project is not named",
  );
  assert.equal(
    todayHeadline(snap, [
      review("one"),
      { task: task("stuck", { status: "blocked" }), kind: "blocked" },
    ]).text,
    "2 acties wachten op jou. Daarna loopt Cold email door.",
    '"akkoord" is only used when every item is a review',
  );
  assert.equal(
    todayHeadline(snap, [{ session: session("asks"), kind: "waiting" }]).text,
    "Eén actie wacht op jou.",
  );
  assert.equal(
    todayHeadline(snap, [review("one")], 1).text,
    "2 acties wachten op jou.",
    "proposals count, and they are not about the project",
  );
  assert.equal(todayHeadline(snap, [], 1).text, "Eén actie wacht op jou.");
});

test("greeting follows the local hour and the first name", () => {
  assert.deepEqual([0, 11, 12, 17, 18, 23].map(greetingPart), [
    "morning",
    "morning",
    "afternoon",
    "afternoon",
    "evening",
    "evening",
  ]);
  assert.equal(greeting(9, "Jasper Post"), "Goedemorgen, Jasper");
  assert.equal(greeting(13, "  Jasper  "), "Goedemiddag, Jasper");
  assert.equal(greeting(20, ""), "Goedenavond");
  assert.equal(greeting(8), "Goedemorgen");
});

test("waitingByCompany: the bell and the switcher count what Today shows, per company, and skip quiet companies", () => {
  const company = (id: string) =>
    ({ id, name: id.toUpperCase() }) as Snapshot["companies"][number];
  const snap = snapshot({
    companies: [company("a"), company("b"), company("c")],
    tasks: [
      task("review-a", { status: "review" }),
      task("open-a"),
      task("review-b", { companyId: "b", status: "review" }),
    ],
    sessions: [
      session("asks-b", { companyId: "b", state: "waiting" }),
      session("busy-c", { companyId: "c", state: "working" }),
    ],
    proposals: [
      proposal("priorities-a"),
      proposal("suggestions-b", { companyId: "b", kind: "suggestions" }),
    ],
  });
  const groups = waitingByCompany(snap, [], "2026-09-16");
  assert.deepEqual(
    groups.map((g) => [g.company.id, g.count]),
    [
      ["a", 2],
      ["b", 2],
    ],
    "company c has a busy conversation but nothing waiting",
  );
  for (const group of groups)
    assert.equal(
      group.count,
      todayCounts(snap, group.company.id, [], "2026-09-16").waiting,
      "same number as the Today page of that company",
    );
  assert.deepEqual(
    groups[1].attention.map((item) => item.kind),
    ["review", "waiting"],
  );
  assert.equal(groups[0].proposals[0].id, "priorities-a");
  assert.deepEqual(
    waitingByCompany(snap, ["asks-b"], "2026-09-16").map((g) => g.count),
    [2, 1],
    "a conversation closed on the canvas no longer waits",
  );
  assert.deepEqual(waitingByCompany(snapshot()), []);
});

test("the new Today strings are translated once the keys land, and never break meanwhile", () => {
  setLanguage("en");
  try {
    const text = todayHeadline(snapshot(), [], 0, 0).text;
    assert.ok(text.length > 0);
    assert.ok(!text.includes("{0}"));
    assert.ok(!greeting(9, "Jasper").includes("{0}"));
  } finally {
    setLanguage("nl");
  }
});
