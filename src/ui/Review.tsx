import { t as tr } from "../shared/i18n";
import { useContext, useState } from "react";
import { FileText, Link2, PanelLeft } from "lucide-react";
import type { Criterion, Task } from "../shared/types";
import { api, useWorkbench, useCriterionChecks } from "./model";
import {
  formatDate,
  formatTime,
  providerName,
  taskProvider,
} from "./primitives";
import {
  Avatar,
  Button,
  Check,
  Chip,
  Crumbs,
  Empty,
  IconButton,
  Row,
  Section,
  SectionLabel,
  ShellContext,
  TextButton,
  Textarea,
} from "./rz";
import { FileViewer } from "./FileViewer";

const isLink = (path: string) => /^https?:/i.test(path);
// "20:34" today, "di 15 sep 20:34" on any other day: a bare time would suggest today.
const stamp = (value: string) =>
  new Date(value).toDateString() === new Date().toDateString()
    ? formatTime(value)
    : `${formatDate(value)} ${formatTime(value)}`;
// Where a criterion points in the viewer. A link has no lines.
const evidenceOf = (criterion?: Criterion) =>
  criterion?.evidence
    ? {
        path: criterion.evidence.path,
        line: isLink(criterion.evidence.path) ? 0 : criterion.evidence.line,
      }
    : null;

export function Review({ task }: { task: Task }) {
  const { snap, prefs, info, run, openTask, openSession, launch, navigate } =
    useWorkbench();
  const shell = useContext(ShellContext);
  const { criteria, check } = useCriterionChecks(task);
  const [comments, setComments] = useState<Record<string, string>>(() =>
    Object.fromEntries(criteria.map((c) => [c.id, c.comment])),
  );
  // Design: the page opens on the first point that still needs attention, with its line highlighted.
  const [selected, setSelected] = useState<string | null>(
    () => criteria.find((c) => !c.checked)?.id ?? null,
  );
  const [file, setFile] = useState<{ path?: string; line: number }>(() => {
    const evidence = evidenceOf(criteria.find((c) => !c.checked));
    return evidence && !isLink(evidence.path)
      ? evidence
      : {
          path: snap.artifacts.find((a) => a.taskId === task.id)?.path,
          line: 0,
        };
  });
  const [busy, setBusy] = useState(false),
    [more, setMore] = useState(false);
  const project = snap.projects.find((p) => p.id === task.projectId),
    files = snap.artifacts.filter((a) => a.taskId === task.id);
  const submitted = snap.events.find(
    (e) => e.taskId === task.id && e.kind === "result",
  );
  const session =
    snap.sessions.find((s) => s.id === submitted?.sessionId) ||
    [...snap.sessions]
      .filter((s) => s.taskId === task.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const checked = criteria.filter((c) => c.checked).length,
    open = criteria.length - checked,
    none = criteria.length === 0,
    all = !none && open === 0;
  const hasComments = criteria.some(
    (c) => !c.checked && comments[c.id]?.trim(),
  );
  const provider = session
    ? providerName(session.provider)
    : taskProvider(task);
  const human = session
    ? session.provider === "shell"
    : task.kind === "human" || task.provider === "shell";
  // Mirrors the runner: feedback only lands in the same conversation while an assistant is running for this task.
  const live = snap.sessions.some(
    (s) => s.taskId === task.id && ((s.alive && s.agentRunning) || s.transport === "chat"),
  );
  const summary = task.resultSummary.trim(),
    long = summary.length > 280;
  const persistComments = async () => {
    for (const criterion of criteria)
      if ((comments[criterion.id] || "") !== criterion.comment)
        await api("task.criterion", {
          id: task.id,
          criterionId: criterion.id,
          patch: { comment: comments[criterion.id] || "" },
        });
  };
  const approve = () => {
    setBusy(true);
    void run(async () => {
      await persistComments();
      await api("task.complete", { id: task.id, note: task.resultSummary });
      navigate("today");
    }, tr("Taak goedgekeurd en afgerond.")).finally(() => setBusy(false));
  };
  const returnWithFeedback = () => {
    setBusy(true);
    void run(async () => {
      await persistComments();
      const result = await api<{ sessionId: string | null; queued: boolean }>(
        "task.return",
        { id: task.id },
      );
      if (result.sessionId) {
        const active = snap.sessions.find((s) => s.id === result.sessionId);
        if (active) openSession(active);
      } else {
        openTask(task);
        const last = [...snap.sessions]
          .filter((s) => s.taskId === task.id && s.provider !== "shell")
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        launch({
          companyId: task.companyId,
          taskId: task.id,
          mode: "work",
          ...(last?.providerSessionId ? { resume: last } : {}),
        });
      }
    }).finally(() => setBusy(false));
  };
  const show = (criterion: Criterion) => {
    setSelected(criterion.id);
    const evidence = evidenceOf(criterion);
    if (evidence) setFile(evidence);
  };
  // Left list and right tabs share one selection; coming back to the file of the selected point restores its line.
  const pickFile = (path: string) => {
    const evidence = evidenceOf(criteria.find((c) => c.id === selected));
    setFile({ path, line: evidence?.path === path ? evidence.line : 0 });
  };
  const mod = info.platform === "darwin" ? "⌘" : "Ctrl+";
  return (
    <div className="rz-main rz-review" data-test="review-page">
      {/* Full-bleed page without PageShell: it brings the same "Zijbalk tonen" button itself. */}
      {shell && !shell.sidebarOpen && (
        <IconButton
          className="rz-main__side-toggle rz-nodrag"
          label={tr("Zijbalk tonen")}
          onClick={shell.showSidebar}
        >
          <PanelLeft size={16} />
        </IconButton>
      )}
      <div className="rz-review__grid">
        <section className="rz-review__left" aria-label={tr("Beoordeling")}>
          <div className="rz-review__scroll">
            <header className="rz-review__head">
              <Crumbs
                items={[
                  ...(project
                    ? [
                        {
                          label: project.name,
                          onClick: () => navigate(project.id),
                        },
                      ]
                    : []),
                  {
                    label: /beoordelen$/i.test(task.title.trim())
                      ? task.title
                      : tr("{0} beoordelen", task.title),
                  },
                ]}
              />
              <h1 className="rz-h1 rz-h1--review">
                {all
                  ? tr("Alles akkoord. Taak afronden?")
                  : criteria.length
                    ? tr(
                        "{0} van {1} {2} {3} nog aandacht.",
                        open,
                        criteria.length,
                        criteria.length === 1 ? tr("punt") : tr("punten"),
                        open === 1 ? tr("vraagt") : tr("vragen"),
                      )
                    : tr("Controleer het resultaat.")}
              </h1>
              <div className="rz-review__meta">
                {human ? (
                  <Avatar size={22} name={prefs.profile.name || tr("Jij")} />
                ) : (
                  <Avatar
                    size={22}
                    provider={session?.provider || task.provider || "claude"}
                  />
                )}
                <span>
                  {[
                    tr(
                      "{0} · ingediend {1}",
                      provider,
                      stamp(submitted?.createdAt || task.updatedAt),
                    ),
                    none
                      ? ""
                      : tr("{0} van {1} akkoord", checked, criteria.length),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                {session && (
                  <TextButton tone="meta" onClick={() => openSession(session)}>
                    {tr("Gesprek bekijken")}
                  </TextButton>
                )}
              </div>
              {summary && (
                <div className="rz-review__summary">
                  <p data-clamped={long && !more ? "" : undefined}>{summary}</p>
                  {long && (
                    <TextButton
                      tone="meta"
                      aria-expanded={more}
                      onClick={() => setMore(!more)}
                    >
                      {more ? tr("Minder tonen") : tr("Meer tonen")}
                    </TextButton>
                  )}
                </div>
              )}
            </header>
            <Section tight>
              <SectionLabel as="h2">{tr("Klaar als")}</SectionLabel>
              {criteria.map((criterion) => {
                const note =
                  criterion.agentNote ||
                  (human ? "" : tr("Nog geen toelichting van de assistent."));
                const comment = comments[criterion.id] || "";
                return (
                  <div
                    className="rz-review__criterion"
                    key={criterion.id}
                    data-test="review-criterion"
                    data-criterion-id={criterion.id}
                    data-selected={selected === criterion.id ? "" : undefined}
                    aria-current={
                      selected === criterion.id ? "true" : undefined
                    }
                  >
                    <div
                      className="rz-review__criterion-row"
                      onClick={() => show(criterion)}
                    >
                      <Check
                        shape="square"
                        checked={criterion.checked}
                        label={tr("Akkoord: {0}", criterion.text)}
                        onChange={(value) => {
                          if (!value) setSelected(criterion.id);
                          check(criterion.id, value);
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <div className="rz-review__criterion-text">
                        <button
                          type="button"
                          className="rz-review__criterion-title"
                        >
                          {criterion.text}
                        </button>
                        {note && (
                          <span
                            className="rz-review__note"
                            data-open={criterion.checked ? undefined : ""}
                          >
                            {note}
                          </span>
                        )}
                      </div>
                      {criterion.evidence && (
                        <Chip
                          variant="mono"
                          className="rz-review__line"
                          title={
                            isLink(criterion.evidence.path)
                              ? tr("Link openen")
                              : tr("Toon in bestand")
                          }
                          aria-label={
                            isLink(criterion.evidence.path)
                              ? tr("Link bij {0}", criterion.text)
                              : `${criterion.evidence.path.split("/").pop()}:${criterion.evidence.line}`
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            show(criterion);
                          }}
                        >
                          {isLink(criterion.evidence.path)
                            ? tr("link")
                            : tr("r. {0}", criterion.evidence.line)}
                        </Chip>
                      )}
                    </div>
                    {/* Open on the selected point; a written comment never disappears from view. */}
                    {!criterion.checked &&
                      (selected === criterion.id || comment) && (
                        <div className="rz-review__comment">
                          <Textarea
                            small
                            rows={2}
                            aria-label={tr("Opmerking bij {0}", criterion.text)}
                            placeholder={
                              human
                                ? tr("Wat moet er anders?")
                                : tr(
                                    "Wat moet er anders? {0} leest dit mee.",
                                    provider,
                                  )
                            }
                            value={comment}
                            onChange={(e) =>
                              setComments((value) => ({
                                ...value,
                                [criterion.id]: e.target.value,
                              }))
                            }
                            onBlur={() => {
                              if (comment !== criterion.comment)
                                void run(() =>
                                  api("task.criterion", {
                                    id: task.id,
                                    criterionId: criterion.id,
                                    patch: { comment },
                                  }),
                                );
                            }}
                          />
                        </div>
                      )}
                  </div>
                );
              })}
              {none && (
                <Empty
                  inline
                  title={tr("Er zijn nog geen criteria vastgelegd.")}
                >
                  {tr(
                    "Bekijk de bestanden en keur het resultaat goed zoals het is, of werk zelf verder.",
                  )}
                </Empty>
              )}
            </Section>
            {files.length > 0 && (
              <Section tight>
                <SectionLabel as="h2">{tr("Opgeleverd")}</SectionLabel>
                {files.map((artifact) => (
                  <Row
                    as="button"
                    size="sm"
                    className="rz-review__file"
                    key={artifact.id}
                    data-test="review-file"
                    selected={file.path === artifact.path}
                    title={artifact.name}
                    onClick={() => pickFile(artifact.path)}
                  >
                    <span className="rz-tile" aria-hidden="true">
                      {isLink(artifact.path) ? (
                        <Link2 size={13} />
                      ) : (
                        <FileText size={13} />
                      )}
                    </span>
                    <span className="rz-row__title">{artifact.name}</span>
                    {/* The model knows when a file was linked to the task, not when it was last edited. */}
                    <span className="rz-row__meta">
                      {isLink(artifact.path)
                        ? tr("link")
                        : tr("toegevoegd {0}", stamp(artifact.createdAt))}
                    </span>
                  </Row>
                ))}
              </Section>
            )}
          </div>
          <footer className="rz-review__foot">
            <div className="rz-review__actions">
              <Button
                variant="primary"
                data-primary-action={all ? true : undefined}
                data-review-submit
                disabled={busy || (!all && !none && !hasComments)}
                title={tr("Sneltoets: {0}", all ? "↵" : `${mod}↵`)}
                onClick={all || none ? approve : returnWithFeedback}
              >
                {all
                  ? tr("Goedkeuren en afronden")
                  : none
                    ? tr("Goedkeuren zoals het is")
                    : tr("Terug naar {0} met opmerking", provider)}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  void run(async () => {
                    await persistComments();
                    openTask(task);
                  });
                }}
              >
                {tr("Zelf verder werken")}
              </Button>
              {!all && !none && (
                <Button variant="quiet" disabled={busy} onClick={approve}>
                  {tr("Goedkeuren zoals het is")}
                </Button>
              )}
            </div>
            <span className="rz-review__footnote">
              {all || none
                ? tr("De taak gaat naar Afgerond.")
                : !hasComments
                  ? tr("Schrijf bij een open punt wat er anders moet.")
                  : human
                    ? tr(
                        "De taak gaat terug naar Bezig, met je opmerking erbij.",
                      )
                    : live
                      ? tr(
                          "{0} krijgt je opmerking en werkt verder in hetzelfde gesprek.",
                          provider,
                        )
                      : tr(
                          "{0} krijgt je opmerking mee zodra je het gesprek hervat.",
                          provider,
                        )}
            </span>
          </footer>
        </section>
        <FileViewer
          className="rz-review__viewer"
          drag
          path={file.path}
          line={file.line}
          files={files}
          onSelect={pickFile}
          onLine={(line) => setFile((current) => ({ ...current, line }))}
        />
      </div>
    </div>
  );
}
