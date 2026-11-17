import { t as tr, translateMessage } from "../shared/i18n";
import { ComputerButton, computerSupported } from "./ComputerControl";
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUp,
  Bot,
  Columns2,
  Ellipsis,
  FileText,
  Grid2X2,
  Link2,
  List,
  Maximize2,
  Minimize2,
  Monitor,
  PanelLeft,
  PanelRight,
  PenLine,
  Rows2,
  Square,
  TerminalSquare,
  X,
} from "lucide-react";
import { api, useWorkbench } from "./model";
import {
  companyTint,
  conversationStatus,
  formatTime,
  sessionTitle,
  shortPath,
  type ConversationStatus,
} from "./primitives";
import {
  Badge,
  Button,
  Empty,
  IconButton,
  Menu,
  Select,
  StatusDot,
  Tabs,
  TextButton,
  Toast,
  cx,
  type MenuItem,
} from "./rz";
import { Terminal } from "./Terminal";
import { CanvasChat, Face } from "./Agents";
import { MemoryButton } from "./SessionMemory";
import {
  countText,
  useSessionFiles,
  SessionFilesButton,
  SessionFilesPanel,
} from "./SessionFiles";
import { TaskInfo } from "./TaskInfo";
import { useDesign } from "./Theme";
import {
  assistantName,
  canvasRoom,
  resumable,
  useConversations,
} from "./ConversationList";
import type { AgentConversation } from "../shared/agents";
import type { Session, WorkEvent } from "../shared/types";
import { canvasLayout, setRatio, type CanvasTree } from "../shared/canvas";

// "Afdeling › Project · Assistent" next to the title; the whole context (with the company) is the tooltip.
function useContextLine(session: Session) {
  const { snap } = useWorkbench();
  const company = snap.companies.find((c) => c.id === session.companyId);
  const task = snap.tasks.find(
    (t) => t.id === session.taskId && t.companyId === session.companyId,
  );
  const project = snap.projects.find(
    (p) => p.id === task?.projectId && p.companyId === session.companyId,
  );
  const department = snap.departments.find(
    (d) => d.id === project?.departmentId && d.companyId === session.companyId,
  );
  const assistant = assistantName(session.provider);
  return {
    company,
    meta: [
      project &&
        (department ? `${department.name} › ${project.name}` : project.name),
      assistant,
    ]
      .filter(Boolean)
      .join(" · "),
    full: [
      company?.name,
      project
        ? `${department?.name || tr("Zonder afdeling")} › ${project.name}`
        : tr("Vrij gesprek"),
      assistant,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

const liveText = (status: ConversationStatus, assistant: string) =>
  status.key === "busy"
    ? tr("{0} werkt verder…", assistant)
    : status.key === "starting"
      ? tr("{0} start…", assistant)
      : status.key === "waiting"
        ? tr("Wacht op je antwoord")
        : status.key === "paused"
          ? tr("Gepauzeerd — hervat om verder te gaan")
          : status.key === "closed"
            ? tr("Gesprek beëindigd")
            : status.key === "error"
              ? tr("Gestopt met een fout")
              : status.key === "interrupted" || status.key === "unknown"
                ? status.label
                : tr("Klaar voor een opdracht");

// The design's transcript, built from what the conversation really reported (D6): no invented "❯" rows, the
// user's own prompts are not stored. Marks: · note / progress, ? blocked, ✓ result with its files.
function Activity({
  session,
  status,
}: {
  session: Session;
  status: ConversationStatus;
}) {
  const { snap, showFile } = useWorkbench();
  const events = snap.events
    .filter((e) => e.sessionId === session.id)
    .slice()
    .reverse();
  const results = events.filter((e) => e.kind === "result");
  // A file belongs to the result it was handed in with: the first result at or after it.
  const files = (event: WorkEvent) =>
    event.kind !== "result"
      ? []
      : snap.artifacts
          .filter(
            (a) =>
              a.sessionId === session.id &&
              (
                results.find((r) => r.createdAt >= a.createdAt) ||
                results[results.length - 1]
              ).id === event.id,
          )
          .filter((a, i, all) => all.findIndex((b) => b.path === a.path) === i);
  const text = (event: WorkEvent) =>
    [session.outputDir, session.cwd]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .reduce(
        (value, path) => value.split(path).join(shortPath(path)),
        ["session_start", "session_end"].includes(event.kind)
          ? translateMessage(event.summary)
          : event.summary,
      );
  const kind = (event: WorkEvent) =>
    event.kind === "blocked"
      ? "question"
      : event.kind === "result"
        ? "result"
        : event.kind === "progress"
          ? "message"
          : "note";
  return (
    <div
      className="rz-term rz-pane__log"
      role="log"
      aria-label={tr("Gespreksactiviteit")}
    >
      <div className="rz-pane__lines">
        {events.map((event) => (
          <div className="rz-pane__line" data-kind={kind(event)} key={event.id}>
            <time className="rz-pane__time">{formatTime(event.createdAt)}</time>
            <span className="rz-pane__mark" aria-hidden="true">
              {event.kind === "blocked"
                ? "?"
                : event.kind === "result"
                  ? "✓"
                  : "·"}
            </span>
            <div className="rz-pane__said">
              <span className="rz-pane__text" title={event.summary}>
                {text(event)}
              </span>
              {files(event).map((file) => (
                <button
                  type="button"
                  className="rz-pane__file"
                  key={file.id}
                  title={shortPath(file.path)}
                  onClick={() => showFile(file.path)}
                >
                  <FileText size={12} aria-hidden="true" />
                  <span className="rz-pane__file-name">{file.name}</span>
                  <span className="rz-pane__file-meta">
                    · {formatTime(file.createdAt)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
        {!events.length && (
          <p className="rz-pane__log-empty">
            {tr(
              "Nog geen voortgang gemeld. Open Volledige bediening om het gesprek te bekijken.",
            )}
          </p>
        )}
        <div className="rz-pane__line" data-kind="live">
          <span className="rz-pane__time">
            {events.length
              ? formatTime(events[events.length - 1].createdAt)
              : "—"}
          </span>
          <span className="rz-pane__mark" aria-hidden="true">
            ›
          </span>
          <span>
            {liveText(status, assistantName(session.provider))}
            <i
              className="rz-pane__cursor"
              data-busy={status.key === "busy" ? "" : undefined}
              aria-hidden="true"
            />
          </span>
        </div>
      </div>
      {session.memory && (
        <div className="rz-pane__note">
          <small>
            {tr("Laatste notitie ·")} {formatTime(session.memory.updatedAt)}
          </small>
          <p>{session.memory.summary}</p>
        </div>
      )}
    </div>
  );
}

// Only under Activiteit (D6): the live view has its own input. An assistant gets the text as a message (held
// back until it is ready for it), your own conversation gets it typed in as one pasted line.
function PaneComposer({ session }: { session: Session }) {
  const { error } = useWorkbench();
  const [draft, setDraft] = useState(""),
    [busy, setBusy] = useState(false),
    [queued, setQueued] = useState(false);
  const shell = session.provider === "shell",
    assistant = assistantName(session.provider);
  const placeholder = shell
    ? tr("Geef een opdracht")
    : tr("Stuur {0} een aanwijzing", assistant);
  useEffect(() => {
    if (session.state === "idle") setQueued(false);
  }, [session.state]);
  const send = async () => {
    const message = draft.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim();
    if (!message || busy) return;
    setBusy(true);
    try {
      if (shell)
        await api("session.write", {
          id: session.id,
          data: `\x1b[200~${message}\x1b[201~\r`,
        });
      else
        setQueued(
          !!(
            await api<{ queued?: boolean }>("session.message", {
              id: session.id,
              message,
            })
          )?.queued,
        );
      setDraft("");
    } catch (e) {
      error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rz-composer-dock rz-composer-dock--pane rz-pane__dock">
      <form
        className="rz-composer rz-composer--line rz-pane__composer"
        data-test="pane-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          className="rz-composer__input"
          aria-label={placeholder}
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.nativeEvent.isComposing)
              e.preventDefault();
          }}
        />
        <button
          type="submit"
          className="rz-send"
          aria-label={tr("Versturen")}
          title={tr("Versturen")}
          disabled={busy || !draft.trim()}
        >
          <ArrowUp size={15} aria-hidden="true" />
        </button>
      </form>
      {queued && (
        <p className="rz-pane__queued" role="status">
          {tr("Wordt verstuurd zodra {0} klaar is.", assistant)}
        </p>
      )}
    </div>
  );
}

// Minimaal: no frame and no gap; neighbouring panes meet at the divider's 1px line.
const paneStyle = (
  rect: { x: number; y: number; w: number; h: number },
  flush: boolean,
  dim: boolean,
) => ({
  left: flush ? `${rect.x * 100}%` : `calc(${rect.x * 100}% + 4px)`,
  top: flush ? `${rect.y * 100}%` : `calc(${rect.y * 100}% + 4px)`,
  width: flush ? `${rect.w * 100}%` : `calc(${rect.w * 100}% - 8px)`,
  height: flush ? `${rect.h * 100}%` : `calc(${rect.h * 100}% - 8px)`,
  opacity: dim ? 0.35 : 1,
});

// An agent conversation on the canvas: the same chat as on the Agents page. Closing only takes it off the
// canvas; the conversation itself stays with the agent.
function AgentPane({
  session,
  rect,
  dim,
  focused,
  maximised,
}: {
  session: Session;
  rect: { x: number; y: number; w: number; h: number };
  dim: boolean;
  focused: boolean;
  maximised: boolean;
}) {
  const { snap, navigate } = useWorkbench();
  const { closePane, focus, maximise, restore } = useConversations();
  const minimal = useDesign() === "minimaal";
  const conversation = snap.agentConversations?.find(
      (c) => c.id === session.conversationId,
    ),
    agent = snap.agents?.find((a) => a.id === conversation?.agentId),
    company = snap.companies.find((c) => c.id === session.companyId),
    title = conversation?.title || tr("Nieuw gesprek"),
    status = conversationStatus(session, snap);
  return (
    <section
      className="rz-pane rz-pane--agent"
      data-test="pro-canvas-pane"
      data-session-id={session.id}
      data-focused={focused ? "" : undefined}
      data-maximised={maximised ? "" : undefined}
      aria-label={agent ? `${agent.name} · ${title}` : title}
      onPointerDown={() => focus(session.id)}
      onFocusCapture={() => focus(session.id)}
      style={paneStyle(rect, maximised || minimal, dim)}
    >
      <div
        className="rz-pane__inner"
        data-test={focused ? "pro-conversation-main" : undefined}
      >
        <header className="rz-pane__head">
          <Badge
            name={company?.name || tr("Bedrijf")}
            tint={companyTint(session.companyId, snap)}
            title={company?.name}
          />
          {agent && (
            <span className="ob-look agent-canvas__face">
              <Face agent={agent} size="xs" />
            </span>
          )}
          <strong className="rz-pane__title">{title}</strong>
          <span className="rz-pane__meta">{agent?.name}</span>
          <StatusDot
            size={12}
            tone={status.tone}
            className="rz-pane__status"
            title={status.label}
            label={<span className="rz-pane__status-text">{status.label}</span>}
          />
          <div className="rz-pane__actions">
            {agent && conversation && (
              <IconButton
                label={tr("Openen bij Agents")}
                onClick={() =>
                  navigate(`agent:${agent.id}:${conversation.id}`)
                }
              >
                <Bot size={15} />
              </IconButton>
            )}
            <IconButton
              label={maximised ? tr("Terug naar indeling") : tr("Vergroten")}
              onClick={() => (maximised ? restore() : maximise(session.id))}
            >
              {maximised ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </IconButton>
            <IconButton
              label={tr("Van canvas halen")}
              title={tr("Van canvas halen (⌘W) — het gesprek blijft bij de agent")}
              onClick={() => closePane(session.id)}
            >
              <X size={14} />
            </IconButton>
          </div>
        </header>
        <div className="rz-pane__body">
          <CanvasChat session={session} />
        </div>
      </div>
    </section>
  );
}

function Pane({
  session,
  rect,
  dim,
  focused,
  maximised,
}: {
  session: Session;
  rect: { x: number; y: number; w: number; h: number };
  dim: boolean;
  focused: boolean;
  maximised: boolean;
}) {
  const { snap, info, error, run, launch } = useWorkbench();
  const { closePane, focus, maximise, restore } = useConversations();
  const design = useDesign(),
    minimal = design === "minimaal";
  const files = useSessionFiles(session);
  // Minimaal keeps the design's three header buttons (+ ⋯); Bestanden and Computer move into ⋯. The Computer
  // modal is opened from here (controlled), its own trigger stays hidden.
  const [computerOpen, setComputerOpen] = useState(false);
  const computer = minimal && computerSupported(info, session);
  const [full, setFull] = useState(
    () =>
      session.provider === "shell" ||
      localStorage.getItem("benchdesk-conversation-view") !== "activity",
  );
  const [linking, setLinking] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false),
    [titleDraft, setTitleDraft] = useState("");
  const cancelTitle = useRef(false);
  const waiting =
    !!session.alive &&
    (session.state === "waiting" ||
      session.state === "unknown" ||
      session.state === "starting");
  useEffect(() => {
    if (waiting) setFull(true);
  }, [waiting]);
  const alive = !!session.alive,
    agent = session.provider !== "shell",
    task = snap.tasks.find(
      (candidate) =>
        candidate.id === session.taskId &&
        candidate.companyId === session.companyId,
    ),
    title = sessionTitle(session, snap),
    status = conversationStatus(session, snap),
    context = useContextLine(session);
  const editTitle = () => {
    if (!task) return;
    cancelTitle.current = false;
    setTitleDraft(task.title);
    setEditingTitle(true);
  };
  const finishTitle = () => {
    const cancelled = cancelTitle.current;
    cancelTitle.current = false;
    setEditingTitle(false);
    if (cancelled || !task) return;
    const next = titleDraft.trim();
    if (!next) {
      error(tr("De titel mag niet leeg zijn."));
      return;
    }
    if (next === task.title) return;
    void run(() => api("task.patch", { id: task.id, patch: { title: next } }));
  };
  const resume = () =>
    launch({
      companyId: session.companyId,
      taskId: session.taskId || undefined,
      mode: session.mode,
      resume: session,
    });
  const linkable = !session.taskId && !agent;
  const items: MenuItem[] = [
    ...(minimal
      ? [
          {
            id: "files",
            label: files.open
              ? tr("Bestanden sluiten")
              : tr("Bestanden bekijken"),
            icon: <FileText size={14} />,
            hint: countText(files) || undefined,
            "data-test": "session-files-toggle",
            onSelect: () => files.setOpen(!files.open),
          },
          ...(computer
            ? [
                {
                  id: "computer",
                  label: tr("Computer"),
                  icon: <Monitor size={14} />,
                  title: tr("OpenAI Computer Use voor dit gesprek"),
                  onSelect: () => setComputerOpen(true),
                },
              ]
            : []),
        ]
      : []),
    {
      id: "view",
      label: full ? tr("Activiteit") : tr("Volledige bediening"),
      icon: full ? <List size={14} /> : <TerminalSquare size={14} />,
      onSelect: () => {
        setFull(!full);
        localStorage.setItem(
          "benchdesk-conversation-view",
          !full ? "terminal" : "activity",
        );
      },
    },
    ...(linkable
      ? [
          {
            id: "link",
            label: tr("Aan taak koppelen"),
            icon: <Link2 size={14} />,
            onSelect: () => setLinking(true),
          },
        ]
      : []),
    ...(alive
      ? [
          { type: "separator" as const },
          {
            id: "stop",
            label: tr("Stoppen"),
            icon: <Square size={13} />,
            tone: "warn" as const,
            onSelect: () =>
              void run(() => api("session.stop", { id: session.id })),
          },
        ]
      : []),
  ];
  // The assistant stopped or the conversation ended: one quiet line under the conversation, with the way on.
  const ended = !alive
    ? resumable(session)
      ? tr("Gepauzeerd — hervat om verder te gaan")
      : tr("Gesprek beëindigd")
    : agent && !session.agentRunning
      ? tr("De assistent is gestopt. Hervat het gesprek om verder te gaan.")
      : "";
  return (
    <section
      className="rz-pane"
      data-test="pro-canvas-pane"
      data-session-id={session.id}
      data-focused={focused ? "" : undefined}
      data-maximised={maximised ? "" : undefined}
      aria-label={title}
      onPointerDown={() => focus(session.id)}
      onFocusCapture={() => focus(session.id)}
      style={paneStyle(rect, maximised || minimal, dim)}
    >
      <div
        className="rz-pane__inner"
        data-test={focused ? "pro-conversation-main" : undefined}
      >
        <header className="rz-pane__head">
          <Badge
            name={context.company?.name || tr("Bedrijf")}
            tint={companyTint(session.companyId, snap)}
            title={context.company?.name}
          />
          {editingTitle && task ? (
            <input
              className="rz-pane__title rz-pane__title-input"
              data-test="session-title-input"
              aria-label={tr("Titel aanpassen")}
              value={titleDraft}
              maxLength={500}
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setTitleDraft(event.target.value)}
              onBlur={finishTitle}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  cancelTitle.current = true;
                  event.currentTarget.blur();
                }
              }}
            />
          ) : task ? (
            <button
              type="button"
              className="rz-pane__title rz-pane__title-button"
              data-test="session-title"
              aria-label={tr("Titel aanpassen: {0}", title)}
              title={tr("Klik om de titel aan te passen")}
              onClick={editTitle}
            >
              {title}
            </button>
          ) : (
            <strong className="rz-pane__title">{title}</strong>
          )}
          <span className="rz-pane__meta" title={context.full}>
            {context.meta}
          </span>
          <StatusDot
            size={12}
            tone={status.tone}
            className="rz-pane__status"
            title={
              waiting
                ? tr("Je assistent is bezig met starten of wacht op je invoer.")
                : status.label
            }
            label={<span className="rz-pane__status-text">{status.label}</span>}
          />
          <div className="rz-pane__actions">
            <MemoryButton session={session} />
            {minimal ? (
              computer && (
                <ComputerButton
                  session={session}
                  open={computerOpen}
                  onOpenChange={setComputerOpen}
                  hideTrigger
                />
              )
            ) : (
              <>
                <SessionFilesButton state={files} />
                <ComputerButton session={session} />
              </>
            )}
            <IconButton
              label={maximised ? tr("Terug naar indeling") : tr("Vergroten")}
              onClick={() => (maximised ? restore() : maximise(session.id))}
            >
              {maximised ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </IconButton>
            <Menu
              label={tr("Gespreksopties")}
              align="right"
              items={items}
              trigger={(props) => (
                <IconButton {...props} label={tr("Meer")}>
                  <Ellipsis size={15} />
                </IconButton>
              )}
            />
            <IconButton
              label={maximised ? tr("Gesprek sluiten") : tr("Paneel sluiten")}
              title={alive ? tr("Stoppen en sluiten (⌘W)") : tr("Sluiten (⌘W)")}
              aria-description={
                alive
                  ? tr("Stopt het gesprek en haalt het uit het overzicht.")
                  : undefined
              }
              onClick={() => closePane(session.id)}
            >
              <X size={14} />
            </IconButton>
          </div>
        </header>
        {linking && linkable && (
          <div className="rz-pane__link">
            <span>{tr("Aan taak koppelen")}</span>
            <Select
              aria-label={tr("Koppel gesprek aan taak")}
              defaultValue=""
              autoFocus
              onChange={(e) => {
                const taskId = e.target.value;
                if (taskId)
                  void run(async () => {
                    await api("session.link", { id: session.id, taskId });
                    setLinking(false);
                  });
              }}
            >
              <option value="">{tr("Kies een taak…")}</option>
              {snap.tasks
                .filter(
                  (t) =>
                    t.companyId === session.companyId && t.status !== "done",
                )
                .map((t) => (
                  <option value={t.id} key={t.id}>
                    {t.title}
                  </option>
                ))}
            </Select>
            <IconButton
              size="sm"
              label={tr("Koppelen sluiten")}
              onClick={() => setLinking(false)}
            >
              <X size={14} />
            </IconButton>
          </div>
        )}
        {session.error && (
          <p className="rz-pane__warning" role="alert">
            {translateMessage(session.error)}
          </p>
        )}
        {/* Files stay beside the actual conversation; opening them never unmounts it. `rz-pane__body` is the
            (unnamed) inline-size container the files panel measures itself against. */}
        <div className="rz-pane__body">
          <div className="rz-pane__stream">
            <div className="rz-pane__live" hidden={!full}>
              <Terminal id={session.id} alive={alive} onError={error} />
            </div>
            {!full && <Activity session={session} status={status} />}
            {!full && alive && (!agent || session.agentRunning) && (
              <PaneComposer session={session} />
            )}
          </div>
          {files.open && (
            <SessionFilesPanel
              key={session.id}
              session={session}
              state={files}
            />
          )}
        </div>
        {ended && (
          <div className="rz-pane__ended">
            <span>{ended}</span>
            {resumable(session) && (
              <Button variant="primary" size="sm" onClick={resume}>
                {tr("Hervatten")}
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

export function Workplace() {
  const {
    snap,
    companyId,
    selectedTask,
    workspace,
    setWorkspace,
    launch,
    sidebarOpen,
    setSidebarOpen,
    switchCompany,
    run,
  } = useWorkbench();
  // The conversation list lives in the global sidebar (F4); both sides share this hook.
  const {
    maximised,
    pendingTask,
    tree,
    placed,
    focused,
    current,
    closePane,
    split,
    launchNext,
    restore,
    place,
  } = useConversations();
  const [infoOpen, setInfoOpen] = useState(() => innerWidth >= 1280);
  const [dragging, setDragging] = useState(false);
  const [refused, setRefused] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null),
    refusal = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    const resize = () => setInfoOpen(innerWidth >= 1280);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  // README: a refused split says so for 2.2 s. The list in the sidebar refuses through the same door.
  useEffect(() => {
    canvasRoom.refuse = () => {
      setRefused(true);
      clearTimeout(refusal.current);
      refusal.current = setTimeout(() => setRefused(false), 2200);
    };
    return () => {
      canvasRoom.refuse = null;
      clearTimeout(refusal.current);
    };
  }, []);
  const task = snap.tasks.find(
    (t) => t.id === (current?.taskId || selectedTask),
  );
  // A company tab is the active company (Eén menu); "Alle" shows every company without dimming.
  const all = workspace.canvasFilter === "all";
  const selectedCompanyId = companyId;
  // README: newConversation = split(focus, "row") — through the guard, and always on the canvas.
  const newConversation = () => launchNext("row", selectedCompanyId);
  // A new conversation with an agent, as a window next to the active pane.
  const agents = (snap.agents || []).filter(
    (a) => a.companyId === selectedCompanyId && !a.archived,
  );
  const startAgent = (agentId: string) =>
    void run(async () => {
      const c = await api<AgentConversation>("chat.start", {
        agentId,
        companyId: selectedCompanyId,
        taskId: null,
        gmailAccess: "none",
      });
      if (c.sessionId)
        place({ id: c.sessionId, alive: false } as Session);
    });
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const cmd = typeof detail === "string" ? detail : detail?.command;
      const selectedCompanyId =
        typeof detail === "string" ? companyId : detail?.companyId || companyId;
      const selectedProjectId =
        typeof detail === "string" ? undefined : detail?.projectId;
      if (cmd === "right") split("row", selectedCompanyId, selectedProjectId);
      if (cmd === "down") split("col", selectedCompanyId, selectedProjectId);
      if (cmd === "new-right")
        launchNext("row", selectedCompanyId, selectedProjectId);
      if (cmd === "new-down")
        launchNext("col", selectedCompanyId, selectedProjectId);
      if (cmd === "close" && current) closePane(current.id);
    };
    window.addEventListener("benchdesk-workspace", handler);
    return () => window.removeEventListener("benchdesk-workspace", handler);
  });
  const shownTree: CanvasTree | null = maximised
    ? current
      ? { type: "leaf", id: current.id }
      : null
    : tree;
  const layout = canvasLayout(shownTree);
  const startDrag = (
    divider: (typeof layout.dividers)[number],
    e: React.PointerEvent,
  ) => {
    e.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    setDragging(true);
    // Nothing on the page gets selected while a divider moves (the sidebar is outside this component).
    const select = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    const move = (event: PointerEvent) => {
      const rel =
        divider.dir === "row"
          ? (event.clientX - rect.left) / rect.width
          : (event.clientY - rect.top) / rect.height;
      const ratio =
        (rel - (divider.dir === "row" ? divider.parent.x : divider.parent.y)) /
        (divider.dir === "row" ? divider.parent.w : divider.parent.h);
      setWorkspace((w) => ({
        ...w,
        canvas: w.canvas ? setRatio(w.canvas, divider.path, ratio) : w.canvas,
      }));
    };
    const end = () => {
      setDragging(false);
      document.body.style.userSelect = select;
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("lostpointercapture", end);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("lostpointercapture", end);
  };
  const info = maximised && infoOpen && !!task;
  return (
    <div
      className="rz-workplace"
      data-test="workplace"
      data-dragging={dragging ? "" : undefined}
    >
      <header className="rz-topbar">
        {!sidebarOpen && (
          <IconButton
            className="rz-topbar__side-toggle"
            size="lg"
            variant="side"
            label={tr("Zijbalk tonen")}
            onClick={() => setSidebarOpen(true)}
          >
            <PanelLeft size={16} />
          </IconButton>
        )}
        <Tabs
          className="rz-topbar__filter"
          semantics="buttons"
          variant="bar"
          label={tr("Bedrijfsfilter")}
          value={all ? "all" : companyId}
          onChange={(id) =>
            id === "all"
              ? setWorkspace((w) => ({ ...w, canvasFilter: "all" }))
              : switchCompany(id)
          }
          tabs={[
            { id: "all", label: tr("Alle"), count: placed.length || "" },
            ...snap.companies.map((c) => ({
              id: c.id,
              label: (
                <>
                  <Badge
                    name={c.name}
                    tint={companyTint(c.id, snap)}
                    size={18}
                  />
                  {c.name}
                </>
              ),
              count:
                snap.sessions.filter(
                  (x) => x.companyId === c.id && placed.includes(x.id),
                ).length || "",
            })),
          ]}
        />
        <div className="rz-workplace__tools">
          <button
            type="button"
            className="rz-toolbtn"
            aria-label={tr("Ernaast")}
            title={tr("Gesprek ernaast (⌘D)")}
            onClick={() => split("row", selectedCompanyId)}
          >
            <Columns2 size={16} aria-hidden="true" />
            <span className="rz-workplace__tool-label">{tr("Ernaast")}</span>
          </button>
          <button
            type="button"
            className="rz-toolbtn"
            aria-label={tr("Eronder")}
            title={tr("Gesprek eronder (⌘⇧D)")}
            onClick={() => split("col", selectedCompanyId)}
          >
            <Rows2 size={16} aria-hidden="true" />
            <span className="rz-workplace__tool-label">{tr("Eronder")}</span>
          </button>
          <Menu
            label={tr("Agent openen")}
            align="right"
            items={
              agents.length
                ? [
                    { type: "label", label: tr("Nieuw gesprek met") },
                    ...agents.map((a) => ({
                      id: a.id,
                      label: a.name,
                      icon: (
                        <span className="ob-look agent-canvas__face">
                          <Face agent={a} size="xs" />
                        </span>
                      ),
                      onSelect: () => startAgent(a.id),
                    })),
                  ]
                : [
                    {
                      id: "none",
                      label: tr("Nog geen agents voor dit bedrijf"),
                      disabled: true,
                      onSelect: () => {},
                    },
                  ]
            }
            trigger={(props) => (
              <button
                {...props}
                type="button"
                className="rz-toolbtn"
                aria-label={tr("Agent openen")}
                title={tr("Gesprek met een agent ernaast")}
              >
                <Bot size={16} aria-hidden="true" />
                <span className="rz-workplace__tool-label">{tr("Agent")}</span>
              </button>
            )}
          />
          <IconButton
            size="lg"
            label={tr("Gelijk verdelen")}
            onClick={() => restore(true)}
          >
            <Grid2X2 size={16} />
          </IconButton>
          {maximised && task && (
            <IconButton
              size="lg"
              label={tr("Taakinfo")}
              pressed={infoOpen}
              onClick={() => setInfoOpen(!infoOpen)}
            >
              <PanelRight size={16} />
            </IconButton>
          )}
          {/* "Nieuw gesprek" is the first row of the sidebar; the bar only offers it while that is hidden. */}
          {!sidebarOpen && (
            <IconButton
              size="lg"
              className="rz-workplace__new"
              label={tr("Nieuw gesprek")}
              title={tr("Nieuw gesprek (⌘T)")}
              onClick={newConversation}
            >
              <PenLine size={16} />
            </IconButton>
          )}
        </div>
      </header>
      <div
        className="rz-workplace__body"
        data-info={info ? "" : undefined}
        ref={(node) => {
          canvasRoom.box = node;
        }}
      >
        <div className="rz-canvas" ref={canvasRef}>
          {layout.panes.map(({ id, rect }) => {
            const s = snap.sessions.find((s) => s.id === id);
            const Frame = s?.transport === "chat" ? AgentPane : Pane;
            return (
              s && (
                <Frame
                  key={id}
                  session={s}
                  rect={rect}
                  focused={maximised || focused === id}
                  maximised={maximised}
                  dim={!all && s.companyId !== companyId}
                />
              )
            );
          })}
          {layout.dividers.map((d) => {
            const node = d.path.reduce<CanvasTree | null>(
              (n, k) => (n && n.type === "split" ? n[k] : null),
              shownTree,
            );
            const ratio = node?.type === "split" ? node.ratio : 0.5;
            return (
              <div
                key={d.path.join("") || "root"}
                className={cx(
                  "rz-canvas__divider",
                  `rz-canvas__divider--${d.dir}`,
                )}
                role="separator"
                tabIndex={0}
                aria-label={tr("Paneelverdeling")}
                aria-orientation={d.dir === "row" ? "vertical" : "horizontal"}
                aria-valuenow={Math.round(ratio * 100)}
                aria-valuemin={15}
                aria-valuemax={85}
                onKeyDown={(e) => {
                  if (
                    ![
                      "ArrowLeft",
                      "ArrowRight",
                      "ArrowUp",
                      "ArrowDown",
                    ].includes(e.key)
                  )
                    return;
                  e.preventDefault();
                  setWorkspace((w) => ({
                    ...w,
                    canvas: setRatio(
                      w.canvas!,
                      d.path,
                      ratio +
                        (["ArrowRight", "ArrowDown"].includes(e.key)
                          ? 0.05
                          : -0.05),
                    ),
                  }));
                }}
                onPointerDown={(e) => startDrag(d, e)}
                style={{
                  left:
                    d.dir === "row"
                      ? `calc(${d.rect.x * 100}% - 4px)`
                      : `${d.rect.x * 100}%`,
                  top:
                    d.dir === "col"
                      ? `calc(${d.rect.y * 100}% - 4px)`
                      : `${d.rect.y * 100}%`,
                  width: d.dir === "row" ? 8 : `${d.rect.w * 100}%`,
                  height: d.dir === "col" ? 8 : `${d.rect.h * 100}%`,
                }}
              >
                <i />
              </div>
            );
          })}
          {!layout.panes.length && (
            <div className="rz-canvas__empty">
              {pendingTask ? (
                <Empty
                  title={pendingTask.title}
                  action={
                    <div className="rz-canvas__empty-actions">
                      <Button
                        variant="primary"
                        size="lg"
                        iconEnd={<ArrowRight size={13} aria-hidden="true" />}
                        onClick={() =>
                          launch({
                            mode: "work",
                            companyId: pendingTask.companyId || companyId,
                            taskId: pendingTask.id,
                          })
                        }
                      >
                        {tr("Aan het werk")}
                      </Button>
                      <TextButton tone="meta" onClick={() => restore()}>
                        {tr("Terug naar indeling")}
                      </TextButton>
                    </div>
                  }
                >
                  {pendingTask.description ||
                    tr("Open een gesprek uit de lijst of begin iets nieuws.")}
                </Empty>
              ) : (
                <Empty
                  title={tr("Waar gaan we aan werken?")}
                  action={
                    <Button
                      variant="primary"
                      size="lg"
                      onClick={newConversation}
                    >
                      {tr("Nieuw gesprek")}
                    </Button>
                  }
                >
                  {tr(
                    "Kies een gesprek links of begin een nieuw gesprek. Zet er daarna meer naast of onder.",
                  )}
                </Empty>
              )}
            </div>
          )}
        </div>
        {info && task && (
          <TaskInfo task={task} close={() => setInfoOpen(false)} />
        )}
        {refused && (
          <Toast inCanvas data-test="canvas-refused">
            {tr(
              "Te weinig ruimte om te splitsen — sluit of vergroot eerst een gesprek",
            )}
          </Toast>
        )}
      </div>
    </div>
  );
}
