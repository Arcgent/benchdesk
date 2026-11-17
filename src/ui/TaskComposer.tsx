import { t as tr } from "../shared/i18n";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { ArrowUp, Folder, Maximize2, Plus, X } from "lucide-react";
import type { Provider } from "../shared/types";
import { api, useWorkbench } from "./model";
import { localDay } from "./overview";
import { providerName } from "./primitives";
import { Avatar, Chip, IconButton, Menu, cx } from "./rz";
import {
  attachFilesBeforeStart,
  composerDrafts,
  type ComposerDraft,
} from "./task-composer-state";

export type TaskComposerHandle = { focus: () => void };
const remembered = (key: string) => {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
};
const remember = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {}
};
const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

// The docked "Geef een taak" bar of Vandaag and Project (decisions C12 / D5).
// Enter or the send button saves the task. With an assistant as executor the conversation starts right away with the
// default account and default context (the same `session.start` the wizard and the Launcher use, `accountId: null`
// = the runner resolves company default → personal default) and the user stays on the page. Whatever fails after
// the save keeps the saved task and says so: "De taak is opgeslagen. …".
export const TaskComposer = forwardRef<
  TaskComposerHandle,
  {
    fixedProjectId?: string; // Project page: the chip is static
    placeholder: string; // "Geef een taak" / "Geef een taak in {project}"
    selfHint: string; // hint when the executor is "Zelf": "Komt op je lijst voor vandaag" / "Komt op je lijst"
    expandLabel: string; // accessible name of the expand button: Vandaag "Nieuwe taak", Project "Uitgebreide taak"
    draftScope: string; // stable company + screen identity; prevents a draft crossing company boundaries
    scheduleToday?: boolean; // Vandaag: the task is planned for today
    onCreated?: (taskId: string, started: boolean) => void;
    className?: string;
    "data-test"?: string;
  }
>(function TaskComposer(
  {
    fixedProjectId,
    placeholder,
    selfHint,
    expandLabel,
    draftScope,
    scheduleToday = false,
    onCreated,
    className,
    "data-test": test = "task-composer",
  },
  ref,
) {
  const {
    snap,
    companyId,
    prefs,
    inventory,
    inspect,
    edit,
    refresh,
    error,
    notice,
  } = useWorkbench();
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }));
  const [composer, setComposerState] = useState<ComposerDraft>(() =>
      composerDrafts.get(draftScope),
    ),
    [busy, setBusy] = useState(false),
    [chosenProject, setChosenProject] = useState(""),
    [chosenProvider, setChosenProvider] = useState<Provider | "">("");
  const updateComposer = (update: (current: ComposerDraft) => ComposerDraft) =>
    setComposerState((current) => {
      const next = update(current);
      composerDrafts.set(draftScope, next);
      return next;
    });
  const { draft, files, pending, expanded } = composer;
  const setDraft = (value: string) =>
    updateComposer((current) => ({ ...current, draft: value }));
  const setFiles = (update: (current: string[]) => string[]) =>
    updateComposer((current) => ({
      ...current,
      files: update(current.files),
    }));
  const setExpanded = (value?: ComposerDraft["expanded"]) =>
    updateComposer((current) => ({ ...current, expanded: value }));
  const clearComposer = () => updateComposer(() => ({ draft: "", files: [] }));
  const projectKey = `benchdesk.composer.project.${companyId}`,
    providerKey = "benchdesk.composer.executor";
  const projects = snap.projects
    .filter((p) => p.companyId === companyId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const project =
    projects.find((p) => p.id === fixedProjectId) ||
    (fixedProjectId
      ? undefined
      : projects.find((p) => p.id === chosenProject) ||
        projects.find((p) => p.id === remembered(projectKey)) ||
        projects[0]);
  // An assistant whose command line tool is missing cannot start: leave it out once the inventory is known.
  useEffect(() => {
    if (!inventory) void inspect();
  }, []);
  const assistants = (["codex", "claude"] as const).filter(
    (p) => !inventory || !!inventory.providers.find((c) => c.name === p)?.path,
  );
  const executors: Provider[] = [...assistants, "shell"];
  const wanted = chosenProvider || (remembered(providerKey) as Provider);
  const selectedProvider = executors.includes(wanted) ? wanted : executors[0];
  const provider = pending?.provider || selectedProvider;
  const executorName = (p: Provider) =>
    p === "shell" ? tr("Zelf") : providerName(p);
  // The wizard opened from here saved the task: the draft has served its purpose.
  useEffect(() => {
    if (!expanded) return;
    const saved = snap.tasks.some(
      (t) =>
        t.companyId === companyId &&
        !expanded.known.includes(t.id) &&
        t.title === expanded.title,
    );
    if (!saved) return;
    if (draft.trim() === expanded.title) {
      clearComposer();
    }
    setExpanded(undefined);
  }, [snap.tasks]);
  const attach = async () => {
    try {
      const picked = await window.werk.selectFiles();
      if (picked?.length)
        setFiles((current) => [...new Set([...current, ...picked])]);
    } catch (e) {
      error((e as Error).message);
    }
  };
  const expand = () => {
    const title = draft.trim();
    if (!project) return edit("project");
    setExpanded(
      title
        ? {
            title,
            known: snap.tasks
              .filter((t) => t.companyId === companyId)
              .map((t) => t.id),
          }
        : undefined,
    );
    edit("task", {
      title,
      projectId: project.id,
      goalId: project.goalId || "",
      provider,
      ...(scheduleToday ? { scheduledDate: localDay() } : {}),
      files,
    });
  };
  const submit = async () => {
    const title = draft.trim();
    if (!title || !project || busy) return;
    setBusy(true);
    let id = pending?.id || "";
    if (!id)
      try {
        id = await api<string>("task.save", {
          value: {
            companyId,
            projectId: project.id,
            goalId: project.goalId ?? null,
            title,
            provider,
            kind: provider === "shell" ? "human" : "ai",
            ...(scheduleToday ? { scheduledDate: localDay() } : {}),
          },
        });
      } catch (e) {
        // Nothing was saved: the typed title stays where it is.
        error((e as Error).message);
        setBusy(false);
        return;
      }
    const attached = files;
    const attachment = await attachFilesBeforeStart(attached, (path) =>
      api("artifact.add", { taskId: id, path }),
    );
    if (attachment.failedFiles.length) {
      updateComposer(() => ({
        draft: title,
        files: attachment.failedFiles,
        pending: { id, title, companyId, provider },
      }));
      await refresh().catch(() => {});
      error(
        tr(
          "De taak is opgeslagen, maar niet alle bestanden zijn gekoppeld. De assistent is niet gestart. Probeer opnieuw of verwijder de mislukte bestanden om zonder deze bestanden te starten.",
        ) +
          " " +
          attachment.problems.join(" "),
      );
      onCreated?.(id, false);
      setBusy(false);
      input.current?.focus();
      return;
    }
    clearComposer();
    const problems: string[] = [];
    let started = false;
    if (provider !== "shell")
      try {
        await api<string>("session.start", {
          companyId,
          taskId: id,
          provider,
          mode: "work",
          accountId: null,
        });
        started = true;
      } catch (e) {
        problems.push((e as Error).message);
      }
    await refresh().catch(() => {});
    if (problems.length)
      error(tr("De taak is opgeslagen. ") + [...new Set(problems)].join(" "));
    else
      notice(
        started
          ? tr("{0} is begonnen aan ‘{1}’.", providerName(provider), title)
          : scheduleToday
            ? tr("Taak toegevoegd aan vandaag.")
            : tr("Taak toegevoegd."),
      );
    onCreated?.(id, started);
    setBusy(false);
    input.current?.focus();
  };
  const empty = !draft.trim();
  return (
    <form
      className={cx("rz-composer", className)}
      data-test={test}
      data-busy={busy ? "" : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <input
        ref={input}
        className="rz-composer__input"
        value={draft}
        readOnly={!!pending}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          // Enter that confirms an IME composition (Japanese, Chinese, accents on some layouts) is not a submit.
          if (
            event.key === "Enter" &&
            (event.nativeEvent.isComposing || event.keyCode === 229)
          )
            event.preventDefault();
        }}
      />
      {files.length > 0 && (
        <div className="rz-composer__files">
          {files.map((path) => (
            <span
              key={path}
              className="rz-chip rz-chip--sm rz-chip--static rz-composer__file"
              title={fileName(path)}
            >
              <span>{fileName(path)}</span>
              <IconButton
                size="xs"
                label={tr("{0} verwijderen", fileName(path))}
                onClick={() =>
                  setFiles((current) => current.filter((f) => f !== path))
                }
              >
                <X size={11} />
              </IconButton>
            </span>
          ))}
        </div>
      )}
      <div className="rz-composer__tools">
        <IconButton
          variant="round"
          label={tr("Bestand of context toevoegen")}
          disabled={busy}
          onClick={() => void attach()}
        >
          <Plus size={16} />
        </IconButton>
        {!project ? (
          <Chip
            variant="quiet"
            icon={<Folder size={15} aria-hidden="true" />}
            onClick={() => edit("project")}
          >
            {tr("Project toevoegen")}
          </Chip>
        ) : fixedProjectId ? (
          <Chip variant="quiet" icon={<Folder size={15} aria-hidden="true" />}>
            {project.name}
          </Chip>
        ) : (
          <Menu
            label={tr("Project kiezen")}
            placement="up"
            items={projects.map((p) => ({
              id: p.id,
              label: p.name,
              checked: p.id === project.id,
              onSelect: () => {
                if (pending) return;
                setChosenProject(p.id);
                remember(projectKey, p.id);
              },
            }))}
            footer={{
              label: tr("Nieuw project"),
              icon: <Plus size={13} aria-hidden="true" />,
              onSelect: () => edit("project"),
            }}
            trigger={(props) => (
              <Chip
                {...props}
                disabled={!!pending}
                variant="quiet"
                chevron
                icon={<Folder size={15} aria-hidden="true" />}
                aria-label={tr("Project kiezen: {0}", project.name)}
              >
                {project.name}
              </Chip>
            )}
          />
        )}
        <Menu
          label={tr("Uitvoerder kiezen")}
          placement="up"
          items={executors.map((p) => ({
            id: p,
            label: executorName(p),
            icon: (
              <Avatar
                size={18}
                provider={p === "shell" ? "human" : p}
                name={prefs.profile.name || tr("Jij")}
              />
            ),
            checked: p === provider,
            onSelect: () => {
              if (pending) return;
              setChosenProvider(p);
              remember(providerKey, p);
            },
          }))}
          trigger={(props) => (
            <Chip
              {...props}
              disabled={!!pending}
              variant="quiet"
              chevron
              icon={
                <Avatar
                  size={18}
                  provider={provider === "shell" ? "human" : provider}
                  name={prefs.profile.name || tr("Jij")}
                />
              }
              aria-label={tr("Uitvoerder kiezen: {0}", executorName(provider))}
            >
              {executorName(provider)}
            </Chip>
          )}
        />
        <span className="rz-composer__grow" />
        <span className="rz-composer__hint">
          {pending
            ? files.length
              ? tr("Bestanden opnieuw koppelen om te starten")
              : tr("Opnieuw proberen om te starten")
            : provider === "shell"
              ? selfHint
              : tr("{0} begint direct", providerName(provider))}
        </span>
        <IconButton
          variant="round"
          label={expandLabel}
          title={tr("Uitgebreide taak: opdracht, criteria en uitvoerder")}
          disabled={busy || !!pending}
          onClick={expand}
        >
          <Maximize2 size={15} />
        </IconButton>
        <button
          type="submit"
          className="rz-send"
          aria-label={pending ? tr("Opnieuw proberen") : tr("Taak toevoegen")}
          title={pending ? tr("Opnieuw proberen") : tr("Taak toevoegen")}
          disabled={empty || busy || !project}
        >
          <ArrowUp size={16} />
        </button>
      </div>
    </form>
  );
});
