import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCrontab,
  launchdJob,
  nextCron,
  nextAutomationRule,
} from "../src/runtime/schedule-local";
import {
  campaignJobs,
  workflowJobs,
  toolData,
  pageItems,
  remoteConnection,
} from "../src/runtime/schedule-remote";
import type { ScheduleSource } from "../src/shared/schedules";
const source: ScheduleSource = {
  id: "test-source",
  name: "Voorbeeld",
  location: "example.test",
  status: "ok",
  message: "",
  count: 0,
};
const now = new Date("2026-09-15T08:00:00Z");
test("Codex-weekregels gebruiken de lokale tijdzone; complexe regels krijgen geen gegokt tijdstip", () => {
  assert.equal(
    nextAutomationRule(
      "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0",
      "Europe/Amsterdam",
      now,
    ),
    "2026-09-21T07:00:00.000Z",
  );
  assert.equal(
    nextAutomationRule(
      "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;BYHOUR=9;BYMINUTE=0",
      "Europe/Amsterdam",
      now,
    ),
    undefined,
  );
});

test("crontab herkent planning, commentaar en ontbrekende werkmap zonder commando-geheimen te tonen", () => {
  const jobs = parseCrontab(
    [
      "# Mijn planning",
      "CRON_TZ=UTC",
      "MAILTO=test@example.test",
      "*/15 * * * * cd /werk-nonexistent-test-folder && python job.py --token PRIVATE_TEST_VALUE",
      "# 0 9 * * 1-5 python weekly.py",
      "@reboot /bin/sh startup.sh",
    ].join("\n"),
    source.id,
    "crontab -l",
    now,
  );
  assert.equal(jobs.length, 3);
  assert.equal(jobs[0].title, "job.py");
  assert.equal(jobs[0].nextRunAt, "2026-09-15T08:15:00.000Z");
  assert.equal(jobs[0].status, "error");
  assert.match(jobs[0].issue!, /werkmap/);
  assert.equal(jobs[1].status, "paused");
  assert.equal(jobs[1].nextRunAt, undefined);
  assert.equal(jobs[2].kind, "service");
  assert.equal(jobs[2].nextRunAt, undefined);
  assert.ok(!JSON.stringify(jobs).includes("PRIVATE_TEST_VALUE"));
});
test("cron houdt rekening met de wintertijd en verzint geen tijdstip voor ongeldige schema’s", () => {
  assert.equal(
    nextCron("0 9 * * *", "Europe/Amsterdam", new Date("2026-10-24T12:00:00Z"))
      .nextRunAt,
    "2026-10-25T08:00:00.000Z",
  );
  assert.ok(nextCron("70 40 * * *", "Europe/Amsterdam", now).issue);
  assert.ok(nextCron("0 9 * * *", "not-a-timezone", now).issue);
});
test("launchd kiest de eerstvolgende kalenderregel en verzint geen starttijd voor intervallen", () => {
  const job = launchdJob(
    {
      Label: "nl.test.report",
      StartCalendarInterval: [
        { Hour: 8, Minute: 30 },
        { Hour: 16, Minute: 0 },
      ],
      ProgramArguments: ["/bin/sh", "--secret", "PRIVATE_TEST_VALUE"],
    },
    source.id,
    "/test/report.plist",
    now,
  )!;
  assert.equal(job.kind, "scheduled");
  assert.ok(job.nextRunAt);
  assert.ok(!JSON.stringify(job).includes("PRIVATE_TEST_VALUE"));
  const interval = launchdJob(
    { Label: "nl.test.poll", StartInterval: 3600 },
    source.id,
    "/test/poll.plist",
    now,
  )!;
  assert.equal(interval.schedule, "Elke 1 uur");
  assert.equal(interval.nextRunAt, undefined);
  const disabled = launchdJob(
    {
      Label: "nl.test.off",
      StartCalendarInterval: { Hour: 15 },
      Disabled: true,
    },
    source.id,
    "/test/off.plist",
    now,
  )!;
  assert.equal(disabled.status, "paused");
  assert.equal(disabled.nextRunAt, undefined);
});
test("n8n leest de gepubliceerde planning en behoudt de uitgeschakelde triggerstatus", () => {
  const result = workflowJobs(
    {
      workflow: {
        id: "workflow-1",
        name: "Rapport",
        active: true,
        settings: { timezone: "UTC" },
        nodes: [
          {
            id: "draft",
            name: "Draft",
            type: "n8n-nodes-base.scheduleTrigger",
            parameters: { rule: { interval: [{ field: "hours" }] } },
          },
        ],
        activeVersion: {
          nodes: [
            {
              id: "published",
              name: "Weekstart",
              type: "n8n-nodes-base.scheduleTrigger",
              parameters: {
                rule: {
                  interval: [
                    { field: "weeks", triggerAtDay: [1], triggerAtHour: 9 },
                  ],
                },
              },
            },
            {
              id: "off",
              name: "Uit",
              type: "n8n-nodes-base.webhook",
              disabled: true,
            },
            {
              id: "manual",
              name: "Handmatig",
              type: "n8n-nodes-base.manualTrigger",
            },
          ],
        },
      },
    },
    source,
    now,
  );
  assert.equal(result.length, 2);
  assert.equal(result[0].title, "Rapport · Weekstart");
  assert.equal(result[0].nextRunAt, "2026-09-21T09:00:00.000Z");
  assert.equal(result[1].status, "paused");
});
test("n8n toont een onbekende tijdzone en geen verzonnen volgende start", () => {
  const [job] = workflowJobs(
    {
      workflow: {
        id: "one",
        name: "Dagrapport",
        active: true,
        nodes: [
          {
            name: "Iedere dag",
            type: "n8n-nodes-base.scheduleTrigger",
            parameters: {
              rule: { interval: [{ field: "days", triggerAtHour: 9 }] },
            },
          },
        ],
      },
    },
    source,
    now,
  );
  assert.equal(job.schedule, "Dagelijks om 09:00");
  assert.equal(job.nextRunAt, undefined);
  assert.equal(job.timezone, "Instelling in n8n");
});
test("Instantly onderscheidt een open verzendvenster van een toekomstige of gepauzeerde campagne", () => {
  const template = {
    id: "campaign",
    name: "Klantcampagne",
    campaign_schedule: {
      schedules: [
        {
          timing: { from: "08:30", to: "12:00" },
          days: { 1: true, 2: true, 3: true, 4: true, 5: true },
          timezone: "Europe/Amsterdam",
        },
      ],
    },
  };
  const [open] = campaignJobs([{ ...template, status: 1 }], source, now);
  assert.equal(open.nextRunLabel, "Verzendvenster nu open");
  assert.equal(open.nextRunAt, undefined);
  const [closed] = campaignJobs(
    [{ ...template, status: 1 }],
    source,
    new Date("2026-09-15T14:00:00Z"),
  );
  assert.equal(closed.nextRunAt, "2026-09-16T06:30:00.000Z");
  const [paused] = campaignJobs([{ ...template, status: 2 }], source, now);
  assert.equal(paused.nextRunAt, undefined);
});
test("een API-fout of onbekende respons wordt nooit als een lege bron gepresenteerd", () => {
  assert.throws(() =>
    toolData({
      isError: true,
      content: [{ type: "text", text: "token=PRIVATE" }],
    }),
  );
  assert.throws(() => toolData({ structuredContent: { statusCode: 401 } }));
  assert.throws(() => pageItems({ message: "permission denied" }));
  assert.deepEqual(
    pageItems(toolData({ content: [{ type: "text", text: '{"items":[]}' }] })),
    [],
  );
});
test("MCP-configuratie wordt als data gelezen; bestaande HTTP-headers blijven behouden", () => {
  const result = remoteConnection(
    "blotato",
    {
      command: "npx",
      args: [
        "mcp-remote",
        "https://mcp.example.test/mcp",
        "--header",
        "api-key: TEST_KEY",
      ],
    },
    "test.json",
  );
  assert.equal(result.url, "https://mcp.example.test/mcp");
  assert.equal(result.headers["api-key"], "TEST_KEY");
  const disabled = remoteConnection(
    "n8n",
    {
      url: "https://example.test",
      http_headers: { Authorization: "Bearer TEST" },
      enabled: false,
    },
    "config.toml",
  );
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.headers.Authorization, "Bearer TEST");
});
