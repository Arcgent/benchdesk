export type ScheduleKind =
  | "cron"
  | "scheduled"
  | "event"
  | "service"
  | "once"
  | "unverified";
export type ScheduleStatus =
  | "enabled"
  | "paused"
  | "error"
  | "unknown"
  | "completed";
export type ScheduledJob = {
  id: string;
  sourceId: string;
  title: string;
  kind: ScheduleKind;
  status: ScheduleStatus;
  schedule: string;
  timezone: string;
  nextRunAt?: string;
  nextRunLabel?: string;
  lastRunAt?: string;
  lastResult?: string;
  origin: string;
  description: string;
  issue?: string;
  system?: boolean;
};
export type ScheduleSource = {
  id: string;
  name: string;
  location: string;
  status: "ok" | "partial" | "error" | "unsupported";
  message: string;
  count: number;
};
export type ScheduleOverview = {
  inspectedAt: string;
  timezone: string;
  jobs: ScheduledJob[];
  sources: ScheduleSource[];
};
export const scheduleStatusLabels: Record<ScheduleStatus, string> = {
  enabled: "Ingeschakeld",
  paused: "Gepauzeerd",
  error: "Aandacht nodig",
  unknown: "Niet bevestigd",
  completed: "Afgerond",
};
export const scheduleKindLabels: Record<ScheduleKind, string> = {
  unverified: "Planning niet bevestigd",
  cron: "Cronjob",
  scheduled: "Terugkerende planning",
  event: "Op gebeurtenis",
  service: "Achtergrondtaak",
  once: "Eenmalig gepland",
};
