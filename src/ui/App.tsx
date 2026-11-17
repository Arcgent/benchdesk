import { Brain } from "./Brain";
import { Agents } from "./Agents";
import { useLanguage } from "./language";
import { t as tr } from "../shared/i18n";
import { Workplace } from "./Workplace";
import { splitLeaf, leafIds, restoreCanvas } from "../shared/canvas";
import { TaskWizard } from "./TaskWizard";
import { ProProjectPage } from "./ProjectPage";
import { ProProjectsPage } from "./ProjectsPage";
import { ProCompanyPage } from "./CompanyPage";
import {
  useDesign,
  applyTheme,
  mergeTerminalPreferences,
  ThemeSwitch,
  useThemeSync,
} from "./Theme";
import { Sidebar } from "./Sidebar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  profileInput,
  type Inventory,
  type Preferences,
  type Session,
  type Snapshot,
  type Task,
  type WorkspaceState,
} from "../shared/types";
import { Editor, type EditorKind } from "./Editor";
import { Accounts } from "./Accounts";
import { Integrations } from "./Integrations";
import { Schedules } from "./Schedules";
import { Dashboard } from "./Dashboard";
import { Review } from "./Review";
import { Profile } from "./Profile";
import { AccountModal } from "./AccountModal";
import { Welcome } from "./Welcome";
import {
  AppLoading,
  ConnectionError,
  NoCompany,
  UpgradePage,
} from "./AppStates";
import { CompanyPicker, FileModal, ShortcutSheet, Toasts } from "./AppOverlays";
import { Proposals } from "./Proposals";
import { Launcher } from "./Launcher";
import {
  WorkbenchContext,
  api,
  type AppInfo,
  type LauncherRequest,
  type Workbench,
} from "./model";
import {
  dockSessions,
  sessionInCurrentOccurrence,
  waitingSession,
} from "./primitives";
import { ShellContext, cx } from "./rz";

const empty: Snapshot = {
  companies: [],
  departments: [],
  projects: [],
  goals: [],
  tasks: [],
  sessions: [],
  events: [],
  artifacts: [],
  proposals: [],
  checkins: [],
};
const initialWorkspace = (): WorkspaceState => {
  const defaults: WorkspaceState = {
    openCompanyIds: [],
    activeCompanyId: localStorage.getItem("werk-company") || "",
    split: false,
    panes: [null, null],
    focusedPane: 0,
    dockExpanded: true,
    ratio: 0.5,
  };
  try {
    const value = JSON.parse(
      localStorage.getItem("werk-workspace-v2") || "null",
    );
    // `openCompanyIds` belonged to the company tabs. States stored by older builds have it, newer ones may not:
    // accept both, keep whatever is there.
    return value && Array.isArray(value.panes)
      ? {
          ...defaults,
          ...value,
          openCompanyIds: Array.isArray(value.openCompanyIds)
            ? value.openCompanyIds.filter(
                (id: unknown) => typeof id === "string",
              )
            : [],
          closedSessionIds: Array.isArray(value.closedSessionIds)
            ? value.closedSessionIds.filter(
                (id: unknown) => typeof id === "string",
              )
            : [],
          canvas:
            "canvas" in value
              ? restoreCanvas(value.canvas)
              : value.panes
                  .filter(Boolean)
                  .reduce(
                    (tree: any, id: string) =>
                      splitLeaf(tree, leafIds(tree)[0], id),
                    null,
                  ),
          panes: [value.panes[0] || null, value.panes[1] || null],
          ratio: Math.min(0.7, Math.max(0.3, Number(value.ratio) || 0.5)),
          focusedPane: value.focusedPane === 1 && value.split ? 1 : 0,
          // The company tab is the active company now; only "Alle" is stored (older builds kept a company id).
          canvasFilter: value.canvasFilter === "all" ? "all" : undefined,
        }
      : defaults;
  } catch {
    return defaults;
  }
};
// README "Responsief": the sidebar is collapsible and closes by itself below 1000px.
const sidebarKey = "benchdesk-sidebar";
const roomForSidebar = () => window.innerWidth >= 1000;

export function App() {
  const language = useLanguage();
  // Re-render the whole app when Profiel → Stijl changes, so derived labels (sessionTitle) follow at once.
  useDesign();
  const [upgradeSessions, setUpgradeSessions] = useState<
    import("../runtime/upgrade").UpgradeSession[] | null
  >(null);
  const [connectionError, setConnectionError] = useState("");
  const [snap, setSnap] = useState(empty),
    [loaded, setLoaded] = useState(false),
    [workspace, setWorkspace] = useState(initialWorkspace);
  const previousLiveSessions = useRef<Set<string> | null>(null);
  const [view, setView] = useState("today"),
    [selectedTask, setSelectedTask] = useState<string | null>(null),
    [editor, setEditor] = useState<{ kind: EditorKind; value?: any } | null>(
      null,
    );
  // A background load (refresh, preferences) that fails while the runner reconnects must not leave
  // its message on screen once the next refresh works again. Errors from the user's own actions stay.
  const backgroundError = useRef("");
  const [errorMessage, setError] = useState(""),
    [noticeMessage, setNotice] = useState(""),
    [launcher, setLauncher] = useState<LauncherRequest | null>(null),
    [companyPicker, setCompanyPicker] = useState(false),
    [cheatsheet, setCheatsheet] = useState(false),
    [accountProvider, setAccountProvider] = useState<"claude" | "codex" | null>(
      null,
    );
  const [prefs, setPrefs] = useState<Preferences>({
      profile: profileInput.parse({}),
      accounts: [],
    }),
    [inventory, setInventory] = useState<Inventory | null>(null),
    [inspecting, setInspecting] = useState(false);
  const [info, setInfo] = useState<AppInfo>({
    dataDir: "",
    defaultWorkspace: "",
    homeDir: "",
    version: "",
    platform: "darwin",
  });
  useEffect(() => {
    if (info.version && !info.browser)
      void api("app.language", { language }).catch((e) => setError(e.message));
  }, [language, info.version, info.browser]);
  const [filePath, setFilePath] = useState<string | null>(null),
    [proposalId, setProposalId] = useState<string | null>(null),
    [proposalFrom, setProposalFrom] = useState("today");
  const [sidebarOpen, setSidebarOpen] = useState(
      () => roomForSidebar() && localStorage.getItem(sidebarKey) !== "closed",
    ),
    [prefsLoaded, setPrefsLoaded] = useState(false);
  useThemeSync(prefsLoaded ? prefs.profile.appearance : null);
  useEffect(() => {
    let room = roomForSidebar();
    const resize = () => {
      if (room === roomForSidebar()) return;
      room = !room;
      setSidebarOpen(room);
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    if (roomForSidebar())
      localStorage.setItem(sidebarKey, sidebarOpen ? "open" : "closed");
  }, [sidebarOpen]);
  const shell = useMemo(
    () => ({ sidebarOpen, showSidebar: () => setSidebarOpen(true) }),
    [sidebarOpen],
  );
  const hydrated = useRef(false),
    scan = useRef(false),
    refreshInFlight = useRef<Promise<void> | null>(null),
    refreshAgain = useRef(false);
  const companyId = workspace.activeCompanyId,
    company = snap.companies.find((c) => c.id === companyId);
  const project = snap.projects.find(
      (p) => p.id === view && p.companyId === companyId,
    ),
    task = snap.tasks.find((t) => t.id === selectedTask),
    proposal = snap.proposals.find((p) => p.id === proposalId);
  const refresh = useCallback(async () => {
    if (refreshInFlight.current) {
      refreshAgain.current = true;
      return refreshInFlight.current;
    }
    const promise = (async () => {
      try {
        do {
          refreshAgain.current = false;
          const next = await api<Snapshot>("snapshot");
          setSnap(next);
        } while (refreshAgain.current);
        setLoaded(true);
        setUpgradeSessions(null);
        setConnectionError("");
        const stale = backgroundError.current;
        if (stale) {
          backgroundError.current = "";
          setError((current) => (current === stale ? "" : current));
        }
      } catch (e) {
        const status = await api<{
          upgradeSessions: import("../runtime/upgrade").UpgradeSession[] | null;
        }>("runtime.status");
        setUpgradeSessions(status.upgradeSessions);
        setConnectionError((e as Error).message);
        throw e;
      }
    })();
    refreshInFlight.current = promise;
    try {
      await promise;
    } finally {
      refreshInFlight.current = null;
    }
  }, []);
  const refreshPreferences = useCallback(async () => {
    const value = await api<Preferences>("preferences.get");
    setPrefs({
      ...value,
      profile: mergeTerminalPreferences(value.profile),
    });
    setPrefsLoaded(true);
  }, []);
  const reportBackground = useCallback((e: Error) => {
    backgroundError.current = e.message;
    setError(e.message);
  }, []);
  useEffect(() => {
    void refresh().catch((e) => {
      reportBackground(e);
      setLoaded(true);
    });
    void api<AppInfo>("app.info")
      .then(setInfo)
      .catch(reportBackground);
    void refreshPreferences().catch(reportBackground);
    // Hooks fire "changed" many times a minute while assistants work; each refresh is a full snapshot. Bundle a
    // burst into one refresh so replies do not pile up on the runner connection.
    let changed: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = window.werk.onEvent((e) => {
      // At most one refresh per 300 ms, and always one: a busy session must not keep postponing it.
      if (e.type === "changed") {
        changed ??= setTimeout(() => {
          changed = undefined;
          void refresh().catch(reportBackground);
        }, 300);
      } else if (e.type === "reconnected")
        void refresh().catch(reportBackground);
    });
    const timer = setInterval(
      () => void refresh().catch(reportBackground),
      12000,
    );
    return () => {
      unsubscribe();
      clearTimeout(changed);
      clearInterval(timer);
    };
  }, [refresh, refreshPreferences, reportBackground]);
  useEffect(() => {
    if (!loaded) return;
    const firstLoad = !hydrated.current;
    setWorkspace((w) => {
      const ids = new Set(snap.companies.map((c) => c.id));
      const active = ids.has(w.activeCompanyId)
        ? w.activeCompanyId
        : firstLoad || w.activeCompanyId
          ? snap.companies[0]?.id || ""
          : "";
      return {
        ...w,
        activeCompanyId: active,
        panes: w.panes.map((id) =>
          snap.sessions.some((s) => s.id === id) ? id : null,
        ) as WorkspaceState["panes"],
      };
    });
    hydrated.current = true;
  }, [loaded, snap.companies.map((c) => c.id).join(",")]);
  useEffect(() => {
    if (loaded) {
      localStorage.setItem("werk-workspace-v2", JSON.stringify(workspace));
      localStorage.setItem("werk-company", companyId);
    }
  }, [workspace, loaded, companyId]);
  useEffect(() => {
    if (!loaded) return;
    const previous = previousLiveSessions.current;
    // Agent chats only run during a turn and stay on the canvas in between.
    const live = new Set(
      snap.sessions
        .filter((s) => s.alive || s.transport === "chat")
        .map((s) => s.id),
    );
    previousLiveSessions.current = live;
    const stopped = new Set(
      previous
        ? [...previous].filter((id) => !live.has(id))
        : snap.sessions
            .filter((s) => !s.alive && s.transport !== "chat")
            .map((s) => s.id),
    );
    if (!stopped.size) return;
    setWorkspace((w) => {
      // Only clear newly stopped sessions. A historical conversation explicitly
      // opened afterwards must stay readable through subsequent refreshes.
      const valid = new Set(
        snap.sessions.filter((s) => !stopped.has(s.id)).map((s) => s.id),
      );
      const canvas = restoreCanvas(w.canvas, valid);
      return {
        ...w,
        canvas,
        canvasFocus: stopped.has(w.canvasFocus || "")
          ? leafIds(canvas)[0]
          : w.canvasFocus,
        panes: w.panes.map((id) =>
          id && !stopped.has(id) ? id : null,
        ) as WorkspaceState["panes"],
      };
    });
  }, [loaded, snap.sessions]);
  useEffect(() => {
    if (!noticeMessage) return;
    const timer = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timer);
  }, [noticeMessage]);
  // With data on screen a lost connection used to show nothing at all. A reconnect normally takes
  // a fraction of a second, so only say so when it lasts.
  const [reconnecting, setReconnecting] = useState(false);
  useEffect(() => {
    if (!connectionError || !snap.companies.length) {
      setReconnecting(false);
      return;
    }
    const timer = setTimeout(() => setReconnecting(true), 2000);
    return () => clearTimeout(timer);
  }, [connectionError, snap.companies.length]);
  useEffect(() => {
    delete document.documentElement.dataset.appearance;
  }, [prefs.profile.appearance]);
  useEffect(() => {
    localStorage.setItem(
      "benchdesk-terminal-preset",
      prefs.profile.terminalPreset,
    );
    applyTheme(
      localStorage.getItem("benchdesk-theme") || "light",
      prefs.profile.terminalPreset,
    );
  }, [prefs.profile.terminalPreset]);
  const inspect = async () => {
    if (scan.current) return;
    scan.current = true;
    setInspecting(true);
    try {
      setInventory(
        await api<Inventory>("inventory", {
          companyId: companyId || undefined,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      scan.current = false;
      setInspecting(false);
    }
  };
  useEffect(() => {
    if (loaded && !connectionError && !upgradeSessions) {
      if (!inventory) void inspect();
      void refreshPreferences().catch(reportBackground);
    }
  }, [loaded, connectionError, !!upgradeSessions, companyId]);
  // An action's own failure must stay visible: the next refresh does not clear it.
  const reportAction = useCallback((message: string) => {
    backgroundError.current = "";
    setError(message);
  }, []);
  const run: Workbench["run"] = async (fn, success) => {
    try {
      setError("");
      const result = await fn();
      await refresh();
      if (success) setNotice(success);
      return result;
    } catch (e) {
      reportAction((e as Error).message);
      return undefined;
    }
  };
  const errorFn = reportAction;
  const navigate = (next: string) => {
    setView(next);
    setCheatsheet(false);
  };
  // next: the Agents page opens another company's agent and lands on it directly.
  const switchCompany = (id: string, next?: string) => {
    // A company chosen anywhere is also the company tab on "Aan het werk": "Alle" is left behind.
    if (next || view === "agents" || view.startsWith("agent:")) {
      setWorkspace(w => ({ ...w, activeCompanyId: id, canvasFilter: undefined })); setCompanyPicker(false); setView(next || "agents"); setInventory(null); return;
    }
    setWorkspace((w) => ({ ...w, activeCompanyId: id, canvasFilter: undefined }));
    setCompanyPicker(false);
    if (
      ![
        "workspace",
        "settings",
        "schedules",
        "accounts",
        "integrations",
        "brain",
      ].includes(view)
    )
      setView("today");
    setInventory(null);
  };
  const edit = (kind: EditorKind, value?: any) => setEditor({ kind, value });
  const newTask = () => {
    if (!company) {
      setCompanyPicker(true);
      return;
    }
    const projects = snap.projects.filter((p) => p.companyId === companyId);
    if (!projects.length) edit("project");
    else
      edit(
        "task",
        project ? { projectId: project.id, goalId: project.goalId } : undefined,
      );
  };
  const openSession = (session: Session, pane?: 0 | 1) => {
    if (session.transport === "chat" && session.agentId && session.conversationId) {
      setWorkspace(w => ({ ...w, activeCompanyId: session.companyId }));
      setSelectedTask(session.taskId); setView(`agent:${session.agentId}:${session.conversationId}`); return;
    }
    setWorkspace((w) => {
      const existing = w.panes.indexOf(session.id);
      const index =
        (w.workspaceMode !== "canvas" ? 0 : pane) ??
        (existing >= 0 && (existing === 0 || w.split)
          ? (existing as 0 | 1)
          : w.focusedPane);
      const panes: WorkspaceState["panes"] = [...w.panes];
      const other = index === 0 ? 1 : 0;
      if (panes[other] === session.id) panes[other] = panes[index];
      panes[index] = session.id;
      return {
        ...w,
        panes,
        closedSessionIds: (w.closedSessionIds || []).filter(
          (id) => id !== session.id,
        ),
        canvas:
          w.workspaceMode === "canvas"
            ? splitLeaf(
                w.canvas,
                w.canvasFocus || leafIds(w.canvas)[0],
                session.id,
                w.pendingSplitDir || "row",
              )
            : w.canvas,
        canvasFocus: session.id,
        pendingSplitDir: undefined,
        focusedPane: index,
        activeCompanyId: session.companyId,
        split: index === 1 ? true : w.split,
      };
    });
    setSelectedTask(session.taskId);
    setView("workspace");
  };
  const openTask = (selected: Task, review = false) => {
    setSelectedTask(selected.id);
    setView(review ? "review" : "workspace");
    const last = snap.sessions
      .filter((s) => sessionInCurrentOccurrence(selected, s))
      .sort(
        (a, b) =>
          Number(!!b.alive) - Number(!!a.alive) ||
          b.createdAt.localeCompare(a.createdAt),
      )[0];
    if (!review && last?.transport === "chat") { openSession(last); return; }
    setWorkspace((w) => ({
      ...w,
      activeCompanyId: selected.companyId,
      closedSessionIds: (w.closedSessionIds || []).filter(
        (id) => id !== last?.id,
      ),
      ...(!review
        ? {
            panes: [last?.id || null, null] as WorkspaceState["panes"],
            focusedPane: 0,
            workspaceMode: "conversation" as const,
            split: false,
          }
        : {}),
    }));
  };
  const launch = (request: LauncherRequest) => {
    if (!request.companyId) {
      setCompanyPicker(true);
      return;
    }
    setLauncher(request);
  };
  const sessions = dockSessions(snap);
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement;
      const inInput = target.matches(
        "input, textarea, select, [contenteditable=true]",
      );
      if (document.querySelector('[role="dialog"]')) return;
      if (e.key === "Escape" && cheatsheet) {
        setCheatsheet(false);
        return;
      }
      if (e.metaKey || e.ctrlKey) {
        const key = e.key.toLowerCase();
        if (key === ",") {
          e.preventDefault();
          navigate("settings");
        } else if (key === "/") {
          e.preventDefault();
          setCheatsheet((show) => !show);
        } else if (key === "n") {
          e.preventDefault();
          if (e.shiftKey) setCompanyPicker(true);
          else newTask();
        } else if (key === "p") {
          e.preventDefault();
          launch({ mode: "planning", companyId });
        } else if (key === "d") {
          e.preventDefault();
          const splitCompanyId = companyId;
          setView("workspace");
          setTimeout(
            () =>
              window.dispatchEvent(
                new CustomEvent("benchdesk-workspace", {
                  detail: {
                    command: e.shiftKey ? "new-down" : "new-right",
                    companyId: splitCompanyId,
                    projectId:
                      project?.companyId === splitCompanyId
                        ? project.id
                        : undefined,
                  },
                }),
              ),
            0,
          );
        } else if (key === "w") {
          // Closes the focused conversation on "Aan het werk" (Workplace decides); nothing to close elsewhere.
          e.preventDefault();
          if (view === "workspace")
            window.dispatchEvent(
              new CustomEvent("benchdesk-workspace", { detail: "close" }),
            );
        } else if (key === "s" && e.shiftKey) {
          e.preventDefault();
          setSidebarOpen((open) => !open);
        } else if (key === "t") {
          e.preventDefault();
          const s = snap.sessions.find(
            (s) =>
              s.id ===
              (workspace.workspaceMode === "canvas"
                ? workspace.canvasFocus
                : workspace.panes[0]),
          );
          launch({
            mode: "work",
            companyId: s?.companyId || companyId,
            taskId:
              view === "workspace"
                ? s?.taskId || selectedTask || undefined
                : undefined,
            pane: workspace.focusedPane,
          });
        } else if (
          e.shiftKey &&
          ["BracketLeft", "BracketRight"].includes(e.code)
        ) {
          e.preventDefault();
          const ids = snap.companies.map((c) => c.id),
            at = ids.indexOf(companyId);
          if (ids.length)
            switchCompany(
              ids[
                (at + (e.code === "BracketRight" ? 1 : -1) + ids.length) %
                  ids.length
              ],
            );
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (e.shiftKey) {
            const first = sessions.find((s) => waitingSession(s, snap));
            if (first) openSession(first);
          } else
            document
              .querySelector<HTMLButtonElement>(
                view === "review"
                  ? "[data-review-submit]"
                  : "[data-submit-task]",
              )
              ?.click();
        } else if (/^[1-9]$/.test(key)) {
          e.preventDefault();
          const index = Number(key) - 1;
          if (sessions[index]) openSession(sessions[index]);
          else if (index < 3)
            navigate(["today", "projects", "workspace"][index]);
        }
      } else if (
        e.key === "Enter" &&
        !inInput &&
        !target.closest("button, a")
      ) {
        document
          .querySelector<HTMLButtonElement>("[data-primary-action]")
          ?.click();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });
  const context: Workbench = {
    snap,
    company,
    companyId,
    view,
    selectedTask,
    prefs,
    info,
    inventory,
    inspecting,
    workspace,
    setWorkspace,
    sidebarOpen,
    setSidebarOpen,
    navigate,
    switchCompany,
    edit,
    newTask,
    launch,
    openTask,
    openSession,
    showFile: setFilePath,
    showProposal: (p) => {
      if (p.kind === "suggestions") {
        navigate("today");
        return;
      }
      // The proposal page leads back to where it was opened from (a Vandaag row, or the bell on any page).
      if (view !== "proposal") setProposalFrom(view);
      setProposalId(p.id);
      setView("proposal");
    },
    run,
    refresh,
    refreshPreferences,
    inspect,
    error: errorFn,
    notice: setNotice,
    shortcuts: () => setCheatsheet((v) => !v),
    addAccount: (provider = "claude") => setAccountProvider(provider),
  };
  // Set by main.tsx before the first render: Electron on macOS draws the traffic lights over the page.
  const mac = document.documentElement.dataset.chrome === "mac";
  const fullWindow =
    !!upgradeSessions ||
    (!!connectionError && !snap.companies.length) ||
    !loaded ||
    !snap.companies.length;
  return (
    <WorkbenchContext.Provider value={context}>
      <div
        className={cx(
          "rz-app",
          fullWindow ? "rz-app--full" : !sidebarOpen && "rz-app--side-closed",
          mac && "rz-app--mac",
        )}
        data-test="app"
      >
        {mac && <div className="rz-app__drag" aria-hidden="true" />}
        {fullWindow ? (
          <>
            <div className="rz-app__fullbar">
              {info.browser && info.preview && (
                <span className="rz-app__preview">
                  {tr("Voorbeeldgegevens")}
                </span>
              )}
              <ThemeSwitch />
            </div>
            {upgradeSessions ? (
              <UpgradePage sessions={upgradeSessions} />
            ) : connectionError && !snap.companies.length ? (
              <ConnectionError message={connectionError} />
            ) : !loaded ? (
              <AppLoading />
            ) : (
              <Welcome
                info={info}
                inventory={inventory}
                run={run}
                created={(id, intake) => {
                  switchCompany(id);
                  if (intake) launch({ mode: "intake", companyId: id });
                }}
              />
            )}
          </>
        ) : (
          <ShellContext.Provider value={shell}>
            <Sidebar />
            <main className="rz-app__main" data-test="main">
              {/* Every page brings its own "Zijbalk tonen" button (PageShell, Review, the Workplace top bar). */}
              {view === "workspace" ? (
                <Workplace />
              ) : view === "review" && task ? (
                <Review key={task.id} task={task} />
              ) : view === "settings" ? (
                <Profile key={companyId} />
              ) : view === "accounts" ? (
                <Accounts />
              ) : view === "integrations" ? (
                <Integrations />
              ) : view === "schedules" ? (
                <Schedules />
              ) : !company ? (
                <NoCompany open={() => setCompanyPicker(true)} />
              ) : view === "brain" ? (
                <Brain key={companyId} />
              ) : view === "agents" || view.startsWith("agent:") ? (
                <Agents key={companyId} />
              ) : view === "company" ? (
                <ProCompanyPage key={companyId} />
              ) : project ? (
                <ProProjectPage key={project.id} project={project} />
              ) : view === "tasks" ? (
                <ProProjectPage />
              ) : view === "projects" ? (
                <ProProjectsPage />
              ) : view === "proposal" && proposal ? (
                <Proposals proposal={proposal} from={proposalFrom} />
              ) : (
                <Dashboard />
              )}
            </main>
          </ShellContext.Provider>
        )}
        {editor &&
          (editor.kind === "task" && !editor.value?.id ? (
            <TaskWizard value={editor.value} close={() => setEditor(null)} />
          ) : (
            <Editor
              key={`${editor.kind}-${editor.value?.id || "new"}`}
              {...editor}
              company={
                editor.value?.companyId
                  ? snap.companies.find(
                      (c) => c.id === editor.value.companyId,
                    ) || company
                  : company
              }
              snapshot={snap}
              defaultWorkspace={info.defaultWorkspace}
              close={() => setEditor(null)}
              onSaved={(kind, id, start) => {
                void run(async () => {
                  const next = await api<Snapshot>("snapshot");
                  setSnap(next);
                  if (kind === "company" && id) switchCompany(id);
                  if (kind === "project" && id) navigate(id);
                  if (kind === "department") navigate("projects");
                  if (kind === "task" && id) {
                    const task = next.tasks.find((t) => t.id === id);
                    if (task) {
                      openTask(task);
                      if (start)
                        launch({
                          mode: "work",
                          companyId: task.companyId,
                          taskId: id,
                        });
                    }
                  } else if (kind === "task") {
                    setSelectedTask(null);
                    navigate("today");
                  }
                });
              }}
            />
          ))}
        {launcher && (
          <Launcher
            key={`${launcher.companyId}-${launcher.taskId}-${launcher.resume?.id}`}
            request={launcher}
            close={() => setLauncher(null)}
          />
        )}
        {companyPicker && (
          <CompanyPicker close={() => setCompanyPicker(false)} />
        )}
        {accountProvider && (
          <AccountModal
            provider={accountProvider}
            close={() => setAccountProvider(null)}
          />
        )}
        {filePath && (
          <FileModal path={filePath} close={() => setFilePath(null)} />
        )}
        {cheatsheet && <ShortcutSheet close={() => setCheatsheet(false)} />}
        <Toasts
          error={upgradeSessions || connectionError ? "" : errorMessage}
          notice={noticeMessage}
          status={
            reconnecting && !upgradeSessions
              ? tr("Verbinding met de achtergrondservice herstellen…")
              : ""
          }
          closeError={() => setError("")}
        />
      </div>
    </WorkbenchContext.Provider>
  );
}
