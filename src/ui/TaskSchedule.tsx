import { t as tr, locale, translateMessage } from "../shared/i18n";
import { useEffect, useState } from "react";
import { CalendarDays, ChevronRight, Repeat } from "lucide-react";
import {
  localDate,
  scheduleLabel,
  type Recurrence,
} from "../shared/task-schedule";
import type { Task } from "../shared/types";
import { api } from "./model";
import { formatDayMonth } from "./primitives";
import { Chip, Field, Input, Select } from "./rz";
import { DateChip } from "./TaskFields";

// variant "fields" (default; the task editor): two labelled fields and the explanation.
// variant "chips" (the wizard): two chips plus, when it matters, the explanation on its own line. The chips variant
// renders a fragment: place it inside a wrapping flex row (the wizard's chip row).
export function TaskScheduleFields({
  recurrence,
  date,
  onChange,
  variant = "fields",
}: {
  recurrence: Recurrence;
  date: string;
  onChange: (recurrence: Recurrence, date: string) => void;
  variant?: "chips" | "fields";
}) {
  const repeats = recurrence !== "none";
  const dateLabel = repeats ? tr("Startdatum") : tr("Plandatum");
  const hint =
    recurrence === "daily"
      ? tr(
          "Na afronden morgen weer open, ook in het weekend. Je afrondingen blijven bewaard.",
        )
      : recurrence === "weekly"
        ? tr(
            "Iedere week op de weekdag van de startdatum. Je afrondingen blijven bewaard.",
          )
        : tr(
            "Met een plandatum verschijnt de taak vanaf die dag bij Vandaag. Zonder datum is hij direct beschikbaar.",
          );
  const select = (
    <>
      <option value="none">{tr("Niet herhalen")}</option>
      <option value="daily">{tr("Dagelijks")}</option>
      <option value="weekly">{tr("Wekelijks")}</option>
    </>
  );
  const repeat = (value: string) => {
    const next = value as Recurrence;
    onChange(next, date || (next === "none" ? "" : localDate()));
  };
  if (variant === "chips")
    return (
      <>
        <Chip
          variant={repeats ? undefined : "dashed"}
          className="rz-task-wizard__chip"
          icon={repeats && <Repeat size={12} aria-hidden="true" />}
          chevron
          control={
            <select
              aria-label={tr("Herhalen")}
              value={recurrence}
              onChange={(e) => repeat(e.target.value)}
            >
              {select}
            </select>
          }
        >
          {recurrence === "daily"
            ? tr("Dagelijks")
            : recurrence === "weekly"
              ? tr("Wekelijks")
              : tr("Herhalen")}
        </Chip>
        <DateChip
          label={dateLabel}
          value={date}
          text={
            repeats
              ? tr("Startdatum {0}", formatDayMonth(date))
              : tr("Plandatum {0}", formatDayMonth(date))
          }
          clearLabel={repeats ? undefined : tr("Plandatum wissen")}
          required={repeats}
          onChange={(value) => onChange(recurrence, value)}
        />
        {/* Without a repeat the explanation only matters once the task is held back until a later day. */}
        {(repeats || date > localDate()) && (
          <p className="rz-hint rz-task-wizard__chiphint">{hint}</p>
        )}
      </>
    );
  return (
    <div className="rz-task-wizard-schedule">
      <div className="rz-task-wizard-schedule__grid">
        <Field label={tr("Herhalen")}>
          <Select
            aria-label={tr("Herhalen")}
            value={recurrence}
            onChange={(e) => repeat(e.target.value)}
          >
            {select}
          </Select>
        </Field>
        <Field label={dateLabel}>
          <Input
            aria-label={dateLabel}
            type="date"
            value={date}
            required={repeats}
            onChange={(e) => onChange(recurrence, e.target.value)}
          />
        </Field>
      </div>
      <p className="rz-hint">{hint}</p>
    </div>
  );
}
export function TaskScheduleInfo({ task }: { task: Task }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<
    {
      id: string;
      occurrenceDate: string;
      completedAt: string;
      summary: string;
    }[]
  >([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    let active = true;
    setError("");
    setRows([]);
    void api<typeof rows>("task.history", { id: task.id })
      .then((value) => {
        if (active) setRows(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [open, task.id, task.updatedAt]);
  const label = translateMessage(scheduleLabel(task));
  return (
    <>
      {label && (
        <p className="rz-task-wizard-schedule__label">
          {task.recurrence && task.recurrence !== "none" ? (
            <Repeat size={12} aria-hidden="true" />
          ) : (
            <CalendarDays size={12} aria-hidden="true" />
          )}
          {label}
        </p>
      )}
      <details
        className="rz-disclosure rz-task-wizard-history"
        onToggle={(e) => setOpen(e.currentTarget.open)}
      >
        <summary>
          <ChevronRight size={11} aria-hidden="true" />
          <span>{tr("Uitvoeringsgeschiedenis")}</span>
        </summary>
        {error && (
          <p className="rz-error" role="alert">
            {translateMessage(error)}
          </p>
        )}
        {!error && !rows.length && (
          <p className="rz-hint">
            {tr("Nog geen geregistreerde afrondingen.")}
          </p>
        )}
        {rows.map((row) => (
          <div
            className="rz-task-wizard-history__row"
            data-test="task-completion"
            key={row.id}
          >
            <strong>{row.occurrenceDate.split("-").reverse().join("-")}</strong>
            <div>
              <small>
                {tr("Afgerond")}{" "}
                {new Date(row.completedAt).toLocaleString(locale())}
              </small>
              {row.summary && <p>{row.summary}</p>}
            </div>
          </div>
        ))}
        {rows.length === 30 && (
          <p className="rz-hint">{tr("De laatste 30 afrondingen.")}</p>
        )}
      </details>
    </>
  );
}
