import { homedir } from "node:os";
import { collectLocalSchedules } from "./schedule-local";
import { collectRemoteSchedules } from "./schedule-remote";
import type { ScheduleOverview } from "../shared/schedules";

export async function inspectSchedules(
  workspaces: string[],
  home = homedir(),
): Promise<ScheduleOverview> {
  const now = new Date();
  const overview: ScheduleOverview = {
    inspectedAt: now.toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    jobs: [],
    sources: [],
  };
  const results = await Promise.allSettled([
    collectLocalSchedules(now, home),
    collectRemoteSchedules(workspaces, now, home),
  ]);
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") {
      overview.jobs.push(...result.value.jobs);
      overview.sources.push(...result.value.sources);
    } else
      overview.sources.push({
        id: `unavailable-${index}`,
        name: index === 0 ? "Deze Mac" : "Gekoppelde diensten",
        location: "",
        status: "error",
        message: "Deze bronnen konden niet worden gecontroleerd.",
        count: 0,
      });
  }
  overview.jobs.sort(
    (a, b) =>
      (a.nextRunAt || "z").localeCompare(b.nextRunAt || "z") ||
      a.title.localeCompare(b.title),
  );
  overview.sources.sort((a, b) => a.name.localeCompare(b.name));
  return overview;
}
