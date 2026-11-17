import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setLanguage } from "../src/shared/i18n";
import {
  goalInput,
  projectInput,
  taskInput,
  type Checkin,
  type Company,
  type Goal,
  type Session,
  type Snapshot,
} from "../src/shared/types";
import {
  companyPalette,
  companyTint,
  conversationStatus,
  formatDayMonth,
  goalBehind,
  goalPct,
  goalView,
  projectPalette,
  projectTint,
  remainingTone,
  sessionInCurrentOccurrence,
  statusLabel,
  statusTone,
} from "../src/ui/primitives";
import {
  attachFilesBeforeStart,
  createComposerDraftStore,
} from "../src/ui/task-composer-state";
import { exportBackup } from "../src/ui/settings-actions";

test("composer drafts stay isolated by company and screen", () => {
  const drafts = createComposerDraftStore();
  drafts.set("today:a", { draft: "Taak voor A", files: ["/a.md"] });
  drafts.set("today:b", { draft: "Taak voor B", files: [] });
  assert.deepEqual(drafts.get("today:a"), {
    draft: "Taak voor A",
    files: ["/a.md"],
  });
  assert.deepEqual(drafts.get("today:b"), {
    draft: "Taak voor B",
    files: [],
  });
  assert.deepEqual(drafts.get("project:a:p"), { draft: "", files: [] });
});

test("failed attachments remain retryable before an assistant starts", async () => {
  const attempted: string[] = [];
  const result = await attachFilesBeforeStart(
    ["/ok.md", "/missing.md"],
    async (path) => {
      attempted.push(path);
      if (path.includes("missing")) throw new Error("Bestand ontbreekt");
    },
  );
  assert.deepEqual(attempted, ["/ok.md", "/missing.md"]);
  assert.deepEqual(result, {
    failedFiles: ["/missing.md"],
    problems: ["Bestand ontbreekt"],
  });
});

test("cancelled backup export does not announce success", async () => {
  let successes = 0;
  assert.equal(
    await exportBackup(
      async () => null,
      () => successes++,
    ),
    null,
  );
  assert.equal(successes, 0);
  assert.equal(
    await exportBackup(
      async () => "/tmp/backup.json",
      () => successes++,
    ),
    "/tmp/backup.json",
  );
  assert.equal(successes, 1);
});

const stamp = "2026-09-16T10:00:00.000Z";
const company = (id: string): Company => ({
  id,
  name: id,
  workspacePath: "/tmp",
  color: "#4fd98a",
  product: "",
  audience: "",
  stage: "",
  bottleneck: "",
  sources: [],
  revision: 1,
  createdAt: stamp,
  updatedAt: stamp,
  lastCheckinAt: "",
});
const project = (id: string, createdAt: string, patch = {}) => ({
  ...projectInput.parse({ companyId: "a", name: id, ...patch }),
  id,
  createdAt,
});
const goal = (patch = {}): Goal => ({
  ...goalInput.parse({ companyId: "a", title: "Klantgesprekken", ...patch }),
  id: "g",
  updatedAt: stamp,
});
const checkin = (
  createdAt: string,
  before: number,
  after: number,
): Checkin => ({
  id: createdAt,
  companyId: "a",
  note: "",
  createdAt,
  measurements: [{ goalId: "g", title: "", before, after, unit: "" }],
});
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
const session = (patch: Partial<Session> = {}): Session => ({
  id: "s",
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
  agentRunning: true,
  ...patch,
});
const snapshot = (patch: Partial<Snapshot> = {}): Snapshot => ({
  companies: [],
  departments: [],
  projects: [],
  tasks: [],
  sessions: [],
  events: [],
  goals: [],
  artifacts: [],
  proposals: [],
  checkins: [],
  ...patch,
});

test("recurring tasks only reopen a conversation from the current occurrence", () => {
  const recurring = task("daily", {
    recurrence: "daily",
    scheduledDate: "2026-09-17",
  });
  assert.equal(
    sessionInCurrentOccurrence(
      recurring,
      session({ taskId: recurring.id, createdAt: "2026-09-16T12:00:00.000Z" }),
    ),
    false,
    "the completed occurrence must not reopen its ended terminal",
  );
  assert.equal(
    sessionInCurrentOccurrence(
      recurring,
      session({ taskId: recurring.id, createdAt: "2026-09-17T12:00:00.000Z" }),
    ),
    true,
    "a new conversation belongs to the new occurrence",
  );
  assert.equal(
    sessionInCurrentOccurrence(
      task("once"),
      session({ taskId: "once", createdAt: "2026-09-01T12:00:00.000Z" }),
    ),
    true,
    "non-recurring tasks retain their latest conversation",
  );
});

test("companyTint follows the position in snap.companies, never company.color", () => {
  const snap = snapshot({
    companies: ["a", "b", "c", "d", "e", "f", "g"].map(company),
  });
  assert.equal(companyTint("a", snap), "var(--accent)");
  assert.equal(companyTint("b", snap), "#3b6fd6");
  assert.equal(companyTint("g", snap), companyPalette[0], "wraps around");
  assert.equal(companyTint("missing", snap), companyPalette[0]);
  assert.ok(!companyPalette.includes("#4fd98a"));
});

test("projectTint is the project's age rank inside its own company", () => {
  const projects = [
    project("late", "2026-09-04T10:00:00.000Z"),
    project("first", "2026-09-01T10:00:00.000Z"),
    project("other", "2026-08-01T10:00:00.000Z", { companyId: "b" }),
    project("second", "2026-09-02T10:00:00.000Z"),
    project("third", "2026-09-03T10:00:00.000Z"),
    project("fifth", "2026-09-05T10:00:00.000Z"),
  ];
  const snap = snapshot({ projects });
  const tint = (id: string) =>
    projectTint(projects.find((p) => p.id === id)!, snap);
  assert.deepEqual(
    ["first", "second", "third", "late"].map(tint),
    projectPalette,
    "the design colours in creation order, whatever the array order",
  );
  assert.equal(tint("fifth"), projectPalette[0], "wraps after four");
  assert.equal(tint("other"), projectPalette[0], "companies count apart");
  assert.equal(
    tint("second"),
    projectTint(projects[3], snapshot({ projects: [...projects].reverse() })),
    "stable under reordering",
  );
  const twins = [project("b", stamp), project("a", stamp)];
  assert.equal(
    projectTint(twins[1], snapshot({ projects: twins })),
    projectPalette[0],
    "equal timestamps fall back to the id",
  );
});

test("statusTone keeps separate task and project vocabularies", () => {
  assert.equal(statusTone("task", "done"), "muted");
  assert.equal(statusTone("project", "done"), "accent");
  assert.equal(statusTone("project", "active"), "blue");
  assert.equal(statusTone("task", "in_progress"), "blue");
  assert.equal(statusTone("task", "review"), "accent");
  assert.equal(statusTone("project", "review"), "accent");
  assert.equal(statusTone("task", "blocked"), "warn");
  assert.equal(statusTone("project", "blocked"), "warn");
  assert.equal(statusTone("task", "todo"), "muted");
  assert.equal(statusTone("project", "empty"), "muted");
  assert.equal(statusTone("account", "logged_in"), "accent");
  assert.equal(statusTone("account", "expired"), "warn");
  assert.equal(statusTone("account", "logged_out"), "warn");
  assert.equal(statusTone("account", "unknown"), "muted");
  assert.equal(statusTone("task", "nonsense"), "muted");
  assert.equal(statusTone("task", "constructor"), "muted");
  assert.equal(statusLabel("task", "review"), "Wacht op jou");
  assert.equal(statusLabel("project", "active"), "Actief");
  assert.equal(statusLabel("project", "empty"), "Nog geen taken");
  assert.equal(statusLabel("project", "nonsense"), "nonsense");
});

test("conversationStatus maps every real session state, in order of precedence", () => {
  const snap = snapshot();
  const status = (patch: Partial<Session>, s = snap) => {
    const value = conversationStatus(session(patch), s);
    return `${value.key}/${value.label}/${value.tone}`;
  };
  assert.equal(status({ state: "waiting" }), "waiting/Wacht op jou/accent");
  assert.equal(status({ state: "working" }), "busy/Bezig/blue");
  assert.equal(status({ state: "starting" }), "starting/Start…/blue");
  assert.equal(status({ state: "idle" }), "open/Open/muted");
  assert.equal(
    status({ state: "interrupted" }),
    "interrupted/Onderbroken/muted",
  );
  assert.equal(
    status({ state: "unknown" }),
    "unknown/Status onbekend/muted",
    "Codex before its hooks are approved is not Bezig",
  );
  assert.equal(status({ state: "error" }), "error/Fout/warn");
  assert.equal(
    status({ state: "working", agentRunning: false }),
    "paused/Gepauzeerd/muted",
    "an assistant conversation whose agent stopped is paused, whatever the last state says",
  );
  assert.equal(
    status({ state: "error", agentRunning: false }),
    "error/Fout/warn",
    "an error outranks paused",
  );
  assert.equal(
    status({ provider: "shell", agentRunning: false, state: "idle" }),
    "open/Open/muted",
    "a shell has no agent to pause",
  );
  assert.equal(
    status({ alive: false, providerSessionId: "thread" }),
    "paused/Gepauzeerd/muted",
    "stopped but resumable",
  );
  assert.equal(
    status({ alive: false, providerSessionId: null }),
    "closed/Afgesloten/muted",
  );
  assert.equal(
    status({ alive: false, provider: "shell", providerSessionId: "x" }),
    "closed/Afgesloten/muted",
    "a shell cannot be resumed",
  );
  // waitingSession looks the conversation up in the snapshot, so it has to be in there.
  const delivered = { alive: false, taskId: "t", providerSessionId: "x" };
  const review = snapshot({
    tasks: [task("t", { status: "review" })],
    sessions: [session(delivered)],
  });
  assert.equal(
    status(delivered, review),
    "waiting/Wacht op jou/accent",
    "a result waiting for review outranks everything",
  );
});

test("goalView: number, € rule, label, progress and meta", () => {
  const snap = snapshot({
    projects: [
      project("p1", stamp, { goalId: "g" }),
      project("p2", stamp, { goalId: "g" }),
      project("p3", stamp, { goalId: "g", companyId: "b" }),
    ],
  });
  const plain = goalView(
    goal({ current: 5, target: 12, unit: "klantgesprekken", primary: true }),
    snap,
    [],
    "2026-09-18",
  );
  assert.equal(plain.label, "Belangrijkste doel");
  assert.equal(plain.primary, true);
  assert.equal(plain.title, "Klantgesprekken");
  assert.equal(plain.big, "5");
  assert.equal(plain.sub, "van 12 klantgesprekken");
  assert.equal(Math.round(plain.pct), 42);
  assert.equal(plain.meta, "2 projecten dragen bij");
  assert.equal(plain.projects, 2);
  assert.equal(plain.due, "");
  assert.equal(plain.late, false);
  assert.equal(plain.measurable, true);

  const money = goalView(
    goal({ current: 12400, target: 50000, unit: " € ", metric: "Omzet" }),
    snapshot(),
    [],
    "2026-09-18",
  );
  assert.equal(money.label, "Omzet");
  assert.equal(money.big, "€12.400");
  assert.equal(money.sub, "van €50.000");
  assert.equal(money.meta, "Nog geen project gekoppeld");

  assert.equal(
    goalView(goal({ unit: "€" }), snapshot(), []).label,
    "Doel",
    "a currency sign is not a label",
  );
  assert.equal(
    goalView(goal({ unit: "gesprekken" }), snapshot(), []).label,
    "gesprekken",
  );
  assert.equal(
    goalView(goal(), snapshot({ projects: [snap.projects[0]] }), []).meta,
    "1 project draagt bij",
  );

  const lower = goalView(
    goal({ baseline: 10, current: 8, target: 5, unit: "dagen" }),
    snapshot(),
    [],
  );
  assert.equal(lower.big, "8 dagen");
  assert.equal(lower.sub, "nu · doel 5");
  assert.equal(Math.round(lower.pct), 40, "baseline-aware, also downwards");

  const unmeasured = goalView(goal(), snapshot(), []);
  assert.equal(unmeasured.measurable, false, "0 / 0 / 0 from the intake");
  assert.equal(goalPct(goal({ baseline: 3, current: 1, target: 9 })), 0);
  assert.equal(goalPct(goal({ current: 40, target: 12 })), 100, "clamped");

  const dated = goalView(
    goal({ current: 5, target: 12, dueDate: "2026-09-30" }),
    snapshot(),
    [],
    "2026-09-18",
  );
  assert.equal(dated.due, "tot 30 sep");
  assert.equal(dated.late, false);

  setLanguage("en");
  try {
    assert.equal(
      goalView(goal({ current: 1250.5, target: 5000 }), snapshot(), []).big,
      "1,250.5",
      "smoke-language reads this number on Today",
    );
  } finally {
    setLanguage("nl");
  }
});

test("goal bar is warn only when the goal is really behind (decision D10)", () => {
  const tone = (g: Goal, checkins: Checkin[], day: string) =>
    goalView(g, snapshot(), checkins, day).tone;
  const running = goal({ current: 1, target: 12, dueDate: "2026-09-30" });
  assert.equal(
    tone(running, [], "2026-09-18"),
    "accent",
    "8% with no check-in is not evidence of being behind (the prototype's 66% rule is not used)",
  );
  assert.equal(
    tone(goal({ current: 1, target: 12 }), [], "2026-09-18"),
    "accent",
  );

  const overdue = goalView(running, snapshot(), [], "2026-10-01");
  assert.equal(overdue.tone, "warn", "deadline passed, target not reached");
  assert.equal(overdue.late, true);
  assert.equal(
    tone(running, [], "2026-09-30"),
    "accent",
    "the deadline day itself still counts",
  );
  const reached = goalView(
    goal({ current: 12, target: 12, dueDate: "2026-09-30" }),
    snapshot(),
    [],
    "2026-10-01",
  );
  assert.equal(reached.tone, "accent", "reached goals are never behind");
  assert.equal(reached.late, false);

  // First check-in on 1 Sep at 0, deadline 1 Oct, target 12: half way (16 Sep) the line expects 6.
  const first = [
    checkin("2026-09-08T10:00:00.000Z", 2, 4),
    checkin("2026-09-01T10:00:00.000Z", 0, 2),
  ];
  const paced = (current: number) =>
    goal({ current, target: 12, dueDate: "2026-10-01" });
  assert.equal(tone(paced(5), first, "2026-09-16"), "warn", "below the line");
  assert.equal(tone(paced(6), first, "2026-09-16"), "accent", "on the line");
  assert.equal(tone(paced(9), first, "2026-09-16"), "accent");
  assert.equal(
    tone(paced(0), first, "2026-09-01"),
    "accent",
    "day of the first check-in",
  );
  assert.equal(
    goalBehind(
      paced(5),
      [
        {
          ...first[1],
          measurements: [{ ...first[1].measurements![0], goalId: "other" }],
        },
      ],
      "2026-09-16",
    ),
    false,
    "measurements of other goals do not count",
  );
  assert.equal(
    goalBehind(
      paced(5),
      [{ ...first[1], measurements: undefined }],
      "2026-09-16",
    ),
    false,
    "legacy check-ins without measurements",
  );

  const down = goal({
    baseline: 10,
    current: 9,
    target: 5,
    dueDate: "2026-10-01",
  });
  const downStart = [checkin("2026-09-01T10:00:00.000Z", 10, 9)];
  assert.equal(
    tone(down, downStart, "2026-09-16"),
    "warn",
    "lower-is-better goals pace downwards",
  );
  assert.equal(
    tone({ ...down, current: 7 }, downStart, "2026-09-16"),
    "accent",
  );
});

test("formatDayMonth drops the weekday, remainingTone has strict boundaries", () => {
  assert.equal(formatDayMonth("2026-09-30"), "30 sep");
  assert.equal(formatDayMonth("2026-09-30T08:00:00.000Z"), "30 sep");
  assert.equal(formatDayMonth(""), "");
  assert.equal(formatDayMonth("geen datum"), "");
  assert.deepEqual([100, 51, 50, 21, 20, 0].map(remainingTone), [
    "accent",
    "accent",
    "warn",
    "warn",
    "danger",
    "danger",
  ]);
});

test("helper modules stay importable from node", () => {
  const root = [process.cwd(), join(__dirname, "..", "..")].find((dir) =>
    existsSync(join(dir, "src/ui/primitives.tsx")),
  );
  assert.ok(root, "run the tests from the project root");
  for (const file of ["src/ui/primitives.tsx", "src/ui/overview.ts"]) {
    const source = readFileSync(join(root, file), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    for (const banned of ["./rz", "./Theme", "./language", "./model"])
      assert.ok(!imports.includes(banned), `${file} must not import ${banned}`);
    assert.ok(
      !imports.some((i) => /\.(png|css|svg)$/.test(i)),
      `${file} must not import assets`,
    );
    assert.ok(
      !/^(?:const|let|var|export const)[^\n=]*=\s*(?:localStorage|document|window)\b/m.test(
        source,
      ),
      `${file} must not touch the DOM at module level`,
    );
  }
});
