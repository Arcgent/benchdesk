import { t as tr } from "../shared/i18n";
import { Check, X } from "lucide-react";
import { api, useWorkbench } from "./model";
import {
  assistantName,
  conversationStatus,
  duration,
  formatDate,
  formatTime,
  companyTint,
  resumable,
  sessionTitle,
} from "./primitives";
import { Badge, IconButton, StatusDot } from "./rz";
import type { Session, WorkspaceState } from "../shared/types";
import {
  canSplit,
  equalize,
  leafIds,
  leafRect,
  removeLeaf,
  restoreCanvas,
  splitLeaf,
  type CanvasTree,
} from "../shared/canvas";

// The list lives in the sidebar, the canvas in Workplace. Workplace registers the box the panes are laid out in
// and how it says "no room"; without a canvas on screen nothing is measured and nothing is refused.
export const canvasRoom: {
  box: HTMLElement | null;
  refuse: (() => void) | null;
} = { box: null, refuse: null };

// Both helpers live in primitives.tsx now (shared with the panels); re-exported so importers keep working.
export { assistantName, resumable };

// What the canvas and the list in the sidebar both need to know about the conversations, and everything that
// changes the layout. One model (D8): the split tree is the canvas; `workspaceMode: "conversation"` shows ONE
// conversation maximised ("Gesprek", with the task column). That is also where Vandaag, a project and Beoordelen
// land (App.openTask / App.openSession), so a maximised conversation is not always on the canvas yet: it joins
// the tree as soon as the layout is asked for (`base`).
export function useConversations() {
  const {
    snap,
    companyId,
    selectedTask,
    workspace,
    setWorkspace,
    run,
    launch,
  } = useWorkbench();
  const closed = new Set(workspace.closedSessionIds || []);
  const tree = restoreCanvas(
    workspace.canvas,
    new Set(snap.sessions.map((s) => s.id)),
  );
  const ids = leafIds(tree);
  // An agent chat only runs during a turn; it counts as open while it is on the canvas.
  const isOpen = (s: Session) =>
    s.transport === "chat"
      ? ids.includes(s.id)
      : !!s.alive && !closed.has(s.id);
  const focused = ids.includes(workspace.canvasFocus || "")
    ? workspace.canvasFocus!
    : ids[0];
  const single = workspace.workspaceMode !== "canvas";
  const shown = single
    ? snap.sessions.find((s) => s.id === workspace.panes[0])
    : undefined;
  // A task opened without a conversation: its own start screen, with the task column.
  const pendingTask =
    single && !shown
      ? snap.tasks.find((t) => t.id === selectedTask)
      : undefined;
  const maximised = !!shown || !!pendingTask;
  const canvas = !maximised;
  const current = maximised
    ? shown
    : snap.sessions.find((s) => s.id === focused);
  // On screen = on the canvas, plus the maximised conversation that did not come from the canvas.
  const placed = shown && !ids.includes(shown.id) ? [...ids, shown.id] : ids;

  const base = (): { tree: CanvasTree | null; focus: string | undefined } =>
    shown
      ? {
          tree: ids.includes(shown.id)
            ? tree
            : splitLeaf(tree, focused || "", shown.id),
          focus: shown.id,
        }
      : { tree, focus: focused };
  // README: no split when the active pane is under 560px wide (next to) or 360px high (below).
  const room = (
    t: CanvasTree | null,
    focus: string | undefined,
    dir: "row" | "col",
  ) => {
    const box = canvasRoom.box?.getBoundingClientRect();
    const rect =
      box && focus ? leafRect(t, focus, { w: box.width, h: box.height }) : null;
    if (!rect || canSplit(rect, dir)) return true;
    canvasRoom.refuse?.();
    return false;
  };
  const panesWithout = (w: WorkspaceState, id: string) =>
    w.panes.map((pane) => (pane === id ? null : pane)) as typeof w.panes;

  // Pane X and ⌘W (D1): stop the conversation and take it out of the overview. An agent chat only leaves
  // the canvas; the conversation stays on the Agents page.
  const closePane = (id: string) => {
    if (snap.sessions.find((s) => s.id === id)?.transport === "chat") {
      remove(id);
      return;
    }
    void run(async () => {
      if (snap.sessions.find((s) => s.id === id)?.alive)
        await api("session.stop", { id });
      setWorkspace((w) => {
        const next = removeLeaf(w.canvas, id);
        return {
          ...w,
          closedSessionIds: [...new Set([...(w.closedSessionIds || []), id])],
          panes: panesWithout(w, id),
          canvas: next,
          canvasFocus: w.canvasFocus === id ? leafIds(next)[0] : w.canvasFocus,
          // Closing the maximised conversation goes back to the layout, when there is one left.
          workspaceMode:
            w.workspaceMode !== "canvas" && w.panes[0] === id && next
              ? "canvas"
              : w.workspaceMode,
        };
      });
    });
  };
  // Open a conversation next to (or below) the active pane. Returns false when there was no room.
  const place = (s: Session, dir: "row" | "col" = "row") => {
    const { tree: t, focus } = base();
    if (!leafIds(t).includes(s.id) && !room(t, focus, dir)) return false;
    setWorkspace((w) => ({
      ...w,
      workspaceMode: "canvas",
      canvas: splitLeaf(t, focus || "", s.id, dir),
      canvasFocus: s.id,
      closedSessionIds: s.alive
        ? (w.closedSessionIds || []).filter((id) => id !== s.id)
        : w.closedSessionIds,
    }));
    return true;
  };
  // Sidebar click on a placed conversation (D1): off the canvas, the conversation keeps running.
  const remove = (id: string) => {
    const { tree: t, focus } = base();
    const next = removeLeaf(t, id);
    setWorkspace((w) => ({
      ...w,
      workspaceMode: "canvas",
      canvas: next,
      canvasFocus: focus && focus !== id ? focus : leafIds(next)[0],
      panes: panesWithout(w, id),
    }));
  };
  const toggle = (s: Session) =>
    placed.includes(s.id) ? remove(s.id) : place(s);
  // A new conversation next to (or below) the active pane: App.openSession places what the Launcher starts next
  // to `canvasFocus`, in `pendingSplitDir` — but only in canvas mode, so that is set first (a fresh install has
  // no mode yet and would otherwise open the first conversation maximised).
  const startNext = (
    t: CanvasTree | null,
    focus: string | undefined,
    dir: "row" | "col",
    nextCompanyId = companyId,
    projectId?: string,
  ) => {
    setWorkspace((w) => ({
      ...w,
      workspaceMode: "canvas",
      canvas: t,
      canvasFocus: focus,
      pendingSplitDir: dir,
    }));
    launch({
      companyId: nextCompanyId,
      projectId,
      createTask: true,
      mode: "work",
    });
  };
  // "Nieuw gesprek" (README: newConversation = split(focus, "row")), guarded like every split.
  const launchNext = (
    dir: "row" | "col" = "row",
    nextCompanyId = companyId,
    projectId?: string,
  ) => {
    const { tree: t, focus } = base();
    if (room(t, focus, dir))
      startNext(t, focus, dir, nextCompanyId, projectId);
  };
  // Ernaast / Eronder: the next open conversation for the selected company that is not on screen, else a new one.
  // The keyboard shortcut calls launchNext directly because ⌘D / ⌘⇧D explicitly starts a new conversation.
  const split = (
    dir: "row" | "col",
    nextCompanyId = companyId,
    projectId?: string,
  ) => {
    const { tree: t, focus } = base();
    if (!room(t, focus, dir)) return;
    const free = snap.sessions.find(
      (s) =>
        s.companyId === nextCompanyId &&
        !leafIds(t).includes(s.id) &&
        isOpen(s),
    );
    if (free) place(free, dir);
    else startNext(t, focus, dir, nextCompanyId, projectId);
  };
  const focus = (id: string) => {
    if (maximised || (focused === id && !single)) return;
    setWorkspace((w) => ({ ...w, workspaceMode: "canvas", canvasFocus: id }));
  };
  const maximise = (id: string) =>
    setWorkspace((w) => ({
      ...w,
      workspaceMode: "conversation",
      panes: [id, w.panes[1] === id ? null : w.panes[1]],
      focusedPane: 0,
      canvasFocus: ids.includes(id) ? id : w.canvasFocus,
    }));
  // "Terug naar indeling" and "Gelijk verdelen": the layout, with the maximised conversation in it.
  const restore = (even = false) => {
    const { tree: t, focus } = base();
    setWorkspace((w) => ({
      ...w,
      workspaceMode: "canvas",
      canvas: even ? equalize(t) : t,
      canvasFocus: focus,
    }));
  };
  return {
    canvas,
    maximised,
    pendingTask,
    isOpen,
    tree,
    ids,
    placed,
    focused,
    current,
    closePane,
    place,
    remove,
    toggle,
    split,
    launchNext,
    focus,
    maximise,
    restore,
  };
}

// Only the open conversations: no history and no filter on assistant; an old conversation is
// resumed through its task. One company = a plain list (the switcher above says which); the tab "Alle" on
// "Aan het werk" groups every company's open conversations in a fixed order.
export function ConversationList() {
  const { snap, prefs, view, companyId, workspace, setWorkspace, navigate } =
    useWorkbench();
  const { isOpen, ids, placed, toggle, place, closePane } = useConversations();
  const onCanvas = view === "workspace",
    all = onCanvas && workspace.canvasFilter === "all";
  const sessions = snap.sessions
    .filter((s) => isOpen(s) && (all || s.companyId === companyId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // Elsewhere a click opens the conversation on "Aan het werk": focused when it is on the canvas, placed otherwise.
  const open = (s: Session) => {
    if (onCanvas) toggle(s);
    else {
      if (ids.includes(s.id))
        setWorkspace((w) => ({
          ...w,
          workspaceMode: "canvas",
          canvasFocus: s.id,
        }));
      else place(s);
      navigate("workspace");
    }
  };
  // Everything the quiet row leaves out (project, assistant, account, time, the latest note) is in its tooltip.
  const hint = (s: Session, on: boolean) => {
    const project = snap.projects.find(
      (p) => p.id === snap.tasks.find((t) => t.id === s.taskId)?.projectId,
    );
    const account = prefs.accounts.find((a) => a.id === s.accountId)?.label;
    return [
      !onCanvas
        ? tr("Openen op Aan het werk")
        : on
          ? tr("Van canvas halen")
          : tr("Ernaast openen"),
      [
        project?.name,
        account
          ? `${assistantName(s.provider)} (${account})`
          : assistantName(s.provider),
        conversationStatus(s, snap).label,
        `${formatDate(s.createdAt)} ${formatTime(s.createdAt)}`,
        duration(s),
      ]
        .filter(Boolean)
        .join(" · "),
      s.memory
        ? `${s.memoryDirty ? tr("Nog bijwerken · ") : ""}${s.memory.summary}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  };
  const row = (s: Session) => {
    const on = placed.includes(s.id),
      title = sessionTitle(s, snap),
      status = conversationStatus(s, snap),
      live = status.key === "busy" || status.key === "waiting";
    // The row = the design's conversation button; the hover action is laid over the check by css.
    return (
      <div className="rz-convlist__row" key={s.id}>
        <button
          type="button"
          className="rz-convlist__item"
          data-test="pro-conversation-item"
          data-session-id={s.id}
          aria-pressed={on}
          title={hint(s, on)}
          onClick={() => open(s)}
        >
          <span className="rz-convlist__name">
            {live && <StatusDot tone={status.tone} />}
            <span className="rz-ellipsis">{title}</span>
          </span>
          <Check className="rz-convlist__check" size={14} aria-hidden="true" />
        </button>
        <IconButton
          size="xs"
          className="rz-convlist__action"
          label={tr("Gesprek sluiten: {0}", title)}
          title={
            s.transport === "chat"
              ? tr("Van canvas halen")
              : tr("Gesprek stoppen en sluiten")
          }
          onClick={() => closePane(s.id)}
        >
          <X size={13} />
        </IconButton>
      </div>
    );
  };
  const company = snap.companies.find((c) => c.id === companyId);
  return (
    <div
      className="rz-convlist"
      data-test="pro-conversation-list"
      aria-label={tr("Open gesprekken")}
    >
      {all
        ? snap.companies
            .map((c) => ({
              company: c,
              rows: sessions.filter((s) => s.companyId === c.id),
            }))
            .filter((g) => g.rows.length)
            .map(({ company, rows }) => (
              <section
                className="rz-convlist__group"
                key={company.id}
                aria-label={company.name}
              >
                <h3 className="rz-convlist__label">
                  <Badge
                    name={company.name}
                    tint={companyTint(company.id, snap)}
                    size={18}
                  />
                  <span className="rz-ellipsis">{company.name}</span>
                  <span className="rz-convlist__count" aria-hidden="true">
                    {rows.filter((s) => placed.includes(s.id)).length || ""}
                  </span>
                </h3>
                {rows.map(row)}
              </section>
            ))
        : sessions.map(row)}
      {!sessions.length && (
        <p className="rz-convlist__empty">
          {all || !company
            ? tr("Geen open gesprekken.")
            : tr("Geen open gesprekken bij {0}.", company.name)}
        </p>
      )}
    </div>
  );
}
