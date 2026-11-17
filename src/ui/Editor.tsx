import { t as tr, translateMessage } from "../shared/i18n";
import { TaskScheduleFields } from "./TaskSchedule";
import { availableToday } from "../shared/task-schedule";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Check,
  ChevronRight,
  FileText,
  FolderOpen,
  Plus,
  X,
} from "lucide-react";
import { labels, type Snapshot, type Company } from "../shared/types";
import { providerName, shortPath } from "./primitives";
import {
  Button,
  Chip,
  Field,
  IconButton,
  Input,
  ModalBody,
  ModalFoot,
  Select,
  TextButton,
  Textarea,
  cx,
} from "./rz";
export type EditorKind =
  | "company"
  | "department"
  | "project"
  | "goal"
  | "task"
  | "checkin";
// Modal lives in rz.tsx now; re-exported so every existing `import { Modal } from "./Editor"` keeps working.
import { Modal } from "./rz";
export { Modal };
export function Editor({
  kind,
  value,
  company,
  snapshot,
  defaultWorkspace,
  onSaved,
  close,
}: {
  kind: EditorKind;
  value?: any;
  company?: Company;
  snapshot: Snapshot;
  defaultWorkspace: string;
  onSaved: (kind: EditorKind, id?: string, start?: boolean) => void;
  close: () => void;
}) {
  const [form, setForm] = useState<any>(() => {
    const base: any = { companyId: company?.id };
    if (kind === "company")
      Object.assign(base, {
        name: "",
        workspacePath: defaultWorkspace,
        color: "#4fd98a",
        product: "",
        audience: "",
        stage: "",
        bottleneck: "",
        sources: [],
      });
    if (kind === "department")
      Object.assign(base, { name: "", description: "" });
    if (kind === "project")
      Object.assign(base, {
        name: "",
        description: "",
        departmentId: null,
        workspacePath: "",
        goalId: null,
        dueDate: "",
      });
    if (kind === "goal")
      Object.assign(base, {
        title: "",
        metric: "",
        unit: "",
        baseline: 0,
        current: 0,
        target: 0,
        dueDate: "",
        primary: !snapshot.goals.some((g) => g.companyId === company?.id),
      });
    if (kind === "task")
      Object.assign(base, {
        projectId:
          snapshot.projects.find((p) => p.companyId === company?.id)?.id || "",
        goalId: null,
        title: "",
        description: "",
        definitionDone: "",
        criteria: [],
        provider: "codex",
        model: "",
        recurrence: "none",
        scheduledDate: "",
        dueDate: "",
        estimateMinutes: 30,
        kind: "ai",
        status: "todo",
        pinned: false,
        mustDo: false,
        dependencies: [],
      });
    if (kind === "checkin")
      Object.assign(base, {
        note: "",
        values: Object.fromEntries(
          snapshot.goals
            .filter((g) => g.companyId === company?.id)
            .map((g) => [g.id, g.current]),
        ),
      });
    if (value)
      for (const key of Object.keys(base))
        if (key in value) base[key] = value[key];
    if (kind === "task" && !base.criteria.length && base.definitionDone)
      base.criteria = base.definitionDone
        .split(/\n+/)
        .filter(Boolean)
        .map((text: string) => ({
          id: crypto.randomUUID(),
          text,
          checked: false,
          comment: "",
          agentNote: "",
          evidence: null,
        }));
    if (kind === "task" && !base.criteria.length)
      base.criteria = [
        {
          id: crypto.randomUUID(),
          text: "",
          checked: false,
          comment: "",
          agentNote: "",
          evidence: null,
        },
      ];
    if (kind === "company") delete base.companyId;
    return base;
  });
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const errorBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) errorBox.current?.focus();
  }, [error]);
  const change = (key: string, v: any) =>
    setForm((f: any) => ({ ...f, [key]: v }));
  const field = (
    key: string,
    title: string,
    opts: {
      area?: boolean;
      type?: string;
      hint?: string;
      required?: boolean;
    } = {},
  ) => (
    <Field label={title} hint={opts.hint}>
      {opts.area ? (
        <Textarea
          required={opts.required}
          value={form[key]}
          onChange={(e) => change(key, e.target.value)}
          rows={3}
        />
      ) : (
        <Input
          required={opts.required}
          type={opts.type || "text"}
          value={form[key]}
          onChange={(e) =>
            change(
              key,
              opts.type === "number" ? Number(e.target.value) : e.target.value,
            )
          }
        />
      )}
    </Field>
  );
  const check = (key: string, title: string) => (
    <label className="rz-forms__check">
      <input
        type="checkbox"
        checked={form[key]}
        onChange={(e) => change(key, e.target.checked)}
      />
      <span>{title}</span>
    </label>
  );
  const chooseFolder = async () => {
    try {
      const path = await window.werk.selectFolder();
      if (path) change("workspacePath", path);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  // One field, two controls: the input carries the name, "Kiezen" opens the folder picker.
  const folderField = (
    title: string,
    hint: string,
    opts: { required?: boolean; placeholder?: string } = {},
  ) => (
    <Field as="div" label={title} hint={hint}>
      <div className="rz-forms__action">
        <Input
          aria-label={title}
          required={opts.required}
          placeholder={opts.placeholder}
          value={form.workspacePath}
          onChange={(e) => change("workspacePath", e.target.value)}
        />
        <Button
          icon={<FolderOpen size={13} aria-hidden="true" />}
          onClick={chooseFolder}
        >
          {tr("Kiezen")}
        </Button>
      </div>
    </Field>
  );
  const goals = snapshot.goals.filter((g) => g.companyId === company?.id),
    projects = snapshot.projects.filter((p) => p.companyId === company?.id);
  const goalSelect = (
    <Field label={tr("Draagt bij aan doel")}>
      <Select
        value={form.goalId || ""}
        onChange={(e) => change("goalId", e.target.value || null)}
      >
        <option value="">{tr("Nog geen doel gekoppeld")}</option>
        {goals.map((g) => (
          <option key={g.id} value={g.id}>
            {g.title}
          </option>
        ))}
      </Select>
    </Field>
  );
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const start =
        (e.nativeEvent as SubmitEvent).submitter?.getAttribute("data-start") ===
        "true";
      let id;
      if (kind === "checkin") {
        await window.werk.call("checkin.save", {
          companyId: company!.id,
          note: form.note,
          values: Object.entries(form.values).map(([goalId, current]) => ({
            goalId,
            current,
          })),
        });
      } else
        id = await window.werk.call<string>(`${kind}.save`, {
          id: value?.id,
          value:
            kind === "task"
              ? {
                  ...form,
                  criteria: form.criteria.filter((c: any) => c.text.trim()),
                  definitionDone: form.criteria
                    .filter((c: any) => c.text.trim())
                    .map((c: any) => c.text)
                    .join("\n"),
                  kind: form.provider === "shell" ? "human" : "ai",
                }
              : form,
        });
      onSaved(
        kind,
        id,
        start &&
          (kind !== "task" ||
            availableToday({ scheduledDate: form.scheduledDate })),
      );
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const removeDepartment = async () => {
    setBusy(true);
    setError("");
    try {
      await window.werk.call("department.remove", {
        id: value.id,
      });
      onSaved(kind);
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const removeTask = async () => {
    if (
      !window.confirm(
        tr(
          "Deze taak verwijderen? Gesprekken blijven in de geschiedenis, maar taakresultaten en koppelingen worden verwijderd.",
        ),
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await window.werk.call("task.remove", { id: value.id });
      onSaved(kind);
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const titles = {
    company: value?.id ? tr("Bedrijf bewerken") : tr("Nieuw bedrijf"),
    department: value?.id ? tr("Afdeling bewerken") : tr("Nieuwe afdeling"),
    project: value?.id ? tr("Project bewerken") : tr("Nieuw project"),
    goal: value?.id ? tr("Doel bewerken") : tr("Nieuw bedrijfsdoel"),
    task: value?.id ? tr("Taak bewerken") : tr("Nieuwe taak"),
    checkin: tr("Je wekelijkse check-in"),
  };
  // Only the short department form lets the overlay scroll; every other kind keeps its footer in view.
  const docked = kind !== "department";
  const filled =
    kind === "task"
      ? form.criteria.filter((c: any) => c.text.trim()).length
      : 0;
  const foot = (
    <ModalFoot
      docked={docked}
      left={
        kind === "task" && value?.id ? (
          <TextButton
            className="rz-forms__danger"
            disabled={busy}
            onClick={() => void removeTask()}
          >
            {tr("Taak verwijderen")}
          </TextButton>
        ) : kind === "task" ? (
          projects.find((p) => p.id === form.projectId)?.workspacePath ? (
            tr("Werkmap van het project")
          ) : (
            tr("Werkmap van {0}", company?.name || "")
          )
        ) : kind === "department" && value?.id ? (
          <TextButton
            className="rz-forms__danger"
            disabled={busy}
            onClick={() => void removeDepartment()}
          >
            {tr("Lege afdeling verwijderen")}
          </TextButton>
        ) : undefined
      }
    >
      <Button variant={kind === "task" ? "quiet" : "ghost"} onClick={close}>
        {tr("Annuleren")}
      </Button>
      <Button
        type="submit"
        variant={kind === "task" ? "ghost" : "primary"}
        disabled={busy}
      >
        {busy
          ? tr("Opslaan…")
          : kind === "checkin"
            ? tr("Check-in opslaan")
            : tr("Opslaan")}
      </Button>
      {kind === "task" && (
        <Button
          type="submit"
          variant="primary"
          data-start="true"
          disabled={busy}
        >
          {tr("Opslaan en starten")}
        </Button>
      )}
    </ModalFoot>
  );
  return (
    <Modal
      title={titles[kind]}
      close={close}
      width={kind === "task" ? 640 : 600}
      scroll={docked ? "body" : "overlay"}
      className={cx("rz-editor", `rz-editor--${kind}`)}
      subtitle={kind === "task" ? company?.name : undefined}
    >
      <form onSubmit={save} data-test={`editor-${kind}`}>
        <ModalBody className="rz-editor__body">
          {error && (
            <div
              className="rz-error rz-error--block"
              role="alert"
              tabIndex={-1}
              ref={errorBox}
            >
              {translateMessage(error)}
            </div>
          )}
          {kind === "company" && (
            <>
              {field("name", tr("Bedrijfsnaam"), { required: true })}
              {folderField(
                tr("Bestaande werkmap"),
                tr(
                  "Je assistent opent hier, met de configuratie van je eigen omgeving.",
                ),
                { required: true },
              )}
              <div className="rz-forms__grid">
                {field("product", tr("Wat verkoop je?"), { area: true })}
                {field("audience", tr("Voor wie?"), { area: true })}
              </div>
              {field("stage", tr("Fase van het bedrijf"))}
              {field("bottleneck", tr("Wat houdt de groei nu tegen?"), {
                area: true,
              })}
              <Field
                as="div"
                label={tr("Bedrijfsdocumenten")}
                hint={tr(
                  "Bijvoorbeeld je strategie, aanbod of klantonderzoek. De assistent kan deze bestanden raadplegen.",
                )}
              >
                <div className="rz-forms__rows">
                  {form.sources.map((path: string) => {
                    const name = path.split("/").pop() || path;
                    return (
                      <div className="rz-forms__source" key={path}>
                        <FileText size={13} aria-hidden="true" />
                        <span
                          className="rz-forms__source-name"
                          title={shortPath(path)}
                        >
                          {name}
                        </span>
                        <IconButton
                          size="xs"
                          className="rz-forms__remove"
                          label={tr("Verwijder {0}", shortPath(path))}
                          onClick={() =>
                            change(
                              "sources",
                              form.sources.filter((p: string) => p !== path),
                            )
                          }
                        >
                          <X size={11} aria-hidden="true" />
                        </IconButton>
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    className="rz-forms__add"
                    onClick={async () => {
                      try {
                        change("sources", [
                          ...new Set([
                            ...form.sources,
                            ...(await window.werk.selectFiles()),
                          ]),
                        ]);
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    <span className="rz-forms__add-box" aria-hidden="true">
                      <Plus size={9} />
                    </span>
                    {tr("Documenten koppelen")}
                  </button>
                </div>
              </Field>
            </>
          )}
          {kind === "department" && (
            <>
              {field("name", tr("Afdelingsnaam"), {
                required: true,
                hint: tr("Bijvoorbeeld Sales, Marketing of Operations."),
              })}
              {field("description", tr("Waar werkt deze afdeling aan?"), {
                area: true,
              })}
              <p className="rz-hint">
                {tr(
                  "Afdelingen horen bij {0}. Kies bij een project onder welke afdeling het valt.",
                  company?.name || "",
                )}
              </p>
            </>
          )}
          {kind === "project" && (
            <>
              {field("name", tr("Projectnaam"), {
                required: true,
                hint: tr(
                  "Bijvoorbeeld Cold email, Klantvoorstellen of Content.",
                ),
              })}
              <Field
                label={tr("Afdeling")}
                hint={tr("Maak nieuwe afdelingen aan op de pagina Projecten.")}
              >
                <Select
                  aria-label={tr("Afdeling")}
                  value={form.departmentId || ""}
                  onChange={(e) =>
                    change("departmentId", e.target.value || null)
                  }
                >
                  <option value="">{tr("Zonder afdeling")}</option>
                  {snapshot.departments
                    .filter((d) => d.companyId === company?.id)
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                </Select>
              </Field>
              {field("description", tr("Gewenst resultaat"), { area: true })}
              <div className="rz-forms__grid">
                {goalSelect}
                {field("dueDate", tr("Deadline"), { type: "date" })}
              </div>
              {folderField(
                tr("Werkmap voor dit project"),
                tr("Laat leeg om de werkmap van het bedrijf te gebruiken."),
                {
                  placeholder: company
                    ? shortPath(company.workspacePath)
                    : undefined,
                },
              )}
            </>
          )}
          {kind === "goal" && (
            <>
              {field("title", tr("Wat wil je bereiken?"), { required: true })}
              <div className="rz-forms__grid">
                {field("metric", tr("Wat meet je?"))}
                {field("unit", tr("Eenheid"), {
                  hint: tr("Bijvoorbeeld gesprekken, klanten of €."),
                })}
              </div>
              <div className="rz-forms__grid rz-forms__grid--three">
                {field("baseline", tr("Startwaarde"), { type: "number" })}
                {field("current", tr("Huidige waarde"), { type: "number" })}
                {field("target", tr("Streefwaarde"), { type: "number" })}
              </div>
              {field("dueDate", tr("Streefdatum"), { type: "date" })}
              {check(
                "primary",
                tr("Dit is het belangrijkste doel van dit moment"),
              )}
              <p className="rz-hint">
                {tr(
                  "Je werkt de cijfers zelf bij tijdens je check-in. Het afronden van een taak verandert deze cijfers niet.",
                )}
              </p>
            </>
          )}
          {kind === "task" && (
            <>
              {field("title", tr("Titel"), { required: true })}
              <div className="rz-forms__grid">
                <Field label={tr("Project")}>
                  <Select
                    required
                    value={form.projectId}
                    onChange={(e) => {
                      const p = projects.find((p) => p.id === e.target.value);
                      change("projectId", e.target.value);
                      if (!value?.id) change("goalId", p?.goalId || null);
                    }}
                  >
                    <option value="" disabled>
                      {tr("Kies een project")}
                    </option>
                    {projects.map((p) => (
                      <option value={p.id} key={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                {goalSelect}
              </div>
              {field("description", tr("Opdracht"), { area: true })}
              <div
                className="rz-forms__criteria"
                role="group"
                aria-label={tr("Klaar als")}
              >
                <div className="rz-forms__criteria-head">
                  <span>{tr("Klaar als")}</span>
                  <span>
                    {filled} {filled === 1 ? tr("criterium") : tr("criteria")}
                  </span>
                </div>
                {form.criteria.map((c: any, index: number) => (
                  <div className="rz-forms__criterion" key={c.id}>
                    <span
                      className="rz-forms__box"
                      data-checked={c.checked ? "" : undefined}
                      aria-hidden="true"
                    >
                      <Check />
                    </span>
                    <Input
                      bare
                      aria-label={tr("Criterium {0}", index + 1)}
                      placeholder={tr("Een concreet, toetsbaar resultaat…")}
                      value={c.text}
                      onChange={(e) =>
                        change(
                          "criteria",
                          form.criteria.map((item: any) =>
                            item.id === c.id
                              ? {
                                  ...item,
                                  text: e.target.value,
                                  ...(item.text !== e.target.value
                                    ? {
                                        checked: false,
                                        agentNote: "",
                                        evidence: null,
                                      }
                                    : {}),
                                }
                              : item,
                          ),
                        )
                      }
                    />
                    <IconButton
                      size="xs"
                      className="rz-forms__remove"
                      label={tr("Criterium {0} verwijderen", index + 1)}
                      onClick={() =>
                        change(
                          "criteria",
                          form.criteria.filter((item: any) => item.id !== c.id),
                        )
                      }
                    >
                      <X size={11} aria-hidden="true" />
                    </IconButton>
                  </div>
                ))}
                <button
                  type="button"
                  className="rz-forms__add"
                  onClick={() =>
                    change("criteria", [
                      ...form.criteria,
                      {
                        id: crypto.randomUUID(),
                        text: "",
                        checked: false,
                        comment: "",
                        agentNote: "",
                        evidence: null,
                      },
                    ])
                  }
                >
                  <span className="rz-forms__add-box" aria-hidden="true">
                    <Plus size={9} />
                  </span>
                  {tr("Criterium toevoegen")}
                </button>
              </div>
              <Field as="div" label={tr("Uitvoering")}>
                <Select value={form.agentId || ""} onChange={e => {
                  const agent = snapshot.agents?.find(a => a.id === e.target.value);
                  setForm({ ...form, agentId: agent?.id || null, provider: agent?.provider || form.provider, model: agent ? "" : form.model });
                }} aria-label={tr("Vaste agent")}>
                  <option value="">{tr("Zonder agentprofiel")}</option>
                  {(snapshot.agents || []).filter(a => a.companyId === company?.id && (!a.archived || a.id === form.agentId)).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </Select>
                <div
                  className="rz-forms__chips"
                  role="group"
                  aria-label={tr("Uitvoering")}
                >
                  {(["codex", "claude", "shell"] as const).map((id) => (
                    <Chip
                      key={id}
                      variant="toggle"
                      pressed={!form.agentId && form.provider === id}
                      onClick={() => setForm({ ...form, provider: id, agentId: null, model: id === "codex" ? form.model : "" })}
                    >
                      {id === "shell" ? tr("Zelf") : providerName(id)}
                    </Chip>
                  ))}
                </div>
              </Field>
              {!form.agentId && form.provider === "codex" && (
                <Field
                  label={tr("Model")}
                  hint={tr(
                    "Automatisch gebruikt het standaardmodel van het gekozen Codex-account.",
                  )}
                >
                  <Select
                    value={form.model || ""}
                    onChange={(e) => change("model", e.target.value)}
                  >
                    <option value="">{tr("Automatisch")}</option>
                    <option value="gpt-6-astra">GPT-6 Astra</option>
                    <option value="gpt-6-sol">GPT-6 Sol</option>
                    <option value="gpt-6-luna">GPT-6 Luna</option>
                  </Select>
                </Field>
              )}
              <div className="rz-forms__grid">
                {field("dueDate", tr("Deadline"), { type: "date" })}
                <Field label={tr("Wacht op")}>
                  <Select
                    value=""
                    onChange={(e) => {
                      if (e.target.value)
                        change("dependencies", [
                          ...new Set([...form.dependencies, e.target.value]),
                        ]);
                    }}
                  >
                    <option value="">
                      {form.dependencies.length
                        ? tr("{0} afhankelijkheden", form.dependencies.length)
                        : tr("Geen afhankelijkheid")}
                    </option>
                    {snapshot.tasks
                      .filter(
                        (t) =>
                          t.companyId === company?.id &&
                          t.id !== value?.id &&
                          !form.dependencies.includes(t.id),
                      )
                      .map((t) => (
                        <option value={t.id} key={t.id}>
                          {t.title}
                        </option>
                      ))}
                  </Select>
                </Field>
              </div>
              {form.dependencies.length > 0 && (
                <div className="rz-forms__deps">
                  {form.dependencies.map((id: string) => (
                    <button
                      type="button"
                      className="rz-forms__dep"
                      key={id}
                      title={tr("Afhankelijkheid verwijderen")}
                      onClick={() =>
                        change(
                          "dependencies",
                          form.dependencies.filter((d: string) => d !== id),
                        )
                      }
                    >
                      <span>
                        {snapshot.tasks.find((t) => t.id === id)?.title}
                      </span>
                      <X size={11} aria-hidden="true" />
                    </button>
                  ))}
                </div>
              )}
              <TaskScheduleFields
                recurrence={form.recurrence}
                date={form.scheduledDate}
                onChange={(recurrence, scheduledDate) =>
                  setForm((current: any) => ({
                    ...current,
                    recurrence,
                    scheduledDate,
                  }))
                }
              />
              <details className="rz-disclosure">
                <summary>
                  <ChevronRight size={11} aria-hidden="true" />
                  {tr("Prioriteit en overige opties")}
                </summary>
                <div className="rz-forms__more-body">
                  <div className="rz-forms__grid">
                    <Field label={tr("Status")}>
                      <Select
                        value={form.status}
                        onChange={(e) => change("status", e.target.value)}
                      >
                        {Object.entries(labels).map(([k, v]) => (
                          <option key={k} value={k}>
                            {tr(v)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <div className="rz-forms__checks">
                      {check("pinned", tr("Vastzetten bovenaan"))}
                      {check("mustDo", tr("Verplichting / harde deadline"))}
                    </div>
                  </div>
                  {field("estimateMinutes", tr("Jouw tijd (min)"), {
                    type: "number",
                  })}
                </div>
              </details>
            </>
          )}
          {kind === "checkin" && (
            <>
              <p className="rz-hint">
                {tr(
                  "Wat is er veranderd? Je antwoorden geven het volgende prioriteitsadvies actuele context.",
                )}
              </p>
              {field("note", tr("Resultaten, nieuwe inzichten en knelpunten"), {
                area: true,
                required: true,
              })}
              {goals.map((g) => (
                <Field key={g.id} label={g.title}>
                  <span className="rz-forms__action">
                    <Input
                      type="number"
                      value={form.values[g.id]}
                      onChange={(e) =>
                        change("values", {
                          ...form.values,
                          [g.id]: Number(e.target.value),
                        })
                      }
                    />
                    <span className="rz-forms__suffix">
                      {g.unit} / {g.target}
                    </span>
                  </span>
                </Field>
              ))}
            </>
          )}
          {!docked && foot}
        </ModalBody>
        {docked && foot}
      </form>
    </Modal>
  );
}
