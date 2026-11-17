// Field pieces of the "Uitgebreide taak" wizard (css: rustig/task-wizard.css). Only TaskWizard and TaskSchedule import this.
import { t as tr } from "../shared/i18n";
import { useState } from "react";
import { ChevronRight, Paperclip, X } from "lucide-react";
import type { Task } from "../shared/types";
import { Check, Chip, IconButton, Input, Row, cx } from "./rz";

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

// A dashed chip that turns solid once it holds a date. The native date input lies over the chip at opacity 0, so
// its label, keyboard behaviour and Playwright fill() keep working. The clear button sits outside the <label>.
export function DateChip({
  label,
  value,
  text,
  clearLabel,
  late,
  required,
  disabled,
  onChange,
}: {
  label: string; // accessible name of the input, and the text of the empty chip
  value: string;
  text: string; // text of the filled chip
  clearLabel?: string; // without it the date cannot be cleared (a recurring task needs its start date)
  late?: boolean;
  required?: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const clearable = !!value && !!clearLabel && !disabled;
  const open = (input: HTMLInputElement) => {
    try {
      input.showPicker?.();
    } catch {}
  };
  return (
    <span className="rz-task-wizard__chipwrap">
      <Chip
        variant={value ? undefined : "dashed"}
        className={cx(
          "rz-task-wizard__chip",
          clearable && "rz-task-wizard__chip--clearable",
          late && "rz-task-wizard__chip--late",
        )}
        control={
          <input
            type="date"
            aria-label={label}
            value={value}
            required={required}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            onClick={(e) => open(e.currentTarget)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              open(e.currentTarget);
            }}
          />
        }
      >
        {value ? text : label}
      </Chip>
      {clearable && (
        <IconButton
          size="xs"
          className="rz-task-wizard__chipclear"
          label={clearLabel}
          onClick={() => onChange("")}
        >
          <X size={11} />
        </IconButton>
      )}
    </span>
  );
}

// "Klaar als": editable criterion rows (15px square, borderless text, remove on hover) and the add row.
export function CriteriaFields({
  criteria,
  draft,
  onChange,
  onDraft,
}: {
  criteria: string[];
  draft: string;
  onChange: (criteria: string[]) => void;
  onDraft: (draft: string) => void;
}) {
  const add = () => {
    if (!draft.trim()) return;
    onChange([...criteria, draft.trim()]);
    onDraft("");
  };
  return (
    <div className="rz-task-wizard__criteria">
      <div className="rz-task-wizard__sechead">
        <span>{tr("Klaar als")}</span>
        <span>
          {criteria.length}{" "}
          {criteria.length === 1 ? tr("criterium") : tr("criteria")}
        </span>
      </div>
      {criteria.map((text, i) => (
        <Row
          as="div"
          size="xs"
          cols="18px minmax(0, 1fr) auto"
          quiet
          className="rz-task-wizard__criterion"
          key={i}
        >
          <span className="rz-task-wizard__box" aria-hidden="true" />
          <Input
            bare
            aria-label={tr("Criterium {0}", i + 1)}
            value={text}
            onChange={(e) =>
              onChange(criteria.map((c, j) => (j === i ? e.target.value : c)))
            }
          />
          <IconButton
            size="xs"
            className="rz-task-wizard__remove"
            label={tr("Criterium {0} verwijderen", i + 1)}
            onClick={() => onChange(criteria.filter((_, j) => j !== i))}
          >
            <X size={11} />
          </IconButton>
        </Row>
      ))}
      <div className="rz-task-wizard__addrow">
        <span
          className="rz-task-wizard__box rz-task-wizard__box--dashed"
          aria-hidden="true"
        />
        <Input
          bare
          aria-label={tr("Criterium toevoegen")}
          placeholder={tr("Criterium toevoegen en Enter")}
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (!e.nativeEvent.isComposing && e.keyCode !== 229) add();
          }}
          onBlur={add}
        />
      </div>
    </div>
  );
}

// "Wacht op andere taken": a quiet disclosure, closed unless something is already chosen.
export function DependencyFields({
  tasks,
  value,
  onChange,
}: {
  tasks: Task[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(value.length > 0);
  if (!tasks.length) return null;
  const chosen = tasks.filter((t) => value.includes(t.id)).length;
  const toggle = (id: string, on: boolean) =>
    onChange(on ? [...value, id] : value.filter((v) => v !== id));
  return (
    <details
      className="rz-disclosure rz-task-wizard__more"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        <ChevronRight size={11} aria-hidden="true" />
        <span>{tr("Wacht op andere taken")}</span>
        {chosen > 0 && (
          <span className="rz-task-wizard__count rz-num">{chosen}</span>
        )}
      </summary>
      {/* Only while open: closed, the task titles would sit in the page a second time. */}
      {open && (
        <div className="rz-task-wizard__deps">
          {tasks.map((t) => (
            <Row
              as="div"
              size="xs"
              cols="18px minmax(0, 1fr)"
              key={t.id}
              data-dependency-id={t.id}
              onClick={() => toggle(t.id, !value.includes(t.id))}
            >
              <Check
                size="xs"
                className="rz-task-wizard__depcheck"
                checked={value.includes(t.id)}
                label={t.title}
                onChange={(on) => toggle(t.id, on)}
                onClick={(e) => e.stopPropagation()}
              />
              <span className="rz-ellipsis" aria-hidden="true">
                {t.title}
              </span>
            </Row>
          ))}
        </div>
      )}
    </details>
  );
}

// Files picked in the composer: linked to the task after the save.
export function FileChips({
  files,
  disabled,
  onRemove,
}: {
  files: string[];
  disabled?: boolean;
  onRemove: (path: string) => void;
}) {
  if (!files.length) return null;
  return (
    <div
      className="rz-task-wizard__files"
      role="group"
      aria-label={tr("Bijlagen")}
      data-test="task-wizard-files"
    >
      {files.map((path) => (
        <span
          key={path}
          className="rz-chip rz-chip--sm rz-chip--static rz-task-wizard__file"
          title={fileName(path)}
        >
          <Paperclip size={12} aria-hidden="true" />
          <span>{fileName(path)}</span>
          <IconButton
            size="xs"
            label={tr("{0} verwijderen", fileName(path))}
            disabled={disabled}
            onClick={() => onRemove(path)}
          >
            <X size={11} />
          </IconButton>
        </span>
      ))}
    </div>
  );
}
