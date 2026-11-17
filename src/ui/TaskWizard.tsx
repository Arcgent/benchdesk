import { t as tr, translateMessage } from "../shared/i18n";
import { useEffect, useId, useState } from "react";
import { ArrowLeft, Check as CheckIcon } from "lucide-react";
import {
  availableToday,
  localDate,
  type Recurrence,
} from "../shared/task-schedule";
import type { SessionContextOptions } from "../shared/context";
import type { Provider, Snapshot } from "../shared/types";
import { api, useWorkbench } from "./model";
import { formatDayMonth, projectTint, providerName } from "./primitives";
import {
  Avatar,
  Badge,
  Button,
  Chip,
  Field,
  Input,
  Menu,
  Modal,
  ModalBody,
  ModalFoot,
  Steps,
  TextButton,
  Textarea,
  cx,
} from "./rz";
import {
  CriteriaFields,
  DateChip,
  DependencyFields,
  FileChips,
} from "./TaskFields";
import { TaskScheduleFields } from "./TaskSchedule";
import { AccountUsagePanel } from "./Usage";

const contextChips = (): [keyof SessionContextOptions, string][] => [
  ["assignment", tr("Opdracht")],
  ["criteria", tr("Criteria")],
  ["business", tr("Bedrijfscontext")],
];

// "Uitgebreide taak": step 1 describes the task, step 2 picks who does it. Opened by ⌘N, "Als taak" and the
// expand button of the composer, which hands over its title, project, executor, plan date and picked files.
export function TaskWizard({
  value,
  close,
}: {
  value?: any;
  close: () => void;
}) {
  const {
    snap,
    companyId: activeCompanyId,
    prefs,
    inventory,
    inspect,
    refresh,
    openSession,
    navigate,
  } = useWorkbench();
  const companyId = value?.companyId || activeCompanyId;
  const company = snap.companies.find((c) => c.id === companyId);
  const projects = snap.projects.filter((p) => p.companyId === companyId);
  const goals = snap.goals.filter((g) => g.companyId === companyId);
  const contextLabel = useId();
  const [step, setStep] = useState(1);
  const [title, setTitle] = useState(value?.title || "");
  const [projectId, setProject] = useState(
    value?.projectId || projects[0]?.id || "",
  );
  const [goalId, setGoal] = useState(
    value?.goalId ||
      projects.find((p) => p.id === (value?.projectId || projects[0]?.id))
        ?.goalId ||
      "",
  );
  const [description, setDescription] = useState(value?.description || "");
  const [due, setDue] = useState(value?.dueDate || "");
  const [recurrence, setRecurrence] = useState<Recurrence>(
    value?.recurrence || "none",
  );
  const [scheduledDate, setScheduledDate] = useState(
    value?.scheduledDate || "",
  );
  const [criteria, setCriteria] = useState<string[]>(
    value?.criteria?.map((c: any) => c.text) || [],
  );
  const [criterion, setCriterion] = useState("");
  const [chosenProvider, setProvider] = useState<Provider>(
    value?.provider || "codex",
  );
  const [model, setModel] = useState(value?.model || "");
  const [accountId, setAccount] = useState("");
  const [agentId, setAgentId] = useState(value?.agentId || "");
  const agents = (snap.agents || []).filter(a => a.companyId === companyId && (!a.archived || a.id === agentId));
  const agent = agents.find(a => a.id === agentId);
  const [context, setContext] = useState<SessionContextOptions>({
    assignment: true,
    criteria: true,
    business: true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedId, setSavedId] = useState<string>();
  const [dependencies, setDependencies] = useState<string[]>(
    value?.dependencies || [],
  );
  // Files picked in the composer. A linked file leaves the list, so a retry only links what is left.
  const [files, setFiles] = useState<string[]>(
    Array.isArray(value?.files) ? value.files : [],
  );
  // An assistant whose command line tool is missing cannot start: leave it out once the inventory is known.
  useEffect(() => {
    if (!inventory) void inspect();
  }, []);
  const assistants = (["codex", "claude"] as const).filter(
    (p) => !inventory || !!inventory.providers.find((c) => c.name === p)?.path,
  );
  const executors: Provider[] = [...assistants, "shell"];
  const provider = agent?.provider || (executors.includes(chosenProvider)
    ? chosenProvider
    : executors[0]);
  const accounts = prefs.accounts.filter((a) => a.provider === provider);
  const account =
    accounts.find((a) => a.id === accountId) ||
    accounts.find((a) => a.companyIds.includes(companyId)) ||
    accounts.find((a) => a.globalDefault) ||
    accounts[0];
  const accountName = (a: (typeof accounts)[number]) =>
    a.label +
    (a.companyIds.includes(companyId)
      ? tr(" · standaard voor dit bedrijf")
      : a.globalDefault
        ? tr(" · persoonlijk standaard")
        : "");
  const project = projects.find((p) => p.id === projectId);
  const goal = goals.find((g) => g.id === goalId);
  const today = availableToday({ scheduledDate });
  const save = async (start: boolean) => {
    if (!title.trim() || !projectId) {
      setError(tr("Vul een titel in en kies een project."));
      setStep(1);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const completeCriteria = [
        ...criteria,
        ...(criterion.trim() ? [criterion.trim()] : []),
      ];
      const id = await api<string>("task.save", {
        id: savedId,
        value: {
          companyId,
          projectId,
          goalId: goalId || null,
          title: title.trim(),
          description,
          dueDate: due,
          recurrence,
          scheduledDate,
          provider,
          model: !agentId && provider === "codex" ? model : "",
          agentId: agentId || null,
          kind: provider === "shell" ? "human" : "ai",
          definitionDone: completeCriteria.join("\n"),
          criteria: completeCriteria.map((text) => ({
            id: crypto.randomUUID(),
            text,
            checked: false,
            comment: "",
            agentNote: "",
            evidence: null,
          })),
          dependencies,
        },
      });
      setSavedId(id);
      const problems: string[] = [],
        unlinked: string[] = [];
      for (const path of files)
        try {
          await api("artifact.add", { taskId: id, path });
        } catch (e) {
          unlinked.push(path);
          problems.push((e as Error).message);
        }
      if (files.length) setFiles(unlinked);
      await refresh();
      // The assistant should not start without the files it was given: say so and let the user decide.
      if (problems.length) throw new Error([...new Set(problems)].join(" "));
      if (start && provider !== "shell" && today) {
        const sessionId = await api<string>("session.start", {
          companyId,
          taskId: id,
          provider,
          mode: "work",
          agentId: agentId || null,
          accountId: account?.id || null,
          contextOptions: context,
        });
        const next = await api<Snapshot>("snapshot");
        await refresh();
        const session = next.sessions.find((s) => s.id === sessionId);
        if (session) openSession(session);
      } else navigate("today");
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const toStep2 = (message: string) => {
    if (title.trim() && projectId) {
      setError("");
      setStep(2);
    } else setError(message);
  };
  return (
    <Modal
      title={tr("Nieuwe taak")}
      close={() => {
        if (!busy) close();
      }}
      className="rz-task-wizard"
      header={
        <Steps
          current={step - 1}
          onStep={(index) =>
            index === 0
              ? setStep(1)
              : toStep2(tr("Vul eerst een titel en project in."))
          }
          steps={[
            { label: tr("1 · Taak"), disabled: busy },
            { label: tr("2 · Uitvoering"), disabled: busy },
          ]}
        />
      }
    >
      <ModalBody
        className={cx(
          "rz-task-wizard__body",
          step === 2 && "rz-task-wizard__body--who",
        )}
      >
        {step === 1 ? (
          <>
            <Input
              titleSize
              autoFocus
              className="rz-task-wizard__title"
              aria-label={tr("Titel")}
              placeholder={tr("Wat moet er gebeuren?")}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={busy}
            />
            <div className="rz-task-wizard__meta">
              <div className="rz-task-wizard__chips">
                <Menu
                  label={tr("Project kiezen")}
                  items={projects.map((p) => ({
                    id: p.id,
                    label: p.name,
                    icon: (
                      <Badge
                        name={p.name}
                        tint={projectTint(p, snap)}
                        size={14}
                      />
                    ),
                    checked: p.id === projectId,
                    onSelect: () => {
                      setProject(p.id);
                      setGoal(p.goalId || "");
                    },
                  }))}
                  trigger={(p) => (
                    <Chip
                      {...p}
                      className="rz-task-wizard__chip"
                      variant={project ? undefined : "dashed"}
                      aria-label={
                        project
                          ? tr("Project kiezen: {0}", project.name)
                          : tr("Project kiezen")
                      }
                      icon={
                        project && (
                          <Badge
                            name={project.name}
                            tint={projectTint(project, snap)}
                            size={14}
                          />
                        )
                      }
                      chevron
                    >
                      {project ? project.name : tr("Project kiezen")}
                    </Chip>
                  )}
                />
                {goals.length > 0 && (
                  <Menu
                    label={tr("Draagt bij aan doel")}
                    items={[
                      {
                        id: "none",
                        label: tr("Geen doel"),
                        checked: !goal,
                        onSelect: () => setGoal(""),
                      },
                      ...goals.map((g) => ({
                        id: g.id,
                        label: g.title,
                        checked: g.id === goalId,
                        onSelect: () => setGoal(g.id),
                      })),
                    ]}
                    trigger={(p) => (
                      <Chip
                        {...p}
                        className="rz-task-wizard__chip"
                        variant={goal ? undefined : "dashed"}
                        aria-label={
                          goal
                            ? tr("Draagt bij aan doel: {0}", goal.title)
                            : tr("Doel koppelen")
                        }
                        icon={
                          goal && (
                            <i
                              className="rz-dot"
                              data-tone="accent"
                              aria-hidden="true"
                            />
                          )
                        }
                        chevron
                      >
                        {goal ? goal.title : tr("Doel koppelen")}
                      </Chip>
                    )}
                  />
                )}
                <DateChip
                  label={tr("Deadline")}
                  value={due}
                  text={tr("Deadline {0}", formatDayMonth(due))}
                  clearLabel={tr("Deadline wissen")}
                  late={!!due && due < localDate()}
                  onChange={setDue}
                />
                <TaskScheduleFields
                  variant="chips"
                  recurrence={recurrence}
                  date={scheduledDate}
                  onChange={(r, d) => {
                    setRecurrence(r);
                    setScheduledDate(d);
                  }}
                />
              </div>
              <FileChips
                files={files}
                disabled={busy}
                onRemove={(path) =>
                  setFiles((current) => current.filter((f) => f !== path))
                }
              />
            </div>
            <Field label={tr("Opdracht")}>
              <Textarea
                rows={3}
                aria-label={tr("Opdracht")}
                placeholder={tr(
                  "Beschrijf wat je wilt bereiken, in gewone taal.",
                )}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
            <CriteriaFields
              criteria={criteria}
              draft={criterion}
              onChange={setCriteria}
              onDraft={setCriterion}
            />
            <DependencyFields
              tasks={snap.tasks.filter(
                (t) =>
                  t.companyId === companyId &&
                  t.status !== "done" &&
                  t.id !== savedId,
              )}
              value={dependencies}
              onChange={setDependencies}
            />
          </>
        ) : (
          <>
            <div className="rz-task-wizard__heading">
              <h2>{tr("Wie voert dit uit?")}</h2>
              <p>{title}</p>
            </div>
            {agents.length > 0 && <Field label={tr("Vaste agent")}><select className="rz-select" value={agentId} onChange={e => setAgentId(e.target.value)}><option value="">{tr("Zonder agentprofiel")}</option>{agents.map(a => <option key={a.id} value={a.id}>{a.name} · {providerName(a.provider)}</option>)}</select></Field>}
            {!agent && <div
              className="rz-task-wizard__choices"
              role="group"
              aria-label={tr("Wie voert dit uit?")}
            >
              {executors.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="rz-choice rz-task-wizard__choice"
                  data-test="task-wizard-executor"
                  data-provider={p}
                  aria-pressed={provider === p}
                  onClick={() => {
                    setProvider(p);
                    if (p !== "codex") setModel("");
                    setAccount("");
                  }}
                >
                  {p === "shell" ? (
                    <Avatar size={30} name={prefs.profile.name || tr("Jij")} />
                  ) : (
                    <Avatar size={30} provider={p} />
                  )}
                  <span className="rz-task-wizard__choice-text">
                    <span className="rz-task-wizard__choice-name">
                      {providerName(p)}
                    </span>{" "}
                    <span className="rz-task-wizard__choice-desc">
                      {p !== "shell"
                        ? tr("Werkt zelfstandig in je werkmap")
                        : today
                          ? tr("Komt op Vandaag, zonder assistent")
                          : tr(
                              "Komt vanaf de plandatum op Vandaag, zonder assistent",
                            )}
                    </span>
                  </span>
                  <span
                    className="rz-radio"
                    data-on={provider === p ? "" : undefined}
                    aria-hidden="true"
                  >
                    <CheckIcon size={9} />
                  </span>
                </button>
              ))}
            </div>}
            {inventory && !assistants.length && (
              <p className="rz-hint">
                {tr(
                  "Codex en Claude Code zijn niet gevonden op deze computer. Installeer er een om taken door een assistent te laten uitvoeren.",
                )}
              </p>
            )}
            {!agent && provider !== "shell" && (
              <>
                {provider === "codex" && (
                  <Field
                    label={tr("Model")}
                    hint={tr(
                      "Automatisch gebruikt het standaardmodel van het gekozen Codex-account.",
                    )}
                  >
                    <select
                      className="rz-select"
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                    >
                      <option value="">{tr("Automatisch")}</option>
                      <option value="gpt-6-astra">GPT-6 Astra</option>
                      <option value="gpt-6-sol">GPT-6 Sol</option>
                      <option value="gpt-6-luna">GPT-6 Luna</option>
                    </select>
                  </Field>
                )}
                <div className="rz-inset" data-test="task-wizard-account">
                  <div className="rz-task-wizard__account">
                    <span>{tr("Account")}</span>
                    {accounts.length ? (
                      <Menu
                        label={tr("Account")}
                        align="right"
                        items={accounts.map((a) => ({
                          id: a.id,
                          label: accountName(a),
                          checked: a.id === account?.id,
                          onSelect: () => setAccount(a.id),
                        }))}
                        trigger={(p) => (
                          <Chip
                            {...p}
                            size="sm"
                            onSide
                            chevron
                            className="rz-task-wizard__account-chip"
                            aria-label={tr(
                              "Account kiezen: {0}",
                              account ? accountName(account) : "",
                            )}
                          >
                            {account ? accountName(account) : ""}
                          </Chip>
                        )}
                      />
                    ) : (
                      <Chip
                        size="sm"
                        onSide
                        className="rz-task-wizard__account-chip"
                      >
                        {tr("Persoonlijke configuratie")}
                      </Chip>
                    )}
                  </div>
                  {account && (
                    <AccountUsagePanel account={account} compact remaining />
                  )}
                </div>
                <div className="rz-task-wizard__group">
                  <span
                    className="rz-task-wizard__grouplabel"
                    id={contextLabel}
                  >
                    {tr("Krijgt mee")}
                  </span>
                  <div
                    className="rz-task-wizard__toggles"
                    role="group"
                    aria-labelledby={contextLabel}
                  >
                    {contextChips().map(([key, label]) => (
                      <Chip
                        key={key}
                        variant="toggle"
                        pressed={context[key]}
                        onClick={() =>
                          setContext({ ...context, [key]: !context[key] })
                        }
                      >
                        {label}
                      </Chip>
                    ))}
                    <Chip
                      className="rz-task-wizard__newchat"
                      title={tr(
                        "Voor deze nieuwe taak begint een nieuw gesprek",
                      )}
                    >
                      {tr("Nieuw gesprek")}
                    </Chip>
                  </div>
                  <p className="rz-hint">
                    {tr(
                      "Dit bepaalt de startcontext. De assistent behoudt zijn normale toegang tot je werkmap.",
                    )}
                  </p>
                </div>
              </>
            )}
          </>
        )}
        {error && (
          <p className="rz-error rz-task-wizard__error" role="alert">
            {savedId ? tr("De taak is opgeslagen. ") : ""}
            {translateMessage(error)}
          </p>
        )}
        <ModalFoot
          left={
            step === 1 ? (
              <>
                {company?.name}
                {tr(" · werkmap gekoppeld")}
              </>
            ) : (
              <TextButton
                icon={<ArrowLeft size={13} aria-hidden="true" />}
                disabled={busy}
                onClick={() => setStep(1)}
              >
                {tr("Terug")}
              </TextButton>
            )
          }
        >
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void save(false)}
          >
            {step === 1 ? tr("Alleen opslaan") : tr("Opslaan")}
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              if (step === 1)
                toStep2(tr("Vul een titel in en kies een project."));
              else void save(true);
            }}
          >
            {busy
              ? tr("Bezig…")
              : step === 1
                ? tr("Verder: uitvoering")
                : !today
                  ? tr("Taak inplannen")
                  : provider === "shell"
                    ? tr("Op Vandaag zetten")
                    : tr("Starten met {0}", providerName(provider))}
          </Button>
        </ModalFoot>
      </ModalBody>
    </Modal>
  );
}
