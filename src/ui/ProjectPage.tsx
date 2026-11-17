import { t as tr, locale, translateMessage } from "../shared/i18n";
import { useRef, useState } from "react";
import { scheduleLabel } from "../shared/task-schedule";
import { ArrowRight, Ellipsis, Search } from "lucide-react";
import type { Project, Snapshot, Task } from "../shared/types";
import { api, useWorkbench } from "./model";
import {
  formatDate,
  formatDayMonth,
  goalView,
  isBlocked,
  projectTint,
  providerName,
  statusLabel,
  statusTone,
  taskOrder,
  taskProvider,
} from "./primitives";
import { localDay, projectOverview } from "./overview";
import { MemoryModal } from "./SessionMemory";
import { TaskCheck, useTaskChecks } from "./TaskCheck";
import { TaskComposer, type TaskComposerHandle } from "./TaskComposer";
import {
  Badge,
  Bar,
  Button,
  Card,
  Crumbs,
  Due,
  Empty,
  IconButton,
  Menu,
  PageHead,
  PageShell,
  Row,
  RowEnd,
  StatusDot,
  Tabs,
  TextButton,
  ViewSwitch,
  useSavedView,
  type MenuItem,
} from "./rz";

type Filter = "all" | "open" | "waiting" | "done";
const boardColumns = [
  "todo",
  "in_progress",
  "review",
  "blocked",
  "done",
] as const;

// Project detail. Without a project it is the company-wide task list (view "tasks"): same page, no project chrome.
export function ProProjectPage({ project }: { project?: Project }) {
  const {
    snap,
    companyId,
    edit,
    launch,
    navigate,
    openTask,
    openSession,
    run,
  } = useWorkbench();
  const [tab, setTab] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [view, setView] = useSavedView("projectrustig.view", "list");
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const composer = useRef<TaskComposerHandle>(null);
  const stored = taskOrder(
    snap.tasks.filter(
      (t) =>
        t.companyId === companyId && (!project || t.projectId === project.id),
    ),
  );
  // A check counts at once: rows, counters, the summary and the project status all read the same optimistic tasks.
  const checks = useTaskChecks(stored);
  const optimistic = (t: Task): Task =>
    checks.isDone(t) === (t.status === "done")
      ? t
      : { ...t, status: checks.isDone(t) ? "done" : "todo" };
  const live: Snapshot = Object.keys(checks.pending).length
    ? { ...snap, tasks: snap.tasks.map(optimistic) }
    : snap;
  const all = stored.map(optimistic);
  const statusOf = (t: Task) => (isBlocked(t, live) ? "blocked" : t.status);
  // D:163 — "Wacht op jou" is review only; a blocked task stays under Alle / Open with its warn dot.
  const match = (t: Task, filter: Filter) =>
    filter === "all" ||
    (filter === "open"
      ? t.status !== "done"
      : filter === "done"
        ? t.status === "done"
        : statusOf(t) === "review");
  const query = search.trim().toLowerCase();
  const found = all.filter((t) => t.title.toLowerCase().includes(query));
  // The tabs filter the list; the board shows every status column from `found` (D:165) and only follows the search.
  const tasks = found.filter((t) => match(t, tab));
  const shown = view === "list" ? tasks : found;
  const today = localDay();
  const late = (t: Task) =>
    !!t.dueDate && t.dueDate < today && t.status !== "done";
  const who = (t: Task) =>
    [taskProvider(t), translateMessage(scheduleLabel(t))]
      .filter(Boolean)
      .join(" · ");
  const overview = project ? projectOverview(project, live) : null;
  const doneCount = all.filter((t) => t.status === "done").length;
  const goal = snap.goals.find((g) => g.id === project?.goalId);
  const goalNow = goal ? goalView(goal, snap, snap.checkins) : null;
  const dept = snap.departments.find((d) => d.id === project?.departmentId);
  // Newest notes of a conversation in this list; a conversation that was resumed is represented by its successor.
  const noted = snap.sessions.filter(
    (s) =>
      s.companyId === companyId &&
      s.memory &&
      all.some((t) => t.id === s.taskId),
  );
  const continued = new Set(noted.map((s) => s.resumeFrom).filter(Boolean));
  const last = noted
    .filter((s) => !continued.has(s.id))
    .sort((a, b) => b.memory!.updatedAt.localeCompare(a.memory!.updatedAt))[0];
  const save = (ids: string[]) =>
    project &&
    void run(() =>
      api("task.reorder", { projectId: project.id, taskIds: ids }),
    );
  const reorder = (id: string) => {
    setOver(null);
    if (!project || !drag || drag === id) return;
    const ids = all.map((t) => t.id).filter((i) => i !== drag);
    ids.splice(ids.indexOf(id), 0, drag);
    save(ids);
    setDrag(null);
  };
  const nudge = (id: string, step: -1 | 1) => {
    const ids = all.map((t) => t.id),
      from = ids.indexOf(id),
      to = from + step;
    if (to < 0 || to >= ids.length) return;
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    save(ids);
  };
  const options: MenuItem[] = [
    ...(project
      ? [
          {
            id: "edit",
            label: tr("Bewerken"),
            onSelect: () => edit("project", project),
          },
        ]
      : []),
    {
      id: "order",
      label: tr("Volgorde laten voorstellen"),
      title: tr("Volgorde laten voorstellen · ⌘P"),
      onSelect: () => launch({ mode: "planning", companyId }),
    },
  ];
  const title = project?.name || tr("Alle taken");
  return (
    <PageShell
      data-test="project-page"
      composer={
        <TaskComposer
          key={`project:${companyId}:${project?.id || "all"}`}
          draftScope={`project:${companyId}:${project?.id || "all"}`}
          ref={composer}
          fixedProjectId={project?.id}
          placeholder={
            project
              ? tr("Geef een taak in {0}", project.name)
              : tr("Geef een taak")
          }
          selfHint={tr("Komt op je lijst")}
          expandLabel={tr("Uitgebreide taak")}
        />
      }
    >
      <PageHead
        className="rz-project__head"
        crumbs={
          <Crumbs
            items={[
              { label: tr("Projecten"), onClick: () => navigate("projects") },
              { label: dept?.name || title },
            ]}
          />
        }
        badge={
          project && (
            <Badge
              name={project.name}
              tint={projectTint(project, snap)}
              size={26}
            />
          )
        }
        title={title}
        actions={
          <>
            <Menu
              label={tr("Projectopties")}
              align="right"
              items={options}
              trigger={(props) => (
                <IconButton
                  {...props}
                  label={tr("Projectopties")}
                  title={tr("Meer")}
                  size="lg"
                >
                  <Ellipsis size={16} />
                </IconButton>
              )}
            />
            <Button variant="primary" onClick={() => composer.current?.focus()}>
              {tr("Nieuwe taak")}
            </Button>
          </>
        }
      >
        {project?.description && (
          <p className="rz-lead">{project.description}</p>
        )}
        <div className="rz-metaline">
          {overview && (
            // "● Actief" is the one coloured label (D:74); statusTone("project","active") is blue for the Projecten list.
            <StatusDot
              tone={
                overview.status === "active"
                  ? "accent"
                  : statusTone("project", overview.status)
              }
              accentText={overview.status === "active"}
              label={statusLabel("project", overview.status)}
            />
          )}
          {overview?.status !== "empty" && (
            <span>{tr("{0} van {1} afgerond", doneCount, all.length)}</span>
          )}
          {project?.dueDate && (
            <Due late={project.dueDate < today && overview?.status !== "done"}>
              {tr("deadline {0}", formatDate(project.dueDate))}
            </Due>
          )}
          {goal && goalNow ? (
            <button
              type="button"
              className="rz-project__goal"
              onClick={() => navigate("company")}
            >
              <span className="rz-project__goal-title">
                {tr("Doel: {0}", goal.title)}
              </span>
              {goalNow.measurable && (
                <>
                  <Bar mini pct={goalNow.pct} tone={goalNow.tone} />
                  <span className="rz-num">
                    {goal.current.toLocaleString(locale())}/
                    {goal.target.toLocaleString(locale())}
                  </span>
                </>
              )}
            </button>
          ) : (
            project && (
              <button
                type="button"
                className="rz-project__goal"
                onClick={() => edit("project", project)}
              >
                {tr("Doel koppelen")}
              </button>
            )
          )}
        </div>
      </PageHead>
      <section className="rz-project__tasks">
        <div className="rz-tabbar">
          <Tabs<Filter>
            data-test="pro-tabs"
            label={tr("Takenfilter")}
            value={tab}
            onChange={setTab}
            tabs={[
              {
                id: "all",
                label: tr("Alle"),
                count: all.filter((t) => match(t, "all")).length,
              },
              {
                id: "open",
                label: tr("Open"),
                count: all.filter((t) => match(t, "open")).length,
              },
              {
                id: "waiting",
                label: tr("Wacht op jou"),
                count: all.filter((t) => match(t, "waiting")).length,
              },
              {
                id: "done",
                label: tr("Afgerond"),
                count: all.filter((t) => match(t, "done")).length,
              },
            ]}
          />
          <div className="rz-project__tools">
            <label
              className="rz-project__search"
              title={tr("Taken zoeken")}
              data-active={search ? "" : undefined}
            >
              <Search size={15} aria-hidden="true" />
              <input
                className="rz-project__search-input"
                aria-label={tr("Taken zoeken")}
                placeholder={tr("Zoek een taak…")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Escape") return;
                  setSearch("");
                  e.currentTarget.blur();
                }}
              />
            </label>
            <ViewSwitch view={view} set={setView} board />
          </div>
        </div>
        {view === "list" ? (
          <div className="rz-project__list">
            {tasks.map((t) => (
              <Row
                as="div"
                size="task"
                key={t.id}
                className="rz-project__task"
                done={t.status === "done"}
                data-task-id={t.id}
                data-drop={over === t.id && drag !== t.id ? "" : undefined}
                draggable={!!project}
                onDragStart={() => setDrag(t.id)}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (project && drag && over !== t.id) setOver(t.id);
                }}
                onDragEnd={() => {
                  setDrag(null);
                  setOver(null);
                }}
                onDrop={() => reorder(t.id)}
                onClick={() => openTask(t, t.status === "review")}
              >
                <TaskCheck task={t} checks={checks} size="sm" />
                <button
                  type="button"
                  className="rz-project__name"
                  data-test="pro-task-name"
                  title={
                    project
                      ? tr("Open taak · ⌥↑ / ⌥↓ om te verplaatsen")
                      : tr("Open taak")
                  }
                  onKeyDown={(e) => {
                    if (
                      !project ||
                      !e.altKey ||
                      !["ArrowUp", "ArrowDown"].includes(e.key)
                    )
                      return;
                    e.preventDefault();
                    nudge(t.id, e.key === "ArrowUp" ? -1 : 1);
                  }}
                >
                  <span className="rz-row__title">{t.title}</span>
                  <span className="rz-row__meta">{who(t)}</span>
                </button>
                <RowEnd>
                  {t.dueDate && (
                    <Due late={late(t)}>{formatDate(t.dueDate, true)}</Due>
                  )}
                  <StatusDot
                    className="rz-project__state"
                    tone={statusTone("task", statusOf(t))}
                    label={statusLabel("task", statusOf(t))}
                  />
                </RowEnd>
              </Row>
            ))}
          </div>
        ) : (
          <div className="rz-project__board">
            {boardColumns.map((status) => {
              const group = found.filter((t) => statusOf(t) === status);
              if (status === "blocked" && !group.length) return null;
              return (
                <section className="rz-project__col" key={status}>
                  <h3 className="rz-project__col-head">
                    <StatusDot tone={statusTone("task", status)} />
                    {statusLabel("task", status)}
                    <span className="rz-project__col-count" aria-hidden="true">
                      {group.length}
                    </span>
                  </h3>
                  {group.map((t) => (
                    <Card
                      as="button"
                      variant="board"
                      data-test="pro-board-card"
                      key={t.id}
                      data-task-id={t.id}
                      onClick={() => openTask(t, t.status === "review")}
                    >
                      <span className="rz-project__card-title">{t.title}</span>
                      <span className="rz-project__card-foot">
                        <span>{taskProvider(t)}</span>
                        {t.dueDate && (
                          <Due late={late(t)}>
                            {formatDate(t.dueDate, true)}
                          </Due>
                        )}
                      </span>
                    </Card>
                  ))}
                </section>
              );
            })}
          </div>
        )}
        {!all.length ? (
          // With a project the meta line already says "Nog geen taken", so the empty line is the invitation.
          <Empty
            inline
            className="rz-project__empty"
            title={
              project
                ? tr("Dit project begint met één concrete stap.")
                : tr("Nog geen taken")
            }
          />
        ) : (
          !shown.length && (
            <Empty
              inline
              className="rz-project__empty"
              title={tr("Geen taken in deze weergave")}
            />
          )
        )}
      </section>
      {last && (
        <section className="rz-project__note">
          <div className="rz-project__note-label">
            {tr(
              "Laatste notitie · {0} · {1}",
              providerName(last.provider),
              formatDayMonth(last.memory!.updatedAt),
            )}
          </div>
          <p className="rz-project__note-text">{last.memory!.summary}</p>
          <div className="rz-project__note-foot">
            {last.memory!.nextSteps[0] && (
              <span className="rz-project__note-next">
                {tr("Volgende stap: {0}", last.memory!.nextSteps[0])}
              </span>
            )}
            {(!last.purpose || last.purpose === "work") && (
              <TextButton
                title={last.memory!.summary}
                onClick={() => setNotes(last.id)}
              >
                {tr("Notities")}
              </TextButton>
            )}
            {(last.alive || last.providerSessionId) && (
              <TextButton
                tone="accent"
                onClick={() =>
                  last.alive
                    ? openSession(last)
                    : launch({
                        companyId: last.companyId,
                        taskId: last.taskId || undefined,
                        mode: last.mode,
                        resume: last,
                      })
                }
              >
                {last.alive ? tr("Open gesprek") : tr("Hervatten")}
                <ArrowRight size={13} aria-hidden="true" />
              </TextButton>
            )}
          </div>
        </section>
      )}
      {notes && <MemoryModal sessionId={notes} close={() => setNotes(null)} />}
    </PageShell>
  );
}
