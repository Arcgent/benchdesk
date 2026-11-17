# Cron jobs and recurring work

**Recurring** brings together the schedules on your Mac and in the services you already connected. The overview covers your whole workspace, across companies. You see what comes back automatically, where it was set up and where information or a fix is needed.

It is read-only. Running, scheduling and access settings stay with the original service. A planned start does not prove that a run succeeded.

## What you see

- Task name and origin.
- Fixed schedule, one-time moment, background task or event.
- Enabled, paused, completed, error or unconfirmed status.
- A next moment, when the schedule and time zone allow it.
- The last known process status, if the source provides one.
- Search, source and type filters, plus a separate filter for items that need attention.

Click a row for details. **Your sources** shows coverage and any access problems. Built-in macOS tasks are hidden by default and can be shown with the toggle; the total at the top does count them.

## Sources

| Source | What is read | Limit |
| --- | --- | --- |
| Crontab | Current user; readable `/etc/crontab` and `/etc/cron.d` | Other users and root may need separate permissions. |
| macOS / launchd | Local LaunchAgents/LaunchDaemons and scheduled Apple system tasks | An interval gives no exact next time without an earlier start. Ordinary system services without a schedule are left out. |
| Codex | Local `automations/*/automation.toml` | Complex repeat rules stay visible without a computed time. Run history lives in Codex. |
| Claude | Local `scheduled-tasks` folders | The folder does not confirm that a task is currently enabled. Cloud routines and session-bound `/loop` tasks cannot be read from this folder. |
| Instantly | All pages of campaigns and agents/automations | A sending window does not confirm that mail is being sent at that moment. |
| Blotato | All pages of scheduled posts and DM automations | Execution stays with Blotato. |
| n8n | Workflow list and accessible trigger details; published version where available | Workflows without MCP access are listed as unconfirmed. The instance time zone is never guessed. A list limit is shown. |
| Hostinger | Hosting websites, agency websites and their cron jobs | Cron jobs inside VPS servers are not available through this hosting API. |
| Other MCP connections | Presence and enabled state in the configuration | Listed explicitly as not supported yet; zero found is not proof of zero existing tasks. |

Remote sources are read through the MCP connections you already have in your Claude or Codex configuration. The macOS calendar and interval settings follow the [Apple documentation for scheduled jobs](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/ScheduledJobs.html). The Claude schedule types are described in [Claude Desktop tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks) and [session-bound schedules](https://code.claude.com/docs/en/scheduled-tasks).

## Refresh and storage

Opening the page shows the last snapshot. A snapshot older than five minutes refreshes automatically. **Refresh overview** checks every source again. The time of the last check is shown above the list.

The cache sits next to the Benchdesk database in `schedule-overview.json` and holds only what the overview needs. Access tokens, full shell commands and workflow contents are not stored in it. The overview has no buttons that run cron jobs, send messages or change schedules and permissions.

## Checks

`npm test` covers the parsers and date logic. After a build, `npm run test:schedules` checks the interface with an isolated sample cache, without calling external services. `WERK_TEST_EXECUTABLE` can point to the packaged Mac app.
