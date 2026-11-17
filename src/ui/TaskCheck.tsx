import { t as tr } from "../shared/i18n";
import { availableToday } from "../shared/task-schedule";
import { useEffect, useState } from "react";
import type { Task } from "../shared/types";
import { api, useWorkbench } from "./model";
import { isBlocked } from "./primitives";
import { Check } from "./rz";

// Keep a task check responsive while the store acknowledges it (same pattern as useCriterionChecks).
// The next matching snapshot replaces the optimistic value; an error restores it and shows the message.
// Call it ONCE per page with the tasks on screen and hand the result to every <TaskCheck>, so the rows,
// "n open", the headline and todayCounts(…, checks.pending) all read the same optimistic state.
export function useTaskChecks(tasks: Task[]) {
  const { refresh, error } = useWorkbench();
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const signature = tasks.map((t) => `${t.id}:${t.status}`).join("|");
  useEffect(() => {
    setPending((current) => {
      const remaining = Object.fromEntries(
        Object.entries(current).filter(([id, done]) =>
          tasks.some((t) => t.id === id && (t.status === "done") !== done),
        ),
      );
      return Object.keys(remaining).length === Object.keys(current).length
        ? current
        : remaining;
    });
  }, [signature]);
  const isDone = (task: Task) => pending[task.id] ?? task.status === "done";
  const toggle = (task: Task) => {
    const done = !isDone(task);
    setPending((current) => ({ ...current, [task.id]: done }));
    void (
      done
        ? api("task.complete", { id: task.id, note: tr("Door jou afgerond.") })
        : api("task.patch", { id: task.id, patch: { status: "todo" } })
    )
      .then(() => refresh())
      .catch((e) => {
        setPending((current) => {
          const next = { ...current };
          delete next[task.id];
          return next;
        });
        error(e.message);
      });
  };
  return { pending, isDone, toggle };
}
export type TaskChecks = ReturnType<typeof useTaskChecks>;

// The round task check. Done = accent fill here; the row shows strike + opacity .55 via <Row done={checks.isDone(t)}>.
// Rules that stay: a running, blocked or future task cannot be checked; a task in review opens the review instead.
export function TaskCheck({
  task,
  checks,
  size,
  className,
  "data-test": test,
}: {
  task: Task;
  checks?: TaskChecks; // from the page's useTaskChecks; without it the check keeps its own optimistic state
  size?: "sm"; // 18px (Project list); default 20px (Vandaag)
  className?: string;
  "data-test"?: string;
}) {
  const { snap, openTask } = useWorkbench();
  const own = useTaskChecks([task]),
    { isDone, toggle } = checks || own;
  const done = isDone(task);
  const active = snap.sessions.some(
    (s) => s.taskId === task.id && s.alive && s.agentRunning,
  );
  return (
    <Check
      as="button"
      className={className}
      data-test={test}
      size={size}
      checked={done}
      label={`${done ? tr("Heropen") : tr("Rond af")}: ${task.title}`}
      title={
        !availableToday(task)
          ? tr("Gepland voor {0}", task.scheduledDate)
          : active
            ? tr("Dit gesprek is nog bezig")
            : task.status === "review"
              ? tr("Resultaat beoordelen")
              : done
                ? tr("Taak heropenen")
                : tr("Taak afronden")
      }
      disabled={active || isBlocked(task, snap) || !availableToday(task)}
      onClick={(event) => {
        event.stopPropagation();
        if (task.status === "review") openTask(task, true);
        else toggle(task);
      }}
    />
  );
}
