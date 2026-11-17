import { t as tr, locale } from "../shared/i18n";
import { useEffect, useRef, useState } from "react";
import { FileText, Folder, Plus, Sparkle } from "lucide-react";
import type { Checkin } from "../shared/types";
import { api, useWorkbench } from "./model";
import { formatDate, goalView, projectTint, shortPath } from "./primitives";
import { projectOverview } from "./overview";
import {
  Badge,
  Bar,
  Button,
  Card,
  Cards,
  Due,
  Empty,
  Field,
  Modal,
  ModalBody,
  ModalFoot,
  PageHead,
  PageShell,
  Row,
  RowEnd,
  RowText,
  Section,
  SectionLabel,
  Select,
  Tabs,
  TextButton,
  Textarea,
  cx,
} from "./rz";

type Tab = "goals" | "checkins" | "profile";
type FieldKey = "product" | "audience" | "stage" | "bottleneck";
type Measurement = NonNullable<Checkin["measurements"]>[number];
const amount = (m: Measurement, value: number) =>
  (m.unit.trim() === "€" ? "€" : "") + value.toLocaleString(locale());

export function ProCompanyPage() {
  const { snap, company, companyId, edit, launch, navigate, run, showFile } =
    useWorkbench();
  const [tab, setTab] = useState<Tab>("goals");
  // undefined = nothing chosen yet (the main goal is open), null = closed by the user
  const [selected, setSelected] = useState<string | null | undefined>(
    undefined,
  );
  const [link, setLink] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Record<FieldKey, string>>({
    product: "",
    audience: "",
    stage: "",
    bottleneck: "",
  });
  const [focusKey, setFocusKey] = useState<FieldKey | null>(null);
  const inputs = useRef<Partial<Record<FieldKey, HTMLTextAreaElement | null>>>(
    {},
  );
  const pill = useRef<HTMLButtonElement>(null);
  const was = useRef({ editing: false, saving: false });
  useEffect(() => {
    if (!editing || !focusKey) return;
    const node = inputs.current[focusKey];
    node?.focus();
    node?.setSelectionRange(node.value.length, node.value.length);
    setFocusKey(null);
  }, [editing, focusKey]);
  // Leaving edit mode unmounts the focused textarea, and a save disables the focused pill: hand the focus back.
  useEffect(() => {
    const lost =
      (was.current.editing && !editing) || (was.current.saving && !saving);
    was.current = { editing, saving };
    const active = document.activeElement;
    if (
      lost &&
      (!active || active === document.body || active === pill.current)
    )
      pill.current?.focus();
  }, [editing, saving]);
  if (!company) return null;
  const goals = snap.goals.filter((g) => g.companyId === companyId);
  const goal =
    selected === undefined
      ? goals.find((g) => g.primary) || goals[0]
      : goals.find((g) => g.id === selected);
  const checkins = snap.checkins.filter((c) => c.companyId === companyId);
  const projects = snap.projects.filter((p) => p.companyId === companyId);
  const linkable = goal ? projects.filter((p) => p.goalId !== goal.id) : [];
  const fields: { key: FieldKey; label: string; rows: number }[] = [
    { key: "product", label: tr("Aanbod"), rows: 2 },
    { key: "audience", label: tr("Doelgroep"), rows: 2 },
    { key: "stage", label: tr("Fase"), rows: 1 },
    { key: "bottleneck", label: tr("Knelpunt"), rows: 1 },
  ];
  const meta = [
    company.stage && tr("Fase: {0}", company.stage),
    tr("profiel bijgewerkt {0}", formatDate(company.updatedAt)),
    company.workspacePath && tr("werkmap gekoppeld"),
  ]
    .filter(Boolean)
    .join(" · ");
  const dirty = fields.some(({ key }) => draft[key] !== company[key]);
  const startEdit = (key: FieldKey = "product") => {
    setDraft({
      product: company.product,
      audience: company.audience,
      stage: company.stage,
      bottleneck: company.bottleneck,
    });
    setFocusKey(key);
    setEditing(true);
  };
  const saveProfile = async () => {
    setSaving(true);
    const id = await run(() =>
      api("company.save", {
        id: company.id,
        value: {
          name: company.name,
          workspacePath: company.workspacePath,
          color: company.color,
          product: draft.product,
          audience: draft.audience,
          stage: draft.stage,
          bottleneck: draft.bottleneck,
          sources: company.sources,
        },
      }),
    );
    setSaving(false);
    if (id) setEditing(false);
  };
  const addRow = (label: string, onClick: () => void, test: string) => (
    <button
      type="button"
      className="rz-addrow"
      data-test={test}
      onClick={onClick}
    >
      <span className="rz-addrow__box" aria-hidden="true">
        <Plus size={10} />
      </span>
      {label}
    </button>
  );
  return (
    <>
      <PageShell data-test="company-page">
        <PageHead
          title={company.name}
          meta={meta.charAt(0).toUpperCase() + meta.slice(1)}
          actions={
            <Button
              variant="ghost"
              icon={
                <Sparkle
                  size={14}
                  className="rz-btn__spark rz-company__spark"
                  aria-hidden="true"
                />
              }
              onClick={() => launch({ mode: "intake", companyId })}
            >
              {tr("Bijwerken met assistent")}
            </Button>
          }
        />
        <Tabs<Tab>
          label={tr("Je bedrijf")}
          data-test="pro-tabs"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "goals", label: tr("Doelen"), count: goals.length },
            { id: "checkins", label: tr("Check-ins"), count: checkins.length },
            { id: "profile", label: tr("Profiel") },
          ]}
        />
        {tab === "goals" && (
          <div
            className="rz-company__panel rz-company__panel--goals"
            role="tabpanel"
            aria-label={tr("Doelen")}
          >
            <Cards>
              {goals.map((g) => {
                const v = goalView(g, snap, checkins);
                return (
                  <Card
                    as="button"
                    key={g.id}
                    className="rz-company__goal"
                    data-test="company-goal"
                    data-goal-id={g.id}
                    selected={goal?.id === g.id}
                    onClick={() => setSelected(goal?.id === g.id ? null : g.id)}
                  >
                    <span className="rz-card__label">
                      {v.primary ? (
                        <strong className="rz-ellipsis">{v.label}</strong>
                      ) : (
                        <span className="rz-ellipsis">{v.label}</span>
                      )}
                      {v.due && (
                        <Due className="rz-company__goal-due" late={v.late}>
                          {v.due}
                        </Due>
                      )}
                    </span>
                    <span className="rz-company__goal-title">{v.title}</span>
                    {v.measurable ? (
                      <>
                        <span className="rz-figure">
                          <span className="rz-figure__big">{v.big}</span>
                          <span className="rz-figure__unit">{v.sub}</span>
                        </span>
                        <Bar pct={v.pct} tone={v.tone} />
                      </>
                    ) : (
                      <span className="rz-company__goal-meta">
                        {tr("Nog geen streefwaarde")}
                      </span>
                    )}
                    <span className="rz-company__goal-meta">{v.meta}</span>
                  </Card>
                );
              })}
              <Card
                as="button"
                variant="dashed"
                className="rz-company__new"
                data-test="company-new-goal"
                onClick={() => edit("goal")}
              >
                <Plus size={12} aria-hidden="true" />
                {tr("Nieuw doel")}
              </Card>
            </Cards>
            {!goals.length && (
              <p className="rz-company__note">
                {tr("Begin met één meetbaar doel voor de komende weken.")}
              </p>
            )}
            {goal && (
              <Section tight data-test="company-goal-projects">
                <SectionLabel
                  right={
                    <>
                      <TextButton
                        tone="meta"
                        onClick={() => edit("goal", goal)}
                      >
                        {tr("Doel bewerken")}
                      </TextButton>
                      <TextButton
                        tone="meta"
                        aria-label={tr("Selectie sluiten")}
                        onClick={() => setSelected(null)}
                      >
                        {tr("Sluiten")}
                      </TextButton>
                    </>
                  }
                >
                  <span className="rz-company__contrib">
                    {tr("Draagt bij aan")}{" "}
                    <span className="rz-label__name">{goal.title}</span>
                  </span>
                </SectionLabel>
                {projects
                  .filter((p) => p.goalId === goal.id)
                  .map((p) => {
                    const s = projectOverview(p, snap);
                    return (
                      <Row
                        as="button"
                        size="sm"
                        cols="24px minmax(0, 1fr) auto"
                        key={p.id}
                        data-project-id={p.id}
                        onClick={() => navigate(p.id)}
                      >
                        <Badge
                          name={p.name}
                          tint={projectTint(p, snap)}
                          size={22}
                        />
                        <RowText title={p.name} />
                        <RowEnd>
                          {s.total === 1
                            ? tr("{0} van {1} taak", s.done, s.total)
                            : tr("{0} van {1} taken", s.done, s.total)}
                        </RowEnd>
                      </Row>
                    );
                  })}
                {addRow(
                  tr("Project koppelen"),
                  () => {
                    setProjectId("");
                    setLink(true);
                  },
                  "company-link-project",
                )}
              </Section>
            )}
          </div>
        )}
        {tab === "checkins" && (
          <div
            className="rz-company__panel"
            role="tabpanel"
            aria-label={tr("Check-ins")}
          >
            <div className="rz-company__bar">
              <span className="rz-company__hint">
                {tr("Elke week · kost 5 minuten")}
              </span>
              <Button variant="primary" onClick={() => edit("checkin")}>
                {tr("Check-in doen")}
              </Button>
            </div>
            {checkins.map((c) => {
              const changed = (c.measurements || []).filter(
                (m) => m.before !== m.after,
              );
              return (
                <article
                  className="rz-company__checkin"
                  data-test="pro-checkin"
                  data-checkin-id={c.id}
                  key={c.id}
                >
                  <time
                    className="rz-company__checkin-date"
                    dateTime={c.createdAt}
                  >
                    {formatDate(c.createdAt)}
                  </time>
                  <div className="rz-company__checkin-body">
                    <p className="rz-company__checkin-note">{c.note}</p>
                    <span className="rz-company__checkin-meta">
                      {[
                        tr("Door jou"),
                        ...changed.map(
                          (m) =>
                            `${m.title}: ${amount(m, m.before)} → ${amount(m, m.after)}`,
                        ),
                      ].join(" · ")}
                    </span>
                  </div>
                </article>
              );
            })}
            {!checkins.length && (
              <Empty
                inline
                className="rz-company__empty"
                title={tr("Nog geen check-ins")}
              >
                {tr("Houd bij wat er deze week vooruitging.")}
              </Empty>
            )}
          </div>
        )}
        {tab === "profile" && (
          <div
            className="rz-company__panel"
            role="tabpanel"
            aria-label={tr("Profiel")}
            data-test="company-profile"
          >
            <div className="rz-company__bar">
              <span className="rz-company__hint">
                {tr("De assistent leest dit mee bij elke taak")}
              </span>
              <Button
                ref={pill}
                variant={editing ? "primary" : "ghost"}
                data-test="company-profile-edit"
                disabled={saving}
                title={
                  editing
                    ? tr("Opslaan (Esc sluit als er niets is gewijzigd)")
                    : undefined
                }
                onClick={() => {
                  if (editing) void saveProfile();
                  else startEdit();
                }}
              >
                {editing ? tr("Klaar") : tr("Bewerken")}
              </Button>
            </div>
            <dl className="rz-company__fields">
              {fields.map(({ key, label, rows }) => (
                <div className="rz-deflist" key={key}>
                  <dt className="rz-deflist__k">{label}</dt>
                  <dd
                    className={cx(
                      "rz-deflist__v",
                      "rz-company__value",
                      editing && "rz-company__value--edit",
                    )}
                  >
                    {editing ? (
                      <Textarea
                        small
                        rows={rows}
                        className={cx(
                          "rz-company__input",
                          rows > 1 && "rz-company__input--tall",
                        )}
                        ref={(node) => {
                          inputs.current[key] = node;
                        }}
                        aria-label={label}
                        disabled={saving}
                        value={draft[key]}
                        onChange={(e) =>
                          setDraft({ ...draft, [key]: e.target.value })
                        }
                        onKeyDown={(e) => {
                          if (e.key !== "Escape" || e.nativeEvent.isComposing)
                            return;
                          if (dirty) return; // one keypress never throws typed text away
                          e.preventDefault();
                          setEditing(false);
                        }}
                      />
                    ) : company[key] ? (
                      company[key]
                    ) : (
                      <button
                        type="button"
                        className="rz-company__blank"
                        aria-label={tr("Nog niet ingevuld: {0}", label)}
                        onClick={() => startEdit(key)}
                      >
                        {tr("Nog niet ingevuld")}
                      </button>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="rz-company__folder">
              <Folder size={14} aria-hidden="true" />
              <span>{tr("Werkmap")}</span>
              <button
                type="button"
                className="rz-company__path"
                title={company.workspacePath}
                aria-label={
                  company.workspacePath
                    ? tr(
                        "Werkmap openen: {0}",
                        shortPath(company.workspacePath),
                      )
                    : undefined
                }
                disabled={!company.workspacePath}
                onClick={() =>
                  void run(() => window.werk.openPath(company.workspacePath))
                }
              >
                {shortPath(company.workspacePath)}
              </button>
              <TextButton
                className="rz-company__folder-action"
                onClick={() => edit("company", company)}
              >
                {tr("Wijzigen")}
              </TextButton>
            </div>
            <Section
              tight
              className="rz-company__docs"
              data-test="company-documents"
            >
              {!!company.sources.length && (
                <SectionLabel>{tr("Documenten")}</SectionLabel>
              )}
              {company.sources.map((path) => (
                <Row
                  as="button"
                  size="sm"
                  cols="14px minmax(0, 1fr)"
                  key={path}
                  onClick={() => showFile(path)}
                >
                  <FileText
                    size={14}
                    className="rz-company__doc-icon"
                    aria-hidden="true"
                  />
                  <RowText title={path.split("/").pop()} />
                </Row>
              ))}
              {addRow(
                tr("Documenten koppelen"),
                () => edit("company", company),
                "company-link-documents",
              )}
            </Section>
          </div>
        )}
      </PageShell>
      {link && goal && (
        <Modal title={tr("Project koppelen")} close={() => setLink(false)}>
          <ModalBody>
            {linkable.length ? (
              <>
                <Field label={tr("Project")}>
                  <Select
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                  >
                    <option value="">{tr("Kies een project")}</option>
                    {linkable.map((p) => {
                      const current = goals.find((g) => g.id === p.goalId);
                      return (
                        <option key={p.id} value={p.id}>
                          {current
                            ? tr("{0} (nu bij {1})", p.name, current.title)
                            : p.name}
                        </option>
                      );
                    })}
                  </Select>
                </Field>
                <p className="rz-hint">
                  {tr("Het project draagt hierna bij aan {0}.", goal.title)}
                </p>
              </>
            ) : (
              <p className="rz-hint">
                {tr("Alle projecten dragen al bij aan dit doel.")}
              </p>
            )}
            <ModalFoot>
              <Button onClick={() => setLink(false)}>{tr("Annuleren")}</Button>
              {linkable.length ? (
                <Button
                  variant="primary"
                  disabled={!projectId}
                  onClick={() =>
                    void run(async () => {
                      const p = snap.projects.find((p) => p.id === projectId)!;
                      await api("project.save", {
                        id: p.id,
                        value: {
                          companyId: p.companyId,
                          name: p.name,
                          description: p.description,
                          departmentId: p.departmentId,
                          workspacePath: p.workspacePath,
                          goalId: goal.id,
                          dueDate: p.dueDate,
                        },
                      });
                      setLink(false);
                    })
                  }
                >
                  {tr("Koppelen")}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  onClick={() => {
                    setLink(false);
                    edit("project", { goalId: goal.id });
                  }}
                >
                  {tr("Nieuw project")}
                </Button>
              )}
            </ModalFoot>
          </ModalBody>
        </Modal>
      )}
    </>
  );
}
