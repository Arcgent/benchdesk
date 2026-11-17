import { Fragment, useRef, useState, type ReactNode } from "react";
import {
  CalendarDays,
  MoreHorizontal,
  Plus,
  Search,
  SquarePen,
  TerminalSquare,
} from "lucide-react";
import { t as tr } from "../shared/i18n";
import {
  taskStatuses,
  type Task,
  type TaskStatus,
  type Snapshot,
} from "../shared/types";
import {
  availableToday,
  localDate,
  scheduleLabel,
} from "../shared/task-schedule";
import { api, useWorkbench } from "./model";
import {
  formatDate,
  isBlocked,
  statusLabel,
  statusTone,
  taskOrder,
  taskProvider,
} from "./primitives";
import {
  Button,
  Chip,
  Field,
  Modal,
  ModalBody,
  ModalFoot,
  PageHead,
  PageShell,
  Select,
  StatusDot,
  TextButton,
} from "./rz";
import { useDesign } from "./Theme";
import "./rustig/dashboard.css";

export function Dashboard() {
  const { snap, companyId, edit, openTask, openSession, run } = useWorkbench();
  // Minimaal (Profiel → Stijl): quiet filter chips, cards as flat rows with one meta line, status on hover.
  const minimal = useDesign() === "minimaal";
  const terminalStarting = useRef(false);
  const [openingTerminal, setOpeningTerminal] = useState(false);
  // Deliberately independent of the sidebar's active company: this is the global task overview.
  const [companyFilter, setCompanyFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [executor, setExecutor] = useState("");
  const [search, setSearch] = useState("");
  const newTerminal = async () => {
    if (terminalStarting.current) return;
    terminalStarting.current = true;
    setOpeningTerminal(true);
    try {
      const session = await run(async () => {
        const id = await api<string>("session.start", {
          companyId:
            companyFilter ||
            snap.projects.find((p) => p.id === projectFilter)?.companyId ||
            companyId,
          provider: "shell",
          mode: "work",
          taskId: null,
          accountId: null,
          gmailAccess: "none",
          contextOptions: {
            assignment: false,
            criteria: false,
            business: false,
          },
        });
        const next = await api<Snapshot>("snapshot");
        return next.sessions.find((s) => s.id === id);
      });
      if (session) openSession(session);
    } finally {
      terminalStarting.current = false;
      setOpeningTerminal(false);
    }
  };
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const mutation = useRef(false);
  const [creating, setCreating] = useState(false);
  const [newCompany, setNewCompany] = useState("");
  const [newProject, setNewProject] = useState("");
  const companies = new Map(snap.companies.map((c) => [c.id, c]));
  const projects = new Map(snap.projects.map((p) => [p.id, p]));
  const selectableProjects = snap.projects.filter(
    (p) => !companyFilter || p.companyId === companyFilter,
  );
  const creationProjects = snap.projects.filter(
    (p) => p.companyId === newCompany,
  );
  const query = search.trim().toLocaleLowerCase();
  const tasks = taskOrder(snap.tasks).filter(
    (task) =>
      (!companyFilter || task.companyId === companyFilter) &&
      (!projectFilter || task.projectId === projectFilter) &&
      (!executor ||
        (task.kind === "human" ? "shell" : task.provider) === executor) &&
      (!query ||
        [
          task.title,
          task.description,
          companies.get(task.companyId)?.name,
          projects.get(task.projectId)?.name,
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(query)),
  );
  const filtered = !!(companyFilter || projectFilter || executor || search);
  // Minimaal: the company only shows on a card when the visible tasks span more than one company.
  const mixedCompanies = new Set(tasks.map((t) => t.companyId)).size > 1;
  const active = (task: Task) =>
    snap.sessions.some(
      (s) => s.taskId === task.id && s.alive && s.agentRunning,
    );
  const canMove = (task: Task, status: TaskStatus) =>
    !active(task) &&
    !(status === "done" && (!availableToday(task) || isBlocked(task, snap))) &&
    !(
      ["in_progress", "review", "done"].includes(status) &&
      task.dependencies.some(
        (id) => snap.tasks.find((t) => t.id === id)?.status !== "done",
      )
    );
  const reset = () => {
    setCompanyFilter("");
    setProjectFilter("");
    setExecutor("");
    setSearch("");
  };
  const move = async (task: Task, status: TaskStatus) => {
    if (mutation.current || !canMove(task, status) || task.status === status)
      return;
    if (status === "done" && task.status === "review") {
      openTask(task, true);
      return;
    }
    mutation.current = true;
    setPending(task.id);
    try {
      await run(() =>
        status === "done"
          ? api("task.complete", {
              id: task.id,
              note: tr("Door jou afgerond."),
            })
          : api("task.patch", { id: task.id, patch: { status } }),
      );
    } finally {
      mutation.current = false;
      setPending(null);
    }
  };
  const startCreate = () => {
    const id =
      companyFilter ||
      projects.get(projectFilter)?.companyId ||
      companyId ||
      snap.companies[0]?.id ||
      "";
    setNewCompany(id);
    setNewProject(
      projects.get(projectFilter)?.companyId === id
        ? projectFilter
        : snap.projects.find((p) => p.companyId === id)?.id || "",
    );
    setCreating(true);
  };
  // Minimaal: a filter is a quiet text chip with a chevron; the native <select> lies over it (Chip `control`),
  // so its label, keyboard behaviour and options stay the same. Standaard renders the bare <select>.
  const filterControl = (select: ReactNode, label: string, set: boolean) =>
    minimal ? (
      <Chip
        variant="quiet"
        chevron
        control={select}
        className="rz-dashboard__filter"
        data-active={set || undefined}
      >
        {label}
      </Chip>
    ) : (
      select
    );
  const statusSelect = (task: Task, running: boolean) => (
    <select
      aria-label={tr("Status van {0}", task.title)}
      value={task.status}
      disabled={running || !!pending}
      title={running ? tr("Dit gesprek is nog bezig") : tr("Status wijzigen")}
      onChange={(event) => void move(task, event.target.value as TaskStatus)}
    >
      {taskStatuses.map((s) => (
        <option
          key={s}
          value={s}
          disabled={s !== task.status && !canMove(task, s)}
        >
          {statusLabel("task", s)}
        </option>
      ))}
    </select>
  );
  // Minimaal: one muted meta line "company · project · who · when"; an overdue deadline is the only colour.
  const taskMeta = (task: Task, running: boolean, late: boolean) => {
    const parts: ReactNode[] = [];
    if (mixedCompanies)
      parts.push(companies.get(task.companyId)?.name || tr("Bedrijf"));
    const project = projects.get(task.projectId)?.name;
    if (project) parts.push(project);
    parts.push(running ? tr("Assistent is bezig") : taskProvider(task));
    if (task.dueDate)
      parts.push(
        <span className="rz-dashboard__due" data-late={late || undefined}>
          {late
            ? tr("Verlopen · {0}", formatDate(task.dueDate))
            : tr("deadline {0}", formatDate(task.dueDate))}
        </span>,
      );
    else if (task.scheduledDate || task.recurrence !== "none")
      parts.push(scheduleLabel(task));
    return parts;
  };

  return (
    <PageShell width="full" className="rz-dashboard" data-test="dashboard">
      <PageHead
        title={tr("Dashboard")}
        meta={tr("Alle taken. Eén overzicht.")}
        actions={
          <>
            <Button
              icon={
                minimal ? (
                  <SquarePen size={14} aria-hidden="true" />
                ) : (
                  <TerminalSquare size={14} aria-hidden="true" />
                )
              }
              disabled={openingTerminal}
              onClick={() => void newTerminal()}
            >
              {minimal ? tr("Nieuw gesprek") : tr("Terminal openen")}
            </Button>
            <Button
              variant="primary"
              icon={<Plus size={14} aria-hidden="true" />}
              onClick={startCreate}
            >
              {tr("Nieuwe taak")}
            </Button>
          </>
        }
      />
      <div
        className="rz-dashboard__toolbar"
        role="search"
        aria-label={tr("Taken filteren")}
      >
        <label className="rz-dashboard__search">
          <Search size={15} aria-hidden="true" />
          <input
            aria-label={tr("Taken zoeken")}
            placeholder={tr("Zoek taken…")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        {filterControl(
          <select
            aria-label={tr("Filter op bedrijf")}
            value={companyFilter}
            onChange={(e) => {
              setCompanyFilter(e.target.value);
              setProjectFilter("");
            }}
          >
            <option value="">{tr("Alle bedrijven")}</option>
            {snap.companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>,
          companies.get(companyFilter)?.name || tr("Alle bedrijven"),
          !!companyFilter,
        )}
        {filterControl(
          <select
            aria-label={tr("Filter op project")}
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
          >
            <option value="">{tr("Alle projecten")}</option>
            {selectableProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {companyFilter
                  ? p.name
                  : `${companies.get(p.companyId)?.name} · ${p.name}`}
              </option>
            ))}
          </select>,
          projects.get(projectFilter)?.name || tr("Alle projecten"),
          !!projectFilter,
        )}
        {filterControl(
          <select
            aria-label={tr("Filter op uitvoerder")}
            value={executor}
            onChange={(e) => setExecutor(e.target.value)}
          >
            <option value="">{tr("Alle uitvoerders")}</option>
            <option value="shell">{tr("Jij")}</option>
            <option value="codex">Codex</option>
            <option value="claude">Claude Code</option>
          </select>,
          executor === "shell"
            ? tr("Jij")
            : executor === "codex"
              ? "Codex"
              : executor === "claude"
                ? "Claude Code"
                : tr("Alle uitvoerders"),
          !!executor,
        )}
      </div>
      <div className="rz-dashboard__summary">
        <span role="status" aria-live="polite">
          {tr("{0} van {1} taken", tasks.length, snap.tasks.length)}
        </span>
        {filtered && (
          <TextButton onClick={reset}>{tr("Filters wissen")}</TextButton>
        )}
      </div>
      {tasks.length === 0 && (
        <div className="rz-dashboard__empty" role="status">
          {snap.tasks.length
            ? tr("Geen taken gevonden. Pas je filters aan.")
            : tr("Nog geen taken. Voeg je eerste taak toe.")}
        </div>
      )}
      <div className="rz-dashboard__board" aria-label={tr("Takenbord")}>
        {taskStatuses.map((status) => {
          const column = tasks.filter((task) => task.status === status);
          return (
            <section
              key={status}
              className="rz-dashboard__column"
              data-status={status}
              data-over={over === status || undefined}
              aria-label={statusLabel("task", status)}
              onDragOver={(event) => {
                const task = snap.tasks.find((t) => t.id === dragged);
                if (!task || pending || !canMove(task, status)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setOver(status);
              }}
              onDragLeave={(event) => {
                if (
                  !event.currentTarget.contains(
                    event.relatedTarget as Node | null,
                  )
                )
                  setOver(null);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setOver(null);
                setDragged(null);
                const task = snap.tasks.find((t) => t.id === dragged);
                if (task) void move(task, status);
              }}
            >
              <header className="rz-dashboard__column-head">
                <StatusDot tone={statusTone("task", status)} />
                <h2>{statusLabel("task", status)}</h2>
                <span>{column.length}</span>
              </header>
              <div className="rz-dashboard__cards">
                {column.map((task) => {
                  const running = active(task);
                  const blocked = isBlocked(task, snap);
                  const late =
                    task.status !== "done" &&
                    !!task.dueDate &&
                    task.dueDate < localDate();
                  return (
                    <article
                      key={task.id}
                      className="rz-dashboard__task"
                      data-test="kanban-task"
                      data-task-id={task.id}
                      data-dragging={dragged === task.id || undefined}
                      aria-busy={pending === task.id}
                      draggable={!running && !pending}
                      onDragStart={(event) => {
                        setDragged(task.id);
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", task.id);
                      }}
                      onDragEnd={() => {
                        setDragged(null);
                        setOver(null);
                      }}
                    >
                      <button
                        className="rz-dashboard__task-open"
                        onClick={() => openTask(task, task.status === "review")}
                      >
                        {minimal ? (
                          <>
                            <span className="rz-dashboard__title">
                              {task.title}
                            </span>
                            <span className="rz-dashboard__meta">
                              {taskMeta(task, running, late).map((part, i) => (
                                <Fragment key={i}>
                                  {i > 0 && " · "}
                                  {part}
                                </Fragment>
                              ))}
                            </span>
                            {blocked && task.status !== "blocked" && (
                              <span className="rz-dashboard__warning">
                                {tr("Wacht op afhankelijkheden")}
                              </span>
                            )}
                          </>
                        ) : (
                          <>
                            <span className="rz-dashboard__company">
                              {companies.get(task.companyId)?.name ||
                                tr("Bedrijf")}
                            </span>
                            <span className="rz-dashboard__title">
                              {task.title}
                            </span>
                            <span className="rz-dashboard__project">
                              {projects.get(task.projectId)?.name}
                            </span>
                            {(task.dueDate ||
                              task.scheduledDate ||
                              task.recurrence !== "none") && (
                              <span
                                className="rz-dashboard__date"
                                data-late={late || undefined}
                              >
                                <CalendarDays size={12} aria-hidden="true" />
                                {task.dueDate
                                  ? `${tr("Deadline")}: ${formatDate(task.dueDate)}`
                                  : scheduleLabel(task)}
                              </span>
                            )}
                            {blocked && task.status !== "blocked" && (
                              <span className="rz-dashboard__warning">
                                {tr("Wacht op afhankelijkheden")}
                              </span>
                            )}
                          </>
                        )}
                      </button>
                      <footer className="rz-dashboard__task-foot">
                        {minimal ? (
                          // Minimaal: the column already says the status, so the control is a ⋯ that shows on
                          // hover / focus; the native <select> lies over it at opacity 0.
                          <label
                            className="rz-dashboard__status"
                            data-disabled={running || !!pending || undefined}
                          >
                            <MoreHorizontal size={16} aria-hidden="true" />
                            {statusSelect(task, running)}
                          </label>
                        ) : (
                          <>
                            <span>
                              {running
                                ? tr("Assistent is bezig")
                                : taskProvider(task)}
                            </span>
                            {statusSelect(task, running)}
                          </>
                        )}
                      </footer>
                    </article>
                  );
                })}
                {!column.length && (
                  <p className="rz-dashboard__column-empty">
                    {tr("Geen taken")}
                  </p>
                )}
              </div>
            </section>
          );
        })}
      </div>
      {creating && (
        <Modal
          title={tr("Nieuwe taak")}
          width="sm"
          close={() => setCreating(false)}
        >
          <ModalBody>
            <Field label={tr("Bedrijf")}>
              <Select
                aria-label={tr("Bedrijf voor nieuwe taak")}
                value={newCompany}
                onChange={(e) => {
                  setNewCompany(e.target.value);
                  setNewProject(
                    snap.projects.find((p) => p.companyId === e.target.value)
                      ?.id || "",
                  );
                }}
              >
                {snap.companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={tr("Project")}>
              <Select
                aria-label={tr("Project voor nieuwe taak")}
                value={newProject}
                onChange={(e) => setNewProject(e.target.value)}
              >
                {!creationProjects.length && (
                  <option value="">{tr("Nog geen projecten")}</option>
                )}
                {creationProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          </ModalBody>
          <ModalFoot>
            <Button onClick={() => setCreating(false)}>
              {tr("Annuleren")}
            </Button>
            <Button
              variant="primary"
              disabled={!newCompany}
              onClick={() => {
                setCreating(false);
                if (newProject)
                  edit("task", {
                    companyId: newCompany,
                    projectId: newProject,
                    goalId: projects.get(newProject)?.goalId || null,
                  });
                else edit("project", { companyId: newCompany });
              }}
            >
              {newProject ? tr("Verder") : tr("Project toevoegen")}
            </Button>
          </ModalFoot>
        </Modal>
      )}
    </PageShell>
  );
}
