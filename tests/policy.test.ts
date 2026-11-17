import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  agentPolicy,
  classify,
  evaluatePolicy,
  newAgentPolicy,
  redact,
} from "../src/shared/policy";
import { agentProfile } from "../src/shared/agents";

const rule = (verdict: "deny" | "ask" | "allow", match: object, note = "") => ({
  id: randomUUID(),
  enabled: true,
  verdict,
  note,
  match,
});

test("deny beats ask beats allow, otherwise the effect default applies", () => {
  const policy = agentPolicy.parse({
    rules: [
      rule("allow", { tool: "Bash" }),
      rule("ask", { source: "builtin", effect: "write" }),
      rule("deny", { command: "^rm " }, "Geen rm"),
    ],
  });
  const rm = classify("builtin", "Bash", { command: "rm -rf /tmp/x" });
  assert.deepEqual(
    { ...evaluatePolicy(policy, rm), ruleId: null },
    { verdict: "deny", effective: "deny", ruleId: null, reason: "Geen rm" },
  );
  assert.equal(
    evaluatePolicy(policy, classify("builtin", "Bash", { command: "ls" })).verdict,
    "ask",
  );
  const read = evaluatePolicy(policy, classify("builtin", "Read", { file_path: "/a" }));
  assert.equal(read.verdict, "allow");
  assert.equal(read.ruleId, null);
});

test("dry run records the verdict but lets the call through", () => {
  const policy = agentPolicy.parse({
    mode: "dry_run",
    rules: [rule("deny", { tool: "handoff_*" })],
  });
  const d = evaluatePolicy(policy, classify("werk", "handoff_agent_work"));
  assert.equal(d.verdict, "deny");
  assert.equal(d.effective, "allow");
});

test("broken patterns fail closed: deny still matches, allow never does", () => {
  const deny = agentPolicy.parse({ rules: [rule("deny", { command: "(" })] });
  assert.equal(
    evaluatePolicy(deny, classify("builtin", "Bash", { command: "ls" })).verdict,
    "deny",
  );
  const allow = agentPolicy.parse({
    defaults: { write: "ask" },
    rules: [rule("allow", { command: "(" })],
  });
  assert.equal(
    evaluatePolicy(allow, classify("builtin", "Bash", { command: "ls" })).verdict,
    "ask",
  );
});

test("classification: unknown tools are writes, bookkeeping is internal, hosts and paths are extracted", () => {
  assert.equal(classify("werk", "totally_new_tool").effect, "write");
  assert.equal(classify("werk", "save_session_memory").effect, "internal");
  assert.equal(classify("werk", "get_task_context").effect, "read");
  assert.equal(classify("werk", "gmail_search").effect, "read");
  assert.equal(classify("werk", "gmail_create_draft").effect, "write");
  assert.equal(classify("plugin", "notion_search", {}, "notion").effect, "write");
  const fetch = classify("builtin", "WebFetch", { url: "https://Example.com/a" });
  assert.deepEqual([fetch.effect, fetch.host], ["read", "example.com"]);
  assert.equal(classify("builtin", "Edit", { file_path: "/x/y.ts" }).path, "/x/y.ts");
  const policy = agentPolicy.parse({
    rules: [
      rule("deny", { host: "*.evil.test" }),
      rule("deny", { path: "/secret/**" }),
    ],
  });
  assert.equal(
    evaluatePolicy(policy, classify("builtin", "WebFetch", { url: "https://a.evil.test/" })).verdict,
    "deny",
  );
  assert.equal(
    evaluatePolicy(policy, classify("builtin", "Read", { file_path: "/secret/key" })).verdict,
    "deny",
  );
  // A host rule never matches a call without a host.
  assert.equal(
    evaluatePolicy(policy, classify("builtin", "Bash", { command: "curl a.evil.test" })).verdict,
    "allow",
  );
});

test("new agents ask before writes; stored agents without a policy keep allowing", () => {
  assert.equal(newAgentPolicy().defaults.write, "ask");
  assert.equal(newAgentPolicy().defaults.read, "allow");
  const legacy = agentProfile.shape.access.parse({});
  assert.equal(legacy.policy.defaults.write, "allow");
  assert.equal(legacy.policy.mode, "enforce");
});

test("redaction hides secret keys at any depth and caps size", () => {
  const out = redact({
    q: "hi",
    auth: { access_token: "abc", nested: [{ Password: "p" }] },
    apiKey: "k",
    body: "x".repeat(10000),
  });
  assert.ok(!out.includes("abc"));
  assert.ok(!out.includes('"p"'));
  assert.ok(!out.includes('"k"'));
  assert.ok(out.includes("[verborgen]"));
  assert.ok(out.length <= 4001);
});
