import { t as tr, locale, translateMessage } from "../shared/i18n";
import { useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import type { Proposal, Task } from "../shared/types";
import { availableToday, scheduleLabel } from "../shared/task-schedule";
import { ArrowRight, Plus, Search, Sparkle } from "lucide-react";
import { useWorkbench } from "./model";
import {
  conversationStatus,
  formatDate,
  formatTime,
  goalView,
  isBlocked,
  providerName,
  sessionTitle,
  statusLabel,
  statusTone,
  taskOrder,
  taskProvider,
} from "./primitives";
import {
  Avatar,
  Bar,
  Button,
  Card,
  Cards,
  Crumbs,
  Due,
  Empty,
  PageHead,
  PageShell,
  Row,
  RowEnd,
  RowText,
  Section,
  SectionLabel,
  StatusDot,
  Tabs,
  TextButton,
} from "./rz";
import { TaskCheck, useTaskChecks } from "./TaskCheck";
import { TaskComposer } from "./TaskComposer";
import { Suggestions } from "./Suggestions";
import {
  greeting,
  localDay,
  todayHeadline,
  todayProOverview,
  waitingProposals,
} from "./overview";

type Filter = "open" | "later" | "all" | "done";
const inFilter = (t: Task, filter: Filter) =>
  filter === "all" ||
  (filter === "done"
    ? t.status === "done"
    : t.status !== "done" &&
      (filter === "later" ? !availableToday(t) : availableToday(t)));
// A pill or text action inside a clickable row: act once, do not let the row act again.
const only = (action: () => void) => (event: MouseEvent) => {
  event.stopPropagation();
  action();
};
// Section names stay headings for screen readers, without pulling "3 open" or a text action into the heading.
const Heading = ({ children }: { children: ReactNode }) => (
  <span role="heading" aria-level={2}>
    {children}
  </span>
);

function TodayTasks({ back }: { back: () => void }) {
  const { snap, company, companyId, newTask, openTask, edit, showProposal } =
    useWorkbench();
  const [filter, setFilter] = useState<Filter>("open");
  const [search, setSearch] = useState("");
  const today = localDay();
  const projects = new Map(snap.projects.map((p) => [p.id, p]));
  const all = taskOrder(snap.tasks.filter((t) => t.companyId === companyId));
  const tasks = all.filter(
    (t) =>
      inFilter(t, filter) &&
      (!search ||
        `${t.title} ${projects.get(t.projectId)?.name || ""}`
          .toLocaleLowerCase()
          .includes(search.toLocaleLowerCase())),
  );
  const checks = useTaskChecks(tasks);
  if (!company) return null;
  const groups = [
    ...snap.departments.filter((d) => d.companyId === companyId),
    null,
  ]
    .map((department) => ({
      department,
      tasks: tasks.filter(
        (t) =>
          (projects.get(t.projectId)?.departmentId || null) ===
          (department?.id || null),
      ),
    }))
    .filter((g) => g.tasks.length);
  const otherProposals = waitingProposals(snap, companyId);
  const open = all.filter((t) => inFilter(t, "open")).length;
  const count = (id: Filter) => all.filter((t) => inFilter(t, id)).length;
  return (
    <>
      <PageHead
        data-test="page-topbar"
        crumbs={
          <Crumbs
            items={[
              { label: tr("Vandaag"), onClick: back },
              { label: tr("Alle taken") },
            ]}
          />
        }
        title={tr("Alle taken")}
        meta={
          open === 1
            ? tr("1 open taak · {0}", company.name)
            : tr("{0} open taken · {1}", open, company.name)
        }
        actions={
          !!otherProposals.length && (
            <Button onClick={() => showProposal(otherProposals[0])}>
              {tr("Voorstel bekijken")}
            </Button>
          )
        }
      />
      <div className="rz-tabbar">
        <Tabs
          label={tr("Takenfilter")}
          semantics="buttons"
          value={filter}
          onChange={setFilter}
          tabs={[
            { id: "open", label: tr("Open"), count: count("open") },
            { id: "later", label: tr("Later"), count: count("later") },
            { id: "all", label: tr("Alle"), count: count("all") },
            { id: "done", label: tr("Afgerond"), count: count("done") },
          ]}
        />
        <label className="rz-today__search">
          <Search size={14} aria-hidden="true" />
          <input
            aria-label={tr("Taken zoeken")}
            placeholder={tr("Zoek een taak of project…")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>
      {groups.map(({ department, tasks }) => {
        const name = department?.name || tr("Zonder afdeling");
        return (
          <Section tight key={department?.id || "none"} aria-label={name}>
            <SectionLabel
              right={
                <TextButton
                  tone="meta"
                  icon={<Plus size={12} aria-hidden="true" />}
                  aria-label={tr("Taak toevoegen in {0}", name)}
                  onClick={() => {
                    const project = snap.projects.find(
                      (p) =>
                        p.companyId === companyId &&
                        p.departmentId === (department?.id || null),
                    );
                    if (project)
                      edit("task", {
                        projectId: project.id,
                        goalId: project.goalId,
                      });
                    else newTask();
                  }}
                >
                  {tr("Taak toevoegen")}
                </TextButton>
              }
            >
              <Heading>{name}</Heading>
              <span>
                {tasks.length === 1
                  ? tr("1 taak")
                  : tr("{0} taken", tasks.length)}
              </span>
            </SectionLabel>
            {tasks.map((t) => {
              const done = checks.isDone(t),
                review = t.status === "review",
                status = done
                  ? "done"
                  : isBlocked(t, snap)
                    ? "blocked"
                    : t.status === "done"
                      ? "todo"
                      : t.status,
                schedule = translateMessage(scheduleLabel(t)),
                openIt = () => openTask(t, review);
              return (
                <Row
                  as="div"
                  size="task"
                  key={t.id}
                  done={done}
                  data-test="department-task-row"
                  data-task-id={t.id}
                  onClick={openIt}
                >
                  <TaskCheck task={t} checks={checks} size="sm" />
                  <button type="button" className="rz-today__open">
                    <RowText
                      title={t.title}
                      meta={[
                        projects.get(t.projectId)?.name,
                        taskProvider(t),
                        schedule,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    />
                  </button>
                  <RowEnd>
                    {t.dueDate && (
                      <Due late={t.dueDate < today && !done}>
                        {formatDate(t.dueDate, true)}
                      </Due>
                    )}
                    <StatusDot
                      className="rz-today__status"
                      tone={statusTone("task", status)}
                      label={statusLabel("task", status)}
                    />
                    <span className="rz-today__action">
                      {review ? (
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={only(openIt)}
                        >
                          {tr("Beoordelen")}
                        </Button>
                      ) : (
                        <TextButton onClick={only(openIt)}>
                          {tr("Openen")}
                        </TextButton>
                      )}
                    </span>
                  </RowEnd>
                </Row>
              );
            })}
          </Section>
        );
      })}
      {!groups.length && (
        <Empty
          title={
            search
              ? tr("Geen taken gevonden")
              : filter === "done"
                ? tr("Nog geen afgeronde taken")
                : tr("Geen open taken")
          }
          action={
            !search && filter !== "done" ? (
              <Button onClick={newTask}>{tr("Taak toevoegen")}</Button>
            ) : undefined
          }
        >
          {search
            ? tr("Probeer een andere zoekterm.")
            : tr(
                "Je taken verschijnen hier onder de afdeling van hun project.",
              )}
        </Empty>
      )}
    </>
  );
}

function TodayMain({ allTasks }: { allTasks: () => void }) {
  const {
    snap,
    company,
    companyId,
    workspace,
    prefs,
    edit,
    launch,
    navigate,
    openTask,
    openSession,
    showProposal,
  } = useWorkbench();
  const now = new Date(),
    today = localDay(now);
  const { attention, continuing, planned, activeCount } = todayProOverview(
    snap,
    companyId,
    workspace.closedSessionIds || [],
    today,
  );
  const checks = useTaskChecks(planned);
  if (!company) return null;
  const goals = snap.goals
    .filter((g) => g.companyId === companyId)
    .sort((a, b) => Number(b.primary) - Number(a.primary))
    .slice(0, 2);
  const checkin = snap.checkins
    .filter((c) => c.companyId === companyId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const proposals = waitingProposals(snap, companyId);
  const headline = todayHeadline(
    snap,
    attention,
    proposals.length,
    activeCount,
  );
  const openPlanned = planned.filter((t) => !checks.isDone(t)).length;
  const userName = prefs.profile.name || tr("Jij");
  const dateLine = new Intl.DateTimeFormat(locale(), {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(now);
  const projectName = (id?: string | null) =>
    snap.projects.find((p) => p.id === id)?.name;
  const join = (parts: (string | undefined | false)[]) =>
    parts.filter(Boolean).join(" · ");
  // The assistant reports no pass/fail per criterion: the honest number is what the owner approved so far.
  const reviewMeta = (t: Task) => {
    const at =
      snap.events.find((e) => e.taskId === t.id && e.kind === "result")
        ?.createdAt || t.updatedAt;
    return join([
      taskProvider(t),
      projectName(t.projectId),
      !!t.criteria.length &&
        tr(
          "{0} van {1} akkoord",
          t.criteria.filter((c) => c.checked).length,
          t.criteria.length,
        ),
      tr(
        "ingediend {0}",
        localDay(new Date(at)) === today
          ? formatTime(at)
          : formatDate(at, true),
      ),
    ]);
  };
  // "Gepland · 18-09-2026" says nothing on a list for today; a recurrence ("Dagelijks · volgende …") does.
  const plannedMeta = (t: Task) =>
    join([
      projectName(t.projectId),
      taskProvider(t),
      t.recurrence !== "none" && translateMessage(scheduleLabel(t)),
    ]);
  // "Verlopen · …" stays on a done row; only the colour drops to muted (D/Vandaag:163,167).
  const dueText = (t: Task) =>
    t.dueDate && t.dueDate < today
      ? tr("Verlopen · {0}", formatDate(t.dueDate, true))
      : t.scheduledDate === today || t.dueDate === today
        ? tr("vandaag")
        : t.dueDate
          ? formatDate(t.dueDate, true)
          : "";
  const proposalTitle = (p: Proposal) =>
    p.kind === "priorities"
      ? tr("Prioriteitenadvies beoordelen")
      : p.kind === "context"
        ? tr("Voorgestelde context bekijken")
        : tr("Voorgestelde taken bekijken");
  return (
    <>
      <PageHead
        className="rz-today__head"
        srTitle={tr("Vandaag")}
        titleAs="h2"
        variant="sentence"
        eyebrow={`${greeting(now.getHours(), prefs.profile.name)} · ${dateLine}`}
        title={headline.text}
        actions={
          <Button
            icon={
              <Sparkle size={14} className="rz-btn__spark" aria-hidden="true" />
            }
            onClick={() => launch({ companyId, mode: "planning" })}
          >
            {tr("Prioriteitenadvies")}
          </Button>
        }
      />
      <Cards
        role="region"
        aria-label={tr("Doelen en check-in")}
        data-test="today-pro-context"
      >
        {goals.map((goal) => {
          const g = goalView(goal, snap, snap.checkins, today),
            metric = g.primary ? goal.metric.trim() : "";
          return (
            <Card
              as="button"
              className="rz-today__card"
              key={goal.id}
              onClick={() => edit("goal", goal)}
            >
              <span className="rz-card__label">{g.label}</span>
              <span className="rz-today__card-title">{g.title}</span>
              {g.measurable && (
                <>
                  <span className="rz-figure">
                    <span className="rz-figure__big">{g.big}</span>
                    <span className="rz-figure__unit">{g.sub}</span>
                  </span>
                  <Bar pct={g.pct} tone={g.tone} label={goal.title} />
                </>
              )}
              <span className="rz-today__card-foot">
                {metric}
                {metric && g.due ? " · " : ""}
                {g.due && <Due late={g.late}>{g.due}</Due>}
                {!metric && !g.due && g.meta}
              </span>
            </Card>
          );
        })}
        {!goals.length && (
          <Card
            as="button"
            className="rz-today__card"
            onClick={() => edit("goal")}
          >
            <span className="rz-card__label">{tr("Belangrijkste doel")}</span>
            <span className="rz-today__card-title">
              {tr("Waar werk je naartoe?")}
            </span>
            <span className="rz-today__note">
              {tr("Maak je voortgang zichtbaar met een concreet bedrijfsdoel.")}
            </span>
            <span className="rz-today__card-action">
              <span className="rz-today__cta">{tr("Doel toevoegen →")}</span>
            </span>
          </Card>
        )}
        <Card
          as="button"
          className="rz-today__card"
          onClick={() => edit("checkin")}
        >
          <span className="rz-card__label">{tr("Wekelijkse check-in")}</span>
          <span className="rz-today__note">
            {checkin?.note ||
              tr(
                "Wat ging er deze week vooruit? Leg je voortgang vast en bepaal je volgende stap.",
              )}
          </span>
          <span className="rz-today__card-action">
            <span className="rz-today__cta">{tr("Check-in doen →")}</span>
            <span className="rz-today__card-foot">
              {checkin
                ? tr("laatste {0}", formatDate(checkin.createdAt, true))
                : tr("Nog geen check-in")}
            </span>
          </span>
        </Card>
      </Cards>
      {headline.count > 0 && (
        <Section aria-label={tr("Wacht op jou")}>
          <SectionLabel dot="accent">
            <Heading>{tr("Wacht op jou")}</Heading>
          </SectionLabel>
          {attention.map(({ task, session, kind }) => {
            const openIt = () =>
              kind === "waiting" && session
                ? openSession(session)
                : openTask(task!, kind === "review");
            return (
              <Row
                as="div"
                size="lg"
                key={task?.id || session!.id}
                data-test="today-pro-waiting"
                data-task-id={task?.id}
                onClick={openIt}
              >
                {kind === "waiting" && session ? (
                  <Avatar provider={session.provider} name={userName} />
                ) : task!.kind === "human" || task!.provider === "shell" ? (
                  <Avatar name={userName} />
                ) : (
                  <Avatar provider={task!.provider || "claude"} />
                )}
                <RowText
                  wrap
                  title={task?.title || sessionTitle(session!, snap)}
                  meta={
                    kind === "review"
                      ? reviewMeta(task!)
                      : join([
                          kind === "waiting" && session
                            ? providerName(session.provider)
                            : taskProvider(task!),
                          projectName(task?.projectId),
                          kind === "waiting"
                            ? tr("Wacht op je antwoord")
                            : tr("Geblokkeerd"),
                        ])
                  }
                />
                <Button
                  className="rz-today__pill"
                  variant={kind === "review" ? "primary" : "secondary"}
                  size="row"
                  onClick={only(openIt)}
                >
                  {kind === "review"
                    ? tr("Beoordelen")
                    : kind === "waiting"
                      ? tr("Antwoorden")
                      : tr("Bekijk blokkade")}
                </Button>
              </Row>
            );
          })}
          {proposals.map((p) => {
            const provider = snap.sessions.find(
              (s) => s.id === p.sessionId,
            )?.provider;
            return (
              <Row
                as="div"
                size="lg"
                key={p.id}
                data-test="today-pro-waiting"
                onClick={() => showProposal(p)}
              >
                <Avatar provider={provider} name={userName} />
                <RowText
                  wrap
                  title={proposalTitle(p)}
                  meta={tr("Voorstel voor {0}", company.name)}
                />
                <Button
                  className="rz-today__pill"
                  size="row"
                  onClick={only(() => showProposal(p))}
                >
                  {tr("Voorstel bekijken")}
                </Button>
              </Row>
            );
          })}
        </Section>
      )}
      <Section aria-label={tr("Verdergaan")}>
        <SectionLabel
          right={
            <TextButton tone="meta" onClick={() => navigate("workspace")}>
              {tr("Alles")}
              <ArrowRight size={12} aria-hidden="true" />
            </TextButton>
          }
        >
          <Heading>{tr("Verdergaan")}</Heading>
        </SectionLabel>
        {continuing.map((s) => {
          const status = conversationStatus(s, snap);
          return (
            <Row
              as="button"
              size="md"
              key={s.id}
              data-test="today-pro-session"
              data-session-id={s.id}
              onClick={() => openSession(s)}
            >
              <Avatar provider={s.provider} name={userName} />
              <RowText
                title={sessionTitle(s, snap)}
                titleProps={{ "data-test": "today-pro-session-title" }}
                meta={join([
                  providerName(s.provider),
                  projectName(
                    snap.tasks.find((t) => t.id === s.taskId)?.projectId,
                  ),
                  s.memory?.blockers?.[0] ||
                    s.memory?.nextSteps?.[0] ||
                    s.memory?.summary ||
                    (s.agentRunning
                      ? tr("Je assistent werkt aan deze opdracht.")
                      : tr("Open het gesprek om verder te gaan.")),
                ])}
              />
              <StatusDot tone={status.tone} label={status.label} size={12} />
            </Row>
          );
        })}
        {!continuing.length && (
          <p className="rz-today__empty">
            {tr("Geen lopende gesprekken. Open een taak om verder te gaan.")}
          </p>
        )}
      </Section>
      <Section aria-label={tr("Gepland voor vandaag")}>
        <SectionLabel
          right={
            <>
              {!!planned.length && (
                <span>
                  {openPlanned
                    ? tr("{0} open", openPlanned)
                    : tr("alles gedaan")}
                </span>
              )}
              <TextButton tone="meta" onClick={allTasks}>
                {tr("Alle taken")}
                <ArrowRight size={12} aria-hidden="true" />
              </TextButton>
            </>
          }
        >
          <Heading>{tr("Gepland voor vandaag")}</Heading>
        </SectionLabel>
        {planned.map((t) => {
          const done = checks.isDone(t),
            late = !!t.dueDate && t.dueDate < today && !done;
          return (
            <Row
              as="div"
              key={t.id}
              done={done}
              data-test="today-pro-planned"
              data-task-id={t.id}
              onClick={() => openTask(t)}
            >
              <TaskCheck task={t} checks={checks} />
              <button type="button" className="rz-today__open">
                <RowText title={t.title} meta={plannedMeta(t)} />
              </button>
              <Due className="rz-today__due" late={late}>
                {dueText(t)}
              </Due>
            </Row>
          );
        })}
        {!planned.length && (
          <p className="rz-today__empty">
            {tr(
              "Geen taken gepland voor vandaag. Je toekomstige taken vind je bij ‘Alle taken’ → ‘Later’.",
            )}
          </p>
        )}
      </Section>
      <Suggestions />
    </>
  );
}

export function Today() {
  const { company } = useWorkbench();
  const [list, setList] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  // One scroller serves both views: the other view starts at its top.
  useLayoutEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [list]);
  if (!company) return null;
  return (
    <PageShell
      className={list ? undefined : "rz-page--today"}
      scrollRef={scroller}
      composer={
        <TaskComposer
          key={`today:${company.id}`}
          draftScope={`today:${company.id}`}
          placeholder={tr("Geef een taak")}
          selfHint={tr("Komt op je lijst voor vandaag")}
          expandLabel={tr("Nieuwe taak")}
          scheduleToday
        />
      }
    >
      {list ? (
        <TodayTasks back={() => setList(false)} />
      ) : (
        <TodayMain allTasks={() => setList(true)} />
      )}
    </PageShell>
  );
}
