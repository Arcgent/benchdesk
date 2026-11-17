import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  claudeKeychainServices,
  parseClaudeUsage,
  parseCodexUsage,
  UsageService,
} from "../src/runtime/usage";
import type { AssistantAccount } from "../src/shared/types";

const account: AssistantAccount = {
  id: "a",
  provider: "claude",
  label: "A",
  configDir: "/tmp/company-a",
  companyIds: [],
  globalDefault: false,
  status: "logged_in",
  email: "a@example.test",
  checkedAt: "",
};
test("usage preserves zero, skips absent/invalid windows, and does not fabricate resets", () => {
  const result = parseClaudeUsage({
    five_hour: { utilization: 0, resets_at: null },
    seven_day: { utilization: 38, resets_at: "2026-09-20T10:00:00Z" },
    seven_day_opus: { utilization: "0" },
    seven_day_sonnet: { utilization: -1 },
  });
  assert.equal(result.windows.length, 2);
  assert.equal(result.windows[0].usedPercent, 0);
  assert.equal(result.windows[0].resetsAt, null);
  assert.equal(result.windows[1].resetsAt, "2026-09-20T10:00:00.000Z");
  assert.deepEqual(parseClaudeUsage(null).windows, []);
});
test("Codex uses actual durations and keeps independent model buckets without duplicate legacy totals", () => {
  const w = {
    usedPercent: 62,
    windowDurationMins: 10080,
    resetsAt: 1790000000,
  };
  const result = parseCodexUsage({
    ordinaryUsageAllowed: false,
    rateLimits: { primary: w },
    rateLimitsByLimitId: {
      codex: { primary: w, secondary: null, planType: "pro" },
      spark: {
        limitName: "Spark",
        primary: { ...w, usedPercent: 0, windowDurationMins: 300 },
      },
    },
  });
  assert.equal(result.windows.length, 2);
  assert.equal(result.windows[0].label, "7 dagen");
  assert.equal(result.windows[1].label, "Spark · 5 uur");
  assert.equal(result.blocked, true);
  assert.equal(result.plan, "pro");
  assert.equal(
    parseCodexUsage({ rateLimits: { primary: w } }).windows.length,
    1,
  );
  assert.deepEqual(
    parseCodexUsage({ rateLimits: { primary: null } }).windows,
    [],
  );
});
test("company Claude credentials never fall back to the personal keychain", () => {
  const services = claudeKeychainServices(account.configDir);
  assert.equal(services.length, 1);
  assert.notEqual(services[0], "Claude Code-credentials");
  assert.notEqual(services[0], claudeKeychainServices("/tmp/company-b")[0]);
  assert.ok(
    claudeKeychainServices(join(homedir(), ".claude")).includes(
      "Claude Code-credentials",
    ),
  );
});
test("cache coalesces requests, throttles forced refresh, isolates accounts, and redacts errors", async () => {
  let calls = 0,
    now = Date.now(),
    fail = false;
  const service = new UsageService(
    async (a) => {
      calls++;
      if (fail) throw new Error("Authorization: Bearer SUPER_SECRET");
      return parseClaudeUsage({
        five_hour: { utilization: a.id === "a" ? 25 : 80 },
      });
    },
    () => now,
  );
  const [first, shared] = await Promise.all([
    service.read(account),
    service.read(account),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(first, shared);
  await service.read(account, true);
  assert.equal(calls, 1);
  const second = await service.read({
    ...account,
    id: "b",
    configDir: "/tmp/company-b",
  });
  assert.equal(second.windows[0].usedPercent, 80);
  now += 61_000;
  fail = true;
  const stale = await service.read(account, true);
  assert.equal(stale.state, "stale");
  assert.equal(stale.windows[0].usedPercent, 25);
  assert.equal(stale.updatedAt, first.updatedAt);
  assert.notEqual(stale.checkedAt, first.checkedAt);
  assert.ok(!JSON.stringify(stale).includes("SUPER_SECRET"));
  const swapped = await service.read({
    ...account,
    email: "different@example.test",
  });
  assert.equal(swapped.state, "unavailable");
  assert.deepEqual(swapped.windows, []);
  service.prune([]);
  assert.equal((await service.read(account)).state, "unavailable");
});
