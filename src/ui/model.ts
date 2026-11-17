import { t as tr, translateMessage } from "../shared/i18n";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type {
  Company,
  Inventory,
  Mode,
  Preferences,
  Session,
  Snapshot,
  Task,
  WorkspaceState,
  Proposal,
} from "../shared/types";
import type { EditorKind } from "./Editor";
export type LauncherRequest = {
  agentId?: string | null;
  brainIntent?: "update" | "question";
  brainPageId?: string;
  mode: Mode;
  companyId: string;
  taskId?: string;
  projectId?: string;
  createTask?: boolean;
  resume?: Session;
  pane?: 0 | 1;
  provider?: "claude" | "codex" | "shell";
};
export type AppInfo = {
  dataDir: string;
  defaultWorkspace: string;
  homeDir: string;
  version: string;
  platform: string;
  browser?: boolean;
  preview?: boolean;
};
export interface Workbench {
  snap: Snapshot;
  company?: Company;
  companyId: string;
  view: string;
  selectedTask: string | null;
  prefs: Preferences;
  info: AppInfo;
  inventory: Inventory | null;
  inspecting: boolean;
  workspace: WorkspaceState;
  setWorkspace: Dispatch<SetStateAction<WorkspaceState>>;
  // Shell state shared by the sidebar, the canvas top bar and the conversation list.
  sidebarOpen: boolean;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  navigate: (view: string) => void;
  switchCompany: (id: string, next?: string) => void;
  edit: (kind: EditorKind, value?: any) => void;
  newTask: () => void;
  launch: (request: LauncherRequest) => void;
  openTask: (task: Task, review?: boolean) => void;
  openSession: (session: Session, pane?: 0 | 1) => void;
  showFile: (path: string) => void;
  showProposal: (proposal: Proposal) => void;
  run: <T>(fn: () => Promise<T>, success?: string) => Promise<T | undefined>;
  refresh: () => Promise<void>;
  refreshPreferences: () => Promise<void>;
  inspect: () => Promise<void>;
  error: (message: string) => void;
  notice: (message: string) => void;
  shortcuts: () => void;
  addAccount: (provider?: "claude" | "codex") => void;
}
export const WorkbenchContext = createContext<Workbench | null>(null);
export function useWorkbench() {
  const value = useContext(WorkbenchContext);
  if (!value) throw new Error(tr("Werkcontext ontbreekt."));
  return value;
}
export const api = <T = any>(method: string, params?: any) =>
  window.werk.call<T>(method, params).catch((error) => {
    throw new Error(
      translateMessage(
        String(error.message || error).replace(
          /^Error invoking remote method '[^']+': Error: /,
          "",
        ),
      ),
    );
  });

// Keep a checkbox responsive while SQLite acknowledges the human's choice.
// The next matching snapshot replaces the optimistic value; errors restore it.
export function useCriterionChecks(task: Task) {
  const { refresh, error } = useWorkbench();
  const [pending, setPending] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setPending((current) => {
      const remaining = Object.fromEntries(
        Object.entries(current).filter(([id, checked]) =>
          task.criteria.some((c) => c.id === id && c.checked !== checked),
        ),
      );
      return Object.keys(remaining).length === Object.keys(current).length
        ? current
        : remaining;
    });
  }, [task.criteria]);
  const check = (id: string, checked: boolean) => {
    setPending((current) => ({ ...current, [id]: checked }));
    void api("task.criterion", {
      id: task.id,
      criterionId: id,
      patch: { checked },
    })
      .then(() => refresh())
      .catch((e) => {
        setPending((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
        error(e.message);
      });
  };
  return {
    criteria: task.criteria.map((c) => ({
      ...c,
      checked: pending[c.id] ?? c.checked,
    })),
    check,
  };
}
