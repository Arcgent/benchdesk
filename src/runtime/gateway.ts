import type { Store } from "../core/store";
import type { AgentAuditRow } from "../shared/agents";
import {
  classify,
  evaluatePolicy,
  redact,
  type PolicyCall,
  type PolicyDecision,
  type PolicySource,
} from "../shared/policy";

export type GatewayCall = {
  source: PolicySource;
  tool: string;
  server?: string;
  input?: Record<string, any>;
};
type Approve = (
  sessionId: string,
  text: string,
  detail: Record<string, unknown>,
) => Promise<boolean>;
type Gate = { decision: PolicyDecision; call: PolicyCall; auditId: string };

// Single choke point for agent actions: evaluate policy, record, then act.
export class ToolGateway {
  constructor(private deps: { store: Store; approve: Approve }) {}
  private context(sessionId: string) {
    const { store } = this.deps,
      session = store.session(sessionId);
    if (!session.agentId) return null;
    const profile = store.agents.profile(session.agentId),
      conversation = session.conversationId
        ? store.agents.conversation(session.conversationId)
        : null;
    const initiator: AgentAuditRow["initiator"] = conversation?.originConversationId
      ? "handoff"
      : store.agents
            .routines(profile.id)
            .some((r) => r.lastConversationId === conversation?.id)
        ? "routine"
        : "chat";
    return { session, profile, conversation, initiator };
  }
  decide(sessionId: string, input: GatewayCall): Gate | null {
    const ctx = this.context(sessionId);
    if (!ctx) return null;
    const call = classify(input.source, input.tool, input.input, input.server);
    const decision = evaluatePolicy(ctx.profile.access.policy, call);
    const auditId = this.deps.store.agents.audit({
      agentId: ctx.profile.id,
      companyId: ctx.profile.companyId,
      sessionId,
      conversationId: ctx.conversation?.id || null,
      source: call.source,
      tool: call.tool,
      effect: call.effect,
      verdict: decision.verdict,
      effective: decision.effective,
      ruleId: decision.ruleId,
      reason: decision.reason,
      initiator: ctx.initiator,
      target: call.host || call.path || call.command || call.server || "",
      args: redact(input.input || {}),
      outcome: decision.effective === "deny" ? "denied" : "pending",
    });
    return { decision, call, auditId };
  }
  async run<T>(
    sessionId: string,
    input: GatewayCall,
    exec: () => T | Promise<T>,
  ): Promise<T> {
    const gate = this.decide(sessionId, input);
    if (!gate) return exec();
    const { store } = this.deps,
      { decision, auditId } = gate;
    if (decision.effective === "deny")
      throw new Error(`Geweigerd door het beleid van deze agent: ${decision.reason}`);
    if (decision.effective === "ask") {
      const allowed = await this.deps.approve(sessionId, input.tool, {
        tool: input.tool,
        source: input.source,
        effect: gate.call.effect,
        reason: decision.reason,
        input: redact(input.input || {}),
      });
      if (!allowed) {
        store.agents.auditOutcome(auditId, "declined");
        throw new Error("De gebruiker heeft deze actie geweigerd.");
      }
    }
    const started = Date.now();
    try {
      const result = await exec();
      store.agents.auditOutcome(auditId, "ok", started);
      return result;
    } catch (e) {
      store.agents.auditOutcome(auditId, "error", started);
      throw e;
    }
  }
  // Provider built-in tools (Claude PreToolUse, Codex approvals). An explicit
  // "allow" is passed on so the agent's settings win over the provider's own
  // prompt; undefined (no agent) defers to the provider.
  builtin(
    sessionId: string,
    tool: string,
    input: Record<string, any> = {},
  ): "deny" | "ask" | "allow" | undefined {
    // werk_task_context calls are gated and audited inside the runner.
    if (tool.startsWith("mcp__werk_task_context__"))
      return this.context(sessionId) ? "allow" : undefined;
    const plugin = /^mcp__(.+?)__(.+)$/.exec(tool);
    const gate = this.decide(
      sessionId,
      plugin
        ? { source: "plugin", server: plugin[1], tool: plugin[2], input }
        : { source: "builtin", tool, input },
    );
    if (!gate) return undefined;
    const { effective } = gate.decision;
    if (effective === "deny") return "deny";
    if (effective === "ask") return "ask";
    // The provider carries out the call; "ok" records that it passed the gate.
    this.deps.store.agents.auditOutcome(gate.auditId, "ok");
    return "allow";
  }
}
