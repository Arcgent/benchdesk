import { z } from "zod";
export const calendarDate = z.string().refine((value) => {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}, "Kies een geldige datum.");
export type Recurrence = "none" | "daily" | "weekly";
export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
// Calendar arithmetic is independent of the length of a DST day.
export function nextOccurrence(
  anchor: string,
  recurrence: Recurrence,
  today: string,
) {
  if (recurrence === "none") return "";
  const step = recurrence === "daily" ? 1 : 7;
  const base = Date.parse(`${anchor || today}T12:00:00Z`);
  const current = Date.parse(`${today}T12:00:00Z`);
  const days = Math.floor((current - base) / 86400000);
  const jumps = Math.max(1, Math.floor(days / step) + 1);
  return new Date(base + jumps * step * 86400000).toISOString().slice(0, 10);
}
export function availableToday(
  task: { scheduledDate?: string },
  today = localDate(),
) {
  return !task.scheduledDate || task.scheduledDate <= today;
}
export function scheduleLabel(task: {
  recurrence?: Recurrence;
  scheduledDate?: string;
  nextOccurrenceDate?: string;
  status?: string;
}) {
  const label =
    task.recurrence === "daily"
      ? "Dagelijks"
      : task.recurrence === "weekly"
        ? "Wekelijks"
        : "Gepland";
  const date =
    task.status === "done" ? task.nextOccurrenceDate : task.scheduledDate;
  if (!date && (!task.recurrence || task.recurrence === "none")) return "";
  return `${label}${date ? ` · ${task.status === "done" ? "volgende " : ""}${date.split("-").reverse().join("-")}` : ""}`;
}
