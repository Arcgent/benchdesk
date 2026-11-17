import { z } from "zod";

// Structured rules instead of an expression language: editable with form
// controls, validated by zod and evaluated identically in runner and UI.
// Field names follow OpenBot's PolicyContext so an expression rule type can
// be added later without migrating stored rules.
export const policyVerdict = z.enum(["deny", "ask", "allow"]);
export const policySource = z.enum(["werk", "builtin", "plugin", "computer"]);
export const policyEffect = z.enum(["read", "write", "internal"]);
const pattern = z.string().trim().min(1).max(500);
export const policyRule = z.object({
  id: z.string().uuid(),
  enabled: z.boolean().default(true),
  verdict: policyVerdict,
  note: z.string().trim().max(300).default(""),
  match: z
    .object({
      source: policySource.optional(),
      tool: pattern.optional(),
      server: pattern.optional(),
      effect: policyEffect.optional(),
      host: pattern.optional(),
      path: pattern.optional(),
      command: pattern.optional(),
    })
    .strict()
    .default({}),
});
export const agentPolicy = z.object({
  mode: z.enum(["enforce", "dry_run"]).default("enforce"),
  // Existing agents keep today's behaviour; new agents get write: ask.
  defaults: z
    .object({
      read: policyVerdict.default("allow"),
      write: policyVerdict.default("allow"),
      internal: policyVerdict.default("allow"),
    })
    .default({}),
  rules: z.array(policyRule).max(100).default([]),
});
export type PolicyVerdict = z.infer<typeof policyVerdict>;
export type PolicySource = z.infer<typeof policySource>;
export type PolicyEffect = z.infer<typeof policyEffect>;
export type PolicyRule = z.infer<typeof policyRule>;
export type AgentPolicy = z.infer<typeof agentPolicy>;
export const newAgentPolicy = (): AgentPolicy =>
  agentPolicy.parse({ defaults: { write: "ask" } });

export type PolicyCall = {
  source: PolicySource;
  tool: string;
  server?: string;
  effect: PolicyEffect;
  host?: string;
  path?: string;
  command?: string;
};
export type PolicyDecision = {
  verdict: PolicyVerdict;
  // What actually happens; differs from verdict only in dry_run mode.
  effective: PolicyVerdict;
  ruleId: string | null;
  reason: string;
};

// Benchdesk bookkeeping: memory, progress, proposals the user must accept.
const werkInternal = new Set([
  "save_session_memory",
  "confirm_session_memory",
  "patch_session_memory",
  "save_agent_memory",
  "save_agent_skill",
  "save_brain_changes",
  "report_progress",
  "submit_result",
  "propose_next_actions",
  "propose_priorities",
  "propose_tasks",
  "propose_company_context",
  "ask_person",
  "show_component",
]);
const werkRead =
  /^(get_|search_|read_|list_)|^(gmail_(search|read|list)|fireflies_(list|get)|pocket_(list|get)|unipile_(list|get)|github_(list|get|search)|blotato_(list|get))/;
const builtinRead = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "WebSearch",
  "WebFetch",
  "BashOutput",
]);
const builtinInternal = new Set([
  "TodoWrite",
  "Task",
  "Agent",
  "ExitPlanMode",
  "AskUserQuestion",
  "KillShell",
  "KillBash",
]);
const hostOf = (url: unknown) => {
  try {
    return typeof url === "string" ? new URL(url).hostname : undefined;
  } catch {
    return undefined;
  }
};
const text = (value: unknown) =>
  typeof value === "string" && value ? value : undefined;

export function classify(
  source: PolicySource,
  tool: string,
  input: Record<string, any> = {},
  server?: string,
): PolicyCall {
  const call: PolicyCall = { source, tool, server, effect: "write" };
  if (source === "werk") {
    if (werkInternal.has(tool)) call.effect = "internal";
    else if (werkRead.test(tool)) call.effect = "read";
  } else if (source === "builtin") {
    if (builtinRead.has(tool)) call.effect = "read";
    else if (builtinInternal.has(tool)) call.effect = "internal";
    call.host = hostOf(input.url);
    call.path = text(input.file_path) || text(input.notebook_path) || text(input.path);
    call.command = text(input.command);
  } else if (source === "computer") {
    call.host = hostOf(input.url);
  }
  // Unknown tools stay writes: the safe default.
  return call;
}

const globCache = new Map<string, RegExp>();
export function glob(value: string, flags = "i") {
  const key = flags + value;
  let re = globCache.get(key);
  if (!re) {
    re = new RegExp(
      "^" +
        value
          .split("")
          .map((c) =>
            c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
          )
          .join("") +
        "$",
      flags,
    );
    if (globCache.size > 500) globCache.clear();
    globCache.set(key, re);
  }
  return re;
}

// Throws when a pattern cannot be evaluated; the caller decides fail direction.
function matches(rule: PolicyRule, call: PolicyCall) {
  const m = rule.match;
  if (m.source && m.source !== call.source) return false;
  if (m.effect && m.effect !== call.effect) return false;
  if (m.tool && !glob(m.tool).test(call.tool)) return false;
  if (m.server && !(call.server && glob(m.server).test(call.server)))
    return false;
  if (m.host && !(call.host && glob(m.host).test(call.host))) return false;
  if (m.path && !(call.path && glob(m.path, "").test(call.path))) return false;
  if (m.command && !(call.command && new RegExp(m.command).test(call.command)))
    return false;
  return true;
}

export function evaluatePolicy(
  policy: AgentPolicy,
  call: PolicyCall,
): PolicyDecision {
  const hits: Record<PolicyVerdict, PolicyRule | undefined> = {
    deny: undefined,
    ask: undefined,
    allow: undefined,
  };
  for (const rule of policy.rules) {
    if (!rule.enabled || hits[rule.verdict]) continue;
    let hit: boolean;
    try {
      hit = matches(rule, call);
    } catch {
      // Fail closed: a broken deny rule still denies, a broken allow never allows.
      hit = rule.verdict === "deny";
    }
    if (hit) hits[rule.verdict] = rule;
  }
  const rule = hits.deny || hits.ask || hits.allow;
  const verdict = rule ? rule.verdict : policy.defaults[call.effect];
  return {
    verdict,
    effective: policy.mode === "dry_run" ? "allow" : verdict,
    ruleId: rule?.id || null,
    reason: rule
      ? rule.note || `Regel: ${rule.verdict}`
      : `Standaard voor ${call.effect}`,
  };
}

const secretKey =
  /token|secret|password|passwd|credential|cookie|authorization|api[_-]?key|private[_-]?key/i;
export function redact(value: unknown, limit = 4000): string {
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 8) return "…";
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => walk(x, depth + 1));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [
          k,
          secretKey.test(k) ? "[verborgen]" : walk(x, depth + 1),
        ]),
      );
    return typeof v === "string" && v.length > 2000
      ? v.slice(0, 2000) + "…"
      : v;
  };
  const out = JSON.stringify(walk(value, 0)) ?? "";
  return out.length > limit ? out.slice(0, limit) + "…" : out;
}
