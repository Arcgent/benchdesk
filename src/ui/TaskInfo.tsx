import { t as tr } from "../shared/i18n";
import { TaskScheduleInfo } from "./TaskSchedule";
import { ArrowRight, ChevronRight, FileText, Plus, X } from "lucide-react";
import type { Task } from "../shared/types";
import { localDate } from "../shared/task-schedule";
import { api, useWorkbench, useCriterionChecks } from "./model";
import {
  formatDate,
  formatDayMonth,
  isBlocked,
  projectTint,
  statusLabel,
  statusTone,
  taskProvider,
} from "./primitives";
import {
  Badge,
  Button,
  Check,
  IconButton,
  Row,
  RowText,
  Section,
  SectionLabel,
  StatusDot,
  TextButton,
} from "./rz";

export function TaskInfo({ task, close }: { task: Task; close?: () => void }) {
  const { snap, edit, run, openTask, showFile } = useWorkbench();
  const { criteria, check } = useCriterionChecks(task);
  const project = snap.projects.find((p) => p.id === task.projectId);
  const files = snap.artifacts.filter((a) => a.taskId === task.id);
  const blocked = isBlocked(task, snap);
  const status = blocked ? "blocked" : task.status;
  const waitingOn = task.dependencies
    .map((id) => snap.tasks.find((t) => t.id === id))
    .filter((t): t is Task => !!t && t.status !== "done");
  const events = snap.events.filter((e) => e.taskId === task.id).slice(0, 5);
  const late =
    !!task.dueDate && task.status !== "done" && task.dueDate < localDate();
  return (
    <aside
      className="rz-task-info"
      data-test="task-info"
      aria-label={tr("Taakinfo")}
    >
      <header className="rz-task-info__head">
        <Badge
          name={project?.name || tr("Taak")}
          tint={project ? projectTint(project, snap) : undefined}
        />
        <span className="rz-task-info__project">
          {project?.name || tr("Taak")}
        </span>
        {close && (
          <IconButton size="sm" label={tr("Taakinfo sluiten")} onClick={close}>
            <X size={14} />
          </IconButton>
        )}
      </header>
      <div className="rz-task-info__body">
        <div className="rz-task-info__intro">
          <div className="rz-task-info__meta">
            <StatusDot
              tone={statusTone("task", status)}
              label={statusLabel("task", status)}
            />
            <span>· {taskProvider(task)}</span>
            {task.dueDate && (
              <span data-late={late ? "" : undefined}>
                · {tr("deadline {0}", formatDate(task.dueDate, true))}
              </span>
            )}
          </div>
          <h2 className="rz-task-info__title">{task.title}</h2>
          <div className="rz-task-info__schedule">
            <TaskScheduleInfo task={task} />
          </div>
          <p
            className="rz-task-info__text"
            data-empty={task.description ? undefined : ""}
          >
            {task.description ||
              tr(
                "Voeg een opdracht toe zodat duidelijk is wat je wilt opleveren.",
              )}
          </p>
        </div>
        <Section tight>
          <SectionLabel
            as="h3"
            right={
              criteria.length
                ? tr(
                    "{0} van {1}",
                    criteria.filter((c) => c.checked).length,
                    criteria.length,
                  )
                : undefined
            }
          >
            {tr("Klaar als")}
          </SectionLabel>
          {criteria.map((criterion) => (
            <div
              className="rz-task-info__criterion"
              key={criterion.id}
              onClick={() => check(criterion.id, !criterion.checked)}
            >
              <Check
                shape="square"
                checked={criterion.checked}
                label={criterion.text}
                onChange={(checked) => check(criterion.id, checked)}
                onClick={(e) => e.stopPropagation()}
              />
              <span>{criterion.text}</span>
            </div>
          ))}
          {!criteria.length && (
            <div className="rz-task-info__line">
              <TextButton
                tone="meta"
                icon={<Plus size={12} aria-hidden="true" />}
                onClick={() => edit("task", task)}
              >
                {tr("Criteria toevoegen")}
              </TextButton>
            </div>
          )}
        </Section>
        {blocked && waitingOn.length > 0 && (
          <Section tight>
            <SectionLabel as="h3" dot="warn">
              {tr("Wacht op")}
            </SectionLabel>
            {waitingOn.map((dependency) => (
              <Row
                as="button"
                size="xs"
                cols="minmax(0, 1fr) auto"
                className="rz-task-info__row"
                key={dependency.id}
                onClick={() => openTask(dependency)}
              >
                <RowText title={dependency.title} />
                <ArrowRight
                  className="rz-task-info__arrow"
                  size={12}
                  aria-hidden="true"
                />
              </Row>
            ))}
          </Section>
        )}
        <Section tight>
          <div className="rz-task-info__label-row">
            <SectionLabel as="h3" className="rz-task-info__label">
              {tr("Bestanden")}
            </SectionLabel>
            <IconButton
              size="xs"
              label={tr("Bestand koppelen")}
              onClick={() =>
                void run(async () => {
                  const paths = await window.werk.selectFiles();
                  for (const path of paths)
                    await api("artifact.add", { taskId: task.id, path });
                })
              }
            >
              <Plus size={13} />
            </IconButton>
          </div>
          {files.map((file) => (
            <Row
              as="button"
              size="sm"
              cols="28px minmax(0, 1fr) auto"
              className="rz-task-info__file"
              key={file.id}
              title={file.name}
              onClick={() => showFile(file.path)}
            >
              <span className="rz-task-info__tile" aria-hidden="true">
                <FileText size={13} />
              </span>
              <RowText title={file.name} />
              <span className="rz-task-info__when">
                {formatDayMonth(file.createdAt)}
              </span>
            </Row>
          ))}
          {!files.length && (
            <p className="rz-task-info__line rz-task-info__hint">
              {tr("Opgeleverde bestanden komen hier.")}
            </p>
          )}
        </Section>
        {task.resultSummary && (
          <details className="rz-disclosure rz-task-info__more">
            <summary>
              {tr("Laatste resultaat")}
              <ChevronRight size={11} aria-hidden="true" />
            </summary>
            <p>{task.resultSummary}</p>
          </details>
        )}
        {events.length > 0 && (
          <details className="rz-disclosure rz-task-info__more">
            <summary>
              {tr("Voortgang")}
              <ChevronRight size={11} aria-hidden="true" />
            </summary>
            {events.map((e) => (
              <div className="rz-task-info__event" key={e.id}>
                <p>{e.summary}</p>
                <small>{formatDate(e.createdAt)}</small>
              </div>
            ))}
          </details>
        )}
      </div>
      <footer className="rz-task-info__foot">
        {task.status === "review" ? (
          <Button variant="primary" onClick={() => openTask(task, true)}>
            {tr("Resultaat beoordelen")}
          </Button>
        ) : task.status === "done" ? (
          <Button
            onClick={() =>
              void run(() =>
                api("task.patch", { id: task.id, patch: { status: "todo" } }),
              )
            }
          >
            {tr("Taak heropenen")}
          </Button>
        ) : (
          <Button
            variant="primary"
            data-submit-task
            disabled={blocked}
            title={tr("Indienen ter beoordeling (⌘↵)")}
            onClick={() =>
              void run(
                () => api("task.submit", { id: task.id }),
                tr("Ingediend ter beoordeling."),
              )
            }
          >
            {tr("Indienen ter beoordeling")}
          </Button>
        )}
        <Button variant="ghost" onClick={() => edit("task", task)}>
          {tr("Bewerken")}
        </Button>
      </footer>
    </aside>
  );
}
