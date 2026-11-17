import { t as tr } from "../shared/i18n";
import { useState } from "react";
import { Plus } from "lucide-react";
import type { Project } from "../shared/types";
import { useWorkbench } from "./model";
import { formatDate, projectTint, statusLabel, statusTone } from "./primitives";
import { projectOverview, localDay } from "./overview";
import {
  Badge,
  Bar,
  Button,
  Card,
  Cards,
  Due,
  Empty,
  PageHead,
  PageShell,
  Row,
  RowText,
  Section,
  StatusDot,
  Tabs,
  TextButton,
  ViewSwitch,
  cx,
  useSavedView,
  type Tone,
} from "./rz";

type Filter = "active" | "done" | "all";
type Overview = ReturnType<typeof projectOverview>;
type Item = { p: Project; s: Overview };

const matches = (s: Overview, filter: Filter) =>
  filter === "all" || (s.status === "done") === (filter === "done");
const pct = (s: Overview) =>
  s.total ? Math.round((s.done / s.total) * 100) : 0;
// Design: a finished project is accent, work in progress blue, nothing done yet shows the empty track.
const barTone = (s: Overview): Tone =>
  s.status === "done" ? "accent" : s.done ? "blue" : "muted";
const progressText = (s: Overview) =>
  !s.total
    ? "—"
    : s.total === 1
      ? tr("{0} van {1} taak", s.done, s.total)
      : tr("{0} van {1} taken", s.done, s.total);

export function ProProjectsPage() {
  const { snap, companyId, edit, navigate } = useWorkbench();
  const [tab, setTab] = useState<Filter>("active");
  const [view, setView] = useSavedView("projectenrustig.view", "list");
  const list = view === "list",
    today = localDay();
  const departments = snap.departments.filter((d) => d.companyId === companyId);
  const known = new Set(departments.map((d) => d.id));
  const items: Item[] = snap.projects
    .filter((p) => p.companyId === companyId)
    .map((p) => ({ p, s: projectOverview(p, snap) }));
  const count = (filter: Filter) =>
    items.filter(({ s }) => matches(s, filter)).length;
  const tabs: { id: Filter; label: string; count: number }[] = [
    { id: "active", label: tr("Actief"), count: count("active") },
    { id: "done", label: tr("Afgerond"), count: count("done") },
    { id: "all", label: tr("Alle"), count: count("all") },
  ];
  // A department without any project stays visible (it could not be edited or filled otherwise); one whose
  // projects are all filtered out by the tab is left out, like "Zonder afdeling" without matches.
  const groups = [...departments, null]
    .map((d) => {
      const own = items.filter(
        ({ p }) =>
          (p.departmentId && known.has(p.departmentId)
            ? p.departmentId
            : null) === (d?.id || null),
      );
      return {
        d,
        unused: !own.length,
        rows: own.filter(({ s }) => matches(s, tab)),
      };
    })
    .filter((g) => g.rows.length || (g.d && g.unused));
  const shown = groups.reduce((n, g) => n + g.rows.length, 0);
  const goalOf = (p: Project) =>
    snap.goals.find((g) => g.id === p.goalId)?.title ||
    tr("Geen doel gekoppeld");
  const status = (s: Overview) => (
    <StatusDot
      tone={statusTone("project", s.status)}
      label={statusLabel("project", s.status)}
    />
  );
  const due = (s: Overview) => {
    const late = !!s.deadline && s.deadline < today;
    return (
      <Due
        className="rz-projects__due"
        late={late}
        title={late ? tr("Deadline verlopen") : undefined}
      >
        {s.deadline ? formatDate(s.deadline, true) : "—"}
        {late && <span className="rz-sr"> · {tr("Deadline verlopen")}</span>}
      </Due>
    );
  };
  return (
    <PageShell width="wide" data-test="projects-page">
      <PageHead
        title={tr("Projecten")}
        meta={
          <>
            {tr("{0} actief", count("active"))}
            {departments.length > 0 &&
              " · " +
                (departments.length === 1
                  ? tr("{0} afdeling", departments.length)
                  : tr("{0} afdelingen", departments.length))}
          </>
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => edit("department")}>
              {tr("Nieuwe afdeling")}
            </Button>
            <Button variant="primary" onClick={() => edit("project")}>
              {tr("Nieuw project")}
            </Button>
          </>
        }
      />
      <div className="rz-tabbar">
        <Tabs
          data-test="pro-tabs"
          label={tr("Projecten filteren")}
          tabs={tabs}
          value={tab}
          onChange={setTab}
        />
        <ViewSwitch view={view} set={setView} />
      </div>
      {!items.length && !departments.length ? (
        <Empty
          title={tr("Nog geen projecten")}
          action={
            <Button variant="primary" onClick={() => edit("project")}>
              {tr("Nieuw project")}
            </Button>
          }
        />
      ) : (
        <div
          className={cx(
            "rz-projects__groups",
            list && "rz-projects__groups--list",
          )}
          role="tabpanel"
          aria-label={tabs.find((t) => t.id === tab)?.label}
        >
          {!shown && items.length > 0 && (
            <p className="rz-projects__none">
              {tr("Geen projecten in deze weergave.")}
            </p>
          )}
          {groups.map(({ d, rows }) => {
            const name = d?.name || tr("Zonder afdeling");
            return (
              <Section
                tight
                className="rz-projects__group"
                aria-label={name}
                key={d?.id || "none"}
              >
                <div className="rz-label rz-label--split rz-projects__label">
                  <div className="rz-projects__label-text">
                    <h2 className="rz-label__name rz-projects__dept">{name}</h2>
                    {d?.description && (
                      <p className="rz-projects__desc">{d.description}</p>
                    )}
                  </div>
                  <div className="rz-label__right">
                    {d && (
                      <TextButton
                        tone="meta"
                        className="rz-projects__edit"
                        aria-label={tr("{0} bewerken", d.name)}
                        onClick={() => edit("department", d)}
                      >
                        {tr("Bewerken")}
                      </TextButton>
                    )}
                    <TextButton
                      tone="meta"
                      icon={<Plus size={11} aria-hidden="true" />}
                      aria-label={
                        d
                          ? tr("Project toevoegen in {0}", d.name)
                          : tr("Project toevoegen zonder afdeling")
                      }
                      onClick={() =>
                        edit("project", { departmentId: d?.id || null })
                      }
                    >
                      {tr("Project")}
                    </TextButton>
                  </div>
                </div>
                {list
                  ? rows.map(({ p, s }) => (
                      <Row
                        as="button"
                        className="rz-projects__row"
                        data-test="project-overview-row"
                        data-project-id={p.id}
                        key={p.id}
                        onClick={() => navigate(p.id)}
                      >
                        <Badge
                          name={p.name}
                          tint={projectTint(p, snap)}
                          size={24}
                        />
                        <RowText title={p.name} meta={goalOf(p)} />
                        {status(s)}
                        <span className="rz-meter rz-projects__progress">
                          <span className="rz-meter__top">
                            <span className="rz-ellipsis">
                              {progressText(s)}
                            </span>
                            {s.total > 0 && <span>{pct(s)}%</span>}
                          </span>
                          <Bar pct={pct(s)} tone={barTone(s)} />
                        </span>
                        {due(s)}
                      </Row>
                    ))
                  : rows.length > 0 && (
                      <Cards className="rz-projects__cards">
                        {rows.map(({ p, s }) => (
                          <Card
                            as="button"
                            variant="project"
                            data-test="project-overview-card"
                            data-project-id={p.id}
                            key={p.id}
                            onClick={() => navigate(p.id)}
                          >
                            <span className="rz-projects__card-top">
                              <Badge
                                name={p.name}
                                tint={projectTint(p, snap)}
                                size={26}
                              />
                              {status(s)}
                            </span>
                            <span className="rz-projects__card-text">
                              <span className="rz-projects__card-name">
                                {p.name}
                              </span>
                              <span className="rz-projects__card-goal">
                                {goalOf(p)}
                              </span>
                            </span>
                            <span className="rz-meter rz-projects__card-foot">
                              <span className="rz-meter__top">
                                <span>{progressText(s)}</span>
                                {due(s)}
                              </span>
                              <Bar pct={pct(s)} tone={barTone(s)} />
                            </span>
                          </Card>
                        ))}
                      </Cards>
                    )}
                {!rows.length && (
                  <p className="rz-projects__none">
                    {tr("Nog geen projecten in deze afdeling.")}
                  </p>
                )}
              </Section>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
