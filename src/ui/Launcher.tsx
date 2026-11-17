import { t as tr } from "../shared/i18n";
import { useEffect, useState, type ReactNode } from "react";
import { Check, TerminalSquare } from "lucide-react";
import type { Provider, Snapshot } from "../shared/types";
import type { SessionContextOptions } from "../shared/context";
import { AccountUsagePanel } from "./Usage";
import { GmailSessionChoice } from "./Integrations";
import type { GmailAccess, IntegrationOverview } from "../shared/integrations";
import { api, useWorkbench, type LauncherRequest } from "./model";
import { providerName, shortPath } from "./primitives";
import {
  Avatar,
  Button,
  Chip,
  Modal,
  ModalBody,
  ModalFoot,
  Field,
  Input,
  TextButton,
} from "./rz";

const allContext: SessionContextOptions = {
  assignment: true,
  criteria: true,
  business: true,
};
// What a conversation receives at the start, when it cannot be changed here (resume, or a mode without a choice).
function Given({ children }: { children: ReactNode }) {
  return (
    <span className="rz-chip rz-chip--toggle rz-launcher__given">
      <Check size={10} aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}
export function Launcher({
  request,
  close,
}: {
  request: LauncherRequest;
  close: () => void;
}) {
  const {
    snap,
    prefs,
    info,
    inventory,
    inspect,
    openSession,
    navigate,
    refresh,
    addAccount,
    error,
  } = useWorkbench();
  const task = snap.tasks.find((t) => t.id === request.taskId),
    company = snap.companies.find((c) => c.id === request.companyId),
    projects = snap.projects.filter((p) => p.companyId === request.companyId),
    createsTask =
      !!request.createTask &&
      request.mode === "work" &&
      !request.resume &&
      !request.taskId;
  const [chosenProvider, setProvider] = useState<Provider>(
      request.resume?.provider || request.provider || task?.provider || "codex",
    ),
    [busy, setBusy] = useState(false),
    [accountId, setAccountId] = useState(""),
    [taskTitle, setTaskTitle] = useState(""),
    [createdTaskId, setCreatedTaskId] = useState(""),
    [taskProjectId, setTaskProjectId] = useState(
      projects.some((p) => p.id === request.projectId)
        ? request.projectId!
        : projects[0]?.id || "",
    );
  const [agentId, setAgentId] = useState(request.agentId || task?.agentId || "");
  const agents = (snap.agents || []).filter(a => a.companyId === request.companyId && (!a.archived || a.id === agentId));
  const provider = agents.find(a => a.id === agentId)?.provider || chosenProvider;
  const project = snap.projects.find(
    (p) => p.id === (task?.projectId || taskProjectId),
  );
  const [gmail, setGmail] = useState<GmailAccess>("none");
  // Only a new work conversation has a choice: the store filters the start context for mode "work" only, and a
  // resumed conversation keeps the options it started with.
  const choosesContext = request.mode === "work" && !request.resume;
  const [context, setContext] = useState<SessionContextOptions>(allContext);
  useEffect(() => {
    if (info.browser) return;
    let canceled = false;
    void api<IntegrationOverview>("integrations.get")
      .then((value) => {
        if (!canceled)
          setGmail(
            request.resume
              ? value.sessions[request.resume.id] || "none"
              : "draft",
          );
      })
      .catch(() => {
        /* Work sessions remain usable without Gmail setup. */
      });
    return () => {
      canceled = true;
    };
  }, [request.resume?.id, info.browser]);
  const accounts = prefs.accounts.filter((a) => a.provider === provider);
  useEffect(() => {
    if (!inventory) void inspect();
  }, []);
  useEffect(() => {
    setAccountId(
      request.resume
        ? request.resume.accountId || ""
        : accounts.find((a) => a.companyIds.includes(request.companyId))?.id ||
            accounts.find((a) => a.globalDefault)?.id ||
            "",
    );
  }, [
    provider,
    request.companyId,
    request.resume?.id,
    prefs.accounts.map((a) => a.id).join(","),
  ]);
  const effectiveAccount = request.resume
    ? accounts.find((a) => a.id === request.resume?.accountId)
    : accounts.find((a) => a.id === accountId) ||
      accounts.find((a) => a.companyIds.includes(request.companyId)) ||
      accounts.find((a) => a.globalDefault);
  const start = async () => {
    if (createsTask && (!taskTitle.trim() || !project)) return;
    setBusy(true);
    try {
      let taskId = request.taskId || createdTaskId || null;
      if (createsTask && !taskId) {
        taskId = await api<string>("task.save", {
          value: {
            companyId: request.companyId,
            projectId: project!.id,
            goalId: project!.goalId ?? null,
            title: taskTitle.trim(),
            provider,
            agentId: agentId || null,
            kind: provider === "shell" ? "human" : "ai",
          },
        });
        setCreatedTaskId(taskId);
      }
      const id = await api<string>("session.start", {
        agentId: agentId || null,
        companyId: request.companyId,
        brainIntent: request.brainIntent,
        brainPageId: request.brainPageId,
        taskId,
        mode: request.mode,
        provider,
        accountId: provider === "shell" ? null : accountId || null,
        gmailAccess: provider === "shell" ? "none" : gmail,
        ...(request.resume ? { resumeFrom: request.resume.id } : {}),
        // Untouched chips send nothing, exactly like before: the store then defaults to everything.
        ...(choosesContext &&
        !(context.assignment && context.criteria && context.business)
          ? { contextOptions: context }
          : {}),
      });
      const next = await api<Snapshot>("snapshot");
      await refresh();
      const session = next.sessions.find((s) => s.id === id);
      if (request.mode === "suggestions" && !request.resume) navigate("today");
      else if (session) openSession(session, request.pane);
      close();
    } catch (e) {
      error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const accountSuffix = (a: (typeof accounts)[number]) =>
    a.companyIds.includes(request.companyId)
      ? tr(" · standaard voor dit bedrijf")
      : a.globalDefault
        ? tr(" · persoonlijk standaard")
        : "";
  const automatic = request.resume
    ? tr("Oorspronkelijke CLI-configuratie")
    : tr("Automatisch (bedrijfsstandaard)");
  const chosen = accounts.find((a) => a.id === accountId);
  const original =
    !!request.resume?.accountId &&
    !accounts.some((a) => a.id === request.resume?.accountId);
  const accountText = chosen
    ? chosen.label + accountSuffix(chosen)
    : original && accountId === request.resume?.accountId
      ? tr("Oorspronkelijk account")
      : automatic;
  const accountLocked = busy || !!request.resume;
  // A resumed work conversation keeps its own start context; every other mode always gets everything.
  const inherited: SessionContextOptions =
    request.mode === "work"
      ? { ...allContext, ...request.resume?.contextOptions }
      : allContext;
  const contextChoices = (
    [
      ["assignment", tr("Opdracht"), !!task],
      ["criteria", tr("Criteria"), !!task],
      ["business", tr("Bedrijfscontext"), true],
    ] as const
  ).filter(([, , shown]) => shown);
  return (
    <Modal
      title={
        request.resume
          ? tr("Waar wil je het gesprek hervatten?")
          : request.mode === "suggestions"
            ? tr("Wie maakt je drie voorstellen?")
            : request.mode === "intake"
              ? tr("Met wie wil je je bedrijf aanscherpen?")
              : request.mode === "planning"
                ? tr("Wie kijkt mee naar je prioriteiten?")
                : tr("Waarmee wil je aan deze taak werken?")
      }
      subtitle={[company?.name, project?.name, task?.title]
        .filter(Boolean)
        .join(" · ")}
      close={() => {
        if (!busy) close();
      }}
      width={600}
      className="rz-launcher"
    >
      <ModalBody className="rz-launcher__body" data-test="launcher">
        {request.mode === "work" && !request.resume && agents.length > 0 && <Field label={tr("Vaste agent")}><select className="rz-select" value={agentId} onChange={e => setAgentId(e.target.value)}><option value="">{tr("Zonder agentprofiel")}</option>{agents.map(a => <option key={a.id} value={a.id}>{a.name} · {providerName(a.provider)}</option>)}</select>{agentId && <p className="agent-muted">{tr("Opent de eigen chat van deze agent, met zijn briefing, geheugen en account.")}</p>}</Field>}
        {createsTask && (
          <div className="rz-launcher__task">
            <Field
              label={tr("Taaktitel")}
              error={
                projects.length
                  ? undefined
                  : tr("Maak eerst een project voor dit bedrijf.")
              }
            >
              <Input
                autoFocus
                value={taskTitle}
                maxLength={500}
                disabled={busy || !!createdTaskId}
                placeholder={tr("Wat wil je gedaan krijgen?")}
                data-test="launcher-task-title"
                onChange={(event) => setTaskTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void start();
                  }
                }}
              />
            </Field>
            {projects.length > 1 && (
              <Field label={tr("Project")}>
                <select
                  className="rz-select"
                  value={taskProjectId}
                  disabled={busy || !!createdTaskId}
                  onChange={(event) => setTaskProjectId(event.target.value)}
                >
                  {projects.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>
        )}
        {!agentId && <div className="rz-launcher__choices">
          {(["claude", "codex", "shell"] as Provider[])
            .filter((p) =>
              request.resume
                ? p === request.resume.provider
                : request.mode === "work" || p !== "shell",
            )
            .map((p) => {
              const cli = inventory?.providers.find((c) => c.name === p);
              return (
                <button
                  type="button"
                  key={p}
                  className="rz-choice rz-launcher__choice"
                  data-test="launcher-choice"
                  data-provider={p}
                  onClick={() => setProvider(p)}
                  aria-pressed={provider === p}
                  disabled={busy}
                >
                  {p === "shell" ? (
                    <TerminalSquare size={30} aria-hidden="true" />
                  ) : (
                    <Avatar provider={p} size={30} />
                  )}
                  <span className="rz-launcher__choice-text">
                    <span className="rz-launcher__choice-name">
                      {p === "shell" ? tr("Terminal") : providerName(p)}
                    </span>
                    <span className="rz-launcher__choice-desc">
                      {p === "shell"
                        ? tr(
                            "{0} · zelf werken zonder assistent",
                            inventory?.shell.split("/").pop() || "shell",
                          )
                        : cli
                          ? cli.path
                            ? tr("Beschikbaar")
                            : tr(
                                "Niet gevonden · installeer de CLI om te starten",
                              )
                          : tr("Je geïnstalleerde CLI en eigen configuratie")}
                    </span>
                  </span>
                  <span
                    className="rz-radio"
                    data-on={provider === p ? "" : undefined}
                    aria-hidden="true"
                  >
                    {provider === p && <Check size={9} />}
                  </span>
                </button>
              );
            })}
        </div>}
        {!agentId && provider !== "shell" && (
          <div className="rz-inset rz-launcher__account">
            <div className="rz-launcher__account-row">
              <span className="rz-launcher__label">{tr("Account")}</span>
              <div className="rz-launcher__account-pick">
                <Chip
                  size="sm"
                  onSide
                  chevron={!request.resume}
                  className="rz-launcher__select"
                  data-locked={accountLocked ? "" : undefined}
                  control={
                    <select
                      id="launch-account"
                      aria-label={tr("Account")}
                      value={accountId}
                      disabled={accountLocked}
                      onChange={(e) => setAccountId(e.target.value)}
                    >
                      <option value="">{automatic}</option>
                      {original && (
                        <option value={request.resume?.accountId || ""}>
                          {tr("Oorspronkelijk account")}
                        </option>
                      )}
                      {accounts.map((a) => (
                        <option value={a.id} key={a.id}>
                          {a.label}
                          {accountSuffix(a)}
                        </option>
                      ))}
                    </select>
                  }
                >
                  {accountText}
                </Chip>
                {!request.resume && (
                  <TextButton
                    tone="accent"
                    title={tr("Account toevoegen")}
                    onClick={() => addAccount(provider)}
                  >
                    {tr("Toevoegen")}
                  </TextButton>
                )}
              </div>
            </div>
            {effectiveAccount && (
              <AccountUsagePanel
                key={effectiveAccount.id}
                account={effectiveAccount}
                compact
                remaining
              />
            )}
            {!request.resume &&
              !accounts.some((a) =>
                a.companyIds.includes(request.companyId),
              ) && (
                <p className="rz-launcher__fallback">
                  {tr(
                    "Geen apart account voor {0}. {1} wordt gebruikt.",
                    company?.name || "",
                    chosen?.label || tr("Je bestaande configuratie"),
                  )}
                </p>
              )}
          </div>
        )}
        <div className="rz-launcher__context">
          <div className="rz-launcher__workdir">
            <span className="rz-launcher__label">{tr("Werkmap")}</span>
            <code className="rz-launcher__path">
              {shortPath(
                project?.workspacePath || company?.workspacePath || "",
                info.homeDir,
              )}
            </code>
          </div>
          {provider !== "shell" && <div className="rz-launcher__given-block">
            <span className="rz-launcher__label">
              {tr("Meegeven bij start")}
            </span>
            <div className="rz-launcher__chips">
              {contextChoices.map(([key, label]) =>
                choosesContext ? (
                  <Chip
                    key={key}
                    variant="toggle"
                    pressed={context[key]}
                    disabled={busy}
                    onClick={() =>
                      setContext({ ...context, [key]: !context[key] })
                    }
                  >
                    {label}
                  </Chip>
                ) : (
                  inherited[key] && <Given key={key}>{label}</Given>
                ),
              )}
              {request.resume && <Given>{tr("Bestaand gesprek")}</Given>}
            </div>
            {choosesContext && (
              <p className="rz-hint">
                {tr(
                  "Dit bepaalt de startcontext. De assistent behoudt zijn normale toegang tot je werkmap.",
                )}
              </p>
            )}
          </div>}
        </div>
        {provider !== "shell" && !info.browser && (
          <GmailSessionChoice
            value={gmail}
            onChange={setGmail}
            disabled={busy}
          />
        )}
        {request.mode !== "work" && (
          <p className="rz-hint">
            {request.mode === "suggestions"
              ? tr(
                  "Je assistent leest je bedrijfsdoelen en context en bedenkt drie nieuwe taken. De voorstellen verschijnen op Vandaag. Jij kiest wat je toevoegt. Dit gebruikt je gekozen AI-account.",
                )
              : request.mode === "planning"
                ? tr(
                    "Je assistent maakt een onderbouwd voorstel voor de volgorde. Jij kiest wat je overneemt.",
                  )
                : tr(
                    "Je assistent stelt gerichte vragen en doet daarna een voorstel voor je bedrijfsprofiel.",
                  )}
          </p>
        )}
        <ModalFoot>
          <Button variant="ghost" disabled={busy} onClick={close}>
            {tr("Annuleren")}
          </Button>
          <Button
            variant="primary"
            disabled={
              busy ||
              (createsTask && (!taskTitle.trim() || !project)) ||
              (provider !== "shell" &&
                !!inventory?.providers.find(
                  (p) => p.name === provider && !p.path,
                ))
            }
            onClick={() => void start()}
          >
            {busy
              ? tr("Starten…")
              : provider === "shell"
                ? tr("Terminal openen")
              : request.resume
                ? tr("Hervatten met {0}", providerName(provider))
                : tr("Starten met {0}", providerName(provider))}
          </Button>
        </ModalFoot>
      </ModalBody>
    </Modal>
  );
}
