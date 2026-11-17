import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { toml } from "./adapters";
import { findCuaInstallation, withCuaArgs } from "./cua-repl";
import type { ChatUpdate } from "../shared/agents";

export type ChatReply = { allow?: boolean; answers?: Record<string, string> };
export type DriverOptions = {
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  runtimeDir: string;
  resumeId: string | null;
  prompt: string;
  instruction: string;
  turnId: string;
  emit: (item: ChatUpdate) => void;
  thread: (id: string) => void;
  signal: AbortSignal;
  places?: string[];
  // Agent policy for provider built-in tools; undefined defers to the provider.
  policy?: (
    tool: string,
    input: Record<string, any>,
  ) => "deny" | "ask" | "allow" | undefined;
};
// Gateway approvals can hold a werk tool call while the user decides.
const toolTimeoutSeconds = 900;
export interface ChatDriver {
  run(options: DriverOptions): Promise<void>;
  respond(id: string, response: ChatReply): void;
}
const cleanError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const printable = (value: unknown) =>
  (typeof value === "string"
    ? value
    : JSON.stringify(value, null, 2) || ""
  ).slice(0, 60000);
const mcp = (o: DriverOptions) => ({
  command: process.execPath,
  args: [join(o.runtimeDir, "mcp.cjs")],
  env: {
    ELECTRON_RUN_AS_NODE: "1",
    WERK_SOCKET: o.env.WERK_SOCKET!,
    WERK_SESSION_ID: o.env.WERK_SESSION_ID!,
    WERK_SESSION_TOKEN: o.env.WERK_SESSION_TOKEN!,
  },
});

export class CodexChatDriver implements ChatDriver {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private approvals = new Map<
    string,
    { id: string | number; method: string; params: any }
  >();
  private next = 1;
  private write(value: unknown) {
    this.child?.stdin.write(JSON.stringify(value) + "\n");
  }
  private request(method: string, params: unknown) {
    return new Promise<any>((resolve, reject) => {
      const id = this.next++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex reageert niet op de aanvraag."));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  respond(id: string, response: ChatReply) {
    const p = this.approvals.get(id);
    if (!p) throw new Error("Deze vraag is niet meer actief.");
    let result: unknown;
    if (p.method === "mcpServer/elicitation/request") {
      const accepted =
        response.allow !== false &&
        (response.allow === true || !!response.answers);
      const content: Record<string, unknown> = {};
      if (accepted && p.params.mode !== "url") {
        for (const [key, field] of Object.entries(
          p.params.requestedSchema?.properties || {},
        ) as [string, any][]) {
          const raw = response.answers?.[key];
          if (
            !raw?.trim() &&
            !p.params.requestedSchema?.required?.includes(key)
          )
            continue;
          if (raw === undefined)
            throw new Error("Beantwoord eerst alle vragen.");
          if (field.type === "boolean") {
            if (!["true", "false"].includes(raw))
              throw new Error("Kies true of false.");
            content[key] = raw === "true";
          } else if (["number", "integer"].includes(field.type)) {
            const n = Number(raw);
            if (
              !raw.trim() ||
              !Number.isFinite(n) ||
              (field.type === "integer" && !Number.isInteger(n))
            )
              throw new Error("Vul een geldig getal in.");
            content[key] = n;
          } else if (field.type === "array" || field.type === "object") {
            content[key] = JSON.parse(raw);
          } else content[key] = raw;
        }
      }
      result = {
        action: accepted ? "accept" : "decline",
        content: accepted && p.params.mode !== "url" ? content : null,
        _meta: null,
      };
    } else if (p.method === "item/tool/requestUserInput") {
      const answers = Object.fromEntries(
        (p.params.questions || []).map((q: any) => [
          q.id,
          { answers: [response.answers?.[q.id] || ""] },
        ]),
      );
      result = { answers };
    } else if (p.method === "item/permissions/requestApproval") {
      result = {
        permissions: response.allow ? p.params.permissions : {},
        scope: "turn",
      };
    } else result = { decision: response.allow ? "accept" : "decline" };
    this.write({ id: p.id, result });
    this.approvals.delete(id);
  }
  async run(o: DriverOptions) {
    const config = {
      ...mcp(o),
      env: { ELECTRON_RUN_AS_NODE: "1" },
      env_vars: ["WERK_SOCKET", "WERK_SESSION_ID", "WERK_SESSION_TOKEN"],
      tool_timeout_sec: toolTimeoutSeconds,
    };
    const args = withCuaArgs(
      ["-c", `mcp_servers.werk_task_context=${toml(config)}`, "app-server"],
      findCuaInstallation(o.env.CODEX_HOME),
    );
    const child = (this.child = spawn(o.executable, args, {
      cwd: o.cwd,
      env: o.env,
      stdio: "pipe",
    }));
    const text = new Map<string, string>();
    let buffer = "",
      finished = false,
      stderr = "",
      resolveDone!: () => void,
      rejectDone!: (e: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    // Initialization can fail before the code reaches await done.
    void done.catch(() => {});
    const fail = (error: unknown) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(cleanError(error)));
      }
      this.pending.clear();
      if (!finished) {
        finished = true;
        rejectDone(new Error(cleanError(error)));
      }
    };
    const abort = () => {
      fail(new Error("Gesprek onderbroken."));
      child.kill("SIGTERM");
    };
    o.signal.addEventListener("abort", abort, { once: true });
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stderr.on("data", (b) => {
      stderr = (stderr + b).slice(-4000);
    });
    child.on("exit", (code) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("Codex is gestopt."));
      }
      this.pending.clear();
      if (!finished)
        fail(new Error(`Codex is gestopt (${code ?? "signaal"}). ${stderr}`));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 8_000_000) {
        fail(new Error("Codex stuurde een te groot bericht."));
        child.kill();
        return;
      }
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line),
            p = msg.params || {};
          if (msg.id !== undefined && !msg.method) {
            const waiting = this.pending.get(msg.id);
            if (waiting) {
              this.pending.delete(msg.id);
              clearTimeout(waiting.timer);
              msg.error
                ? waiting.reject(new Error(msg.error.message))
                : waiting.resolve(msg.result);
            }
            continue;
          }
          if (msg.id !== undefined && msg.method) {
            const id = `request:${msg.id}`;
            if (
              msg.method === "mcpServer/elicitation/request" &&
              p.mode !== "url"
            ) {
              this.approvals.set(id, {
                id: msg.id,
                method: msg.method,
                params: p,
              });
              const questions = Object.entries(
                p.requestedSchema?.properties || {},
              ).map(([key, field]: [string, any]) => ({
                id: key,
                question: field.title || field.description || key,
                required: p.requestedSchema?.required?.includes(key) ?? false,
                options: (
                  field.enum ||
                  (field.oneOf || field.anyOf || [])
                    .map((option: any) => option.const)
                    .filter((v: unknown) => v !== undefined) ||
                  []
                ).map((label: unknown) => ({ label: String(label) })),
              }));
              o.emit({
                id,
                turnId: o.turnId,
                kind: questions.length ? "question" : "approval",
                text: p.message || p.serverName,
                status: "pending",
                detail: { ...p, questions, canDecline: true },
              });
              continue;
            }
            if (
              ![
                "item/commandExecution/requestApproval",
                "item/fileChange/requestApproval",
                "item/permissions/requestApproval",
                "item/tool/requestUserInput",
                "mcpServer/elicitation/request",
              ].includes(msg.method)
            ) {
              this.write({
                id: msg.id,
                error: {
                  code: -32601,
                  message: "This request is not supported by Benchdesk.",
                },
              });
              o.emit({
                id,
                turnId: o.turnId,
                kind: "error",
                text: `Niet ondersteunde Codex-vraag: ${msg.method}`,
                status: "error",
              });
              continue;
            }
            // Codex only asks for actions outside its sandbox; deny rules
            // decline those without bothering the user.
            const gated =
              msg.method === "item/commandExecution/requestApproval"
                ? o.policy?.("Bash", { command: p.command })
                : msg.method === "item/fileChange/requestApproval"
                  ? o.policy?.("Edit", { file_path: p.grantRoot || p.path })
                  : undefined;
            if (gated === "deny") {
              this.write({ id: msg.id, result: { decision: "decline" } });
              o.emit({
                id,
                turnId: o.turnId,
                kind: "notice",
                text: `Geweigerd door het beleid van deze agent: ${p.command || p.reason || msg.method}`,
                status: "complete",
              });
              continue;
            }
            this.approvals.set(id, {
              id: msg.id,
              method: msg.method,
              params: p,
            });
            o.emit({
              id,
              turnId: o.turnId,
              kind:
                msg.method === "item/tool/requestUserInput"
                  ? "question"
                  : "approval",
              text: p.command || p.reason || p.message || msg.method,
              status: "pending",
              detail: p,
            });
          } else if (msg.method === "item/agentMessage/delta") {
            const id = String(p.itemId);
            text.set(id, (text.get(id) || "") + p.delta);
            o.emit({
              id,
              turnId: o.turnId,
              kind: "assistant",
              text: text.get(id)!,
              status: "running",
            });
          } else if (["item/started", "item/completed"].includes(msg.method)) {
            const item = p.item,
              complete = msg.method === "item/completed";
            if (item?.type === "agentMessage") {
              const value = item.text || text.get(item.id) || "";
              text.set(item.id, value);
              o.emit({
                id: item.id,
                turnId: o.turnId,
                kind: "assistant",
                text: value,
                status: complete ? "complete" : "running",
              });
            } else if (
              item &&
              [
                "commandExecution",
                "fileChange",
                "mcpToolCall",
                "webSearch",
                "dynamicToolCall",
              ].includes(item.type)
            ) {
              o.emit({
                id: item.id,
                turnId: o.turnId,
                kind: "tool",
                text: item.command || item.tool || item.query || item.type,
                status:
                  item.status === "failed"
                    ? "error"
                    : complete
                      ? "complete"
                      : "running",
                detail: {
                  output: printable(
                    item.aggregatedOutput ||
                      item.result ||
                      item.error ||
                      item.changes ||
                      "",
                  ),
                },
              });
            }
          } else if (msg.method === "serverRequest/resolved") {
            const id = `request:${p.requestId}`;
            if (this.approvals.has(id)) {
              this.approvals.delete(id);
              o.emit({
                id,
                turnId: o.turnId,
                kind: "notice",
                text: "Vraag afgehandeld.",
                status: "complete",
              });
            }
          } else if (msg.method === "turn/completed") {
            if (p.turn?.status === "failed")
              fail(
                new Error(
                  p.turn?.error?.message ||
                    "Codex kon de opdracht niet afronden.",
                ),
              );
            else if (p.turn?.status === "interrupted")
              fail(new Error("Gesprek onderbroken."));
            else {
              finished = true;
              resolveDone();
            }
          } else if (msg.method === "error" && !p.willRetry)
            fail(new Error(p.error?.message || p.message || "Codex-fout."));
        } catch (e) {
          fail(e);
        }
      }
    });
    try {
      if (o.signal.aborted) {
        abort();
        throw new Error("Gesprek onderbroken.");
      }
      await this.request("initialize", {
        clientInfo: { name: "benchdesk", version: "0.9.0" },
        capabilities: {},
      });
      this.write({ method: "initialized" });
      const thread = await this.request(
        o.resumeId ? "thread/resume" : "thread/start",
        {
          ...(o.resumeId ? { threadId: o.resumeId } : {}),
          cwd: o.cwd,
          developerInstructions: o.instruction,
          ...(o.places?.length
            ? {
                config: {
                  sandbox_workspace_write: { writable_roots: o.places },
                },
              }
            : {}),
        },
      );
      o.thread(thread.thread.id);
      await this.request("turn/start", {
        threadId: thread.thread.id,
        input: [{ type: "text", text: o.prompt }],
      });
      await done;
    } finally {
      finished = true;
      o.signal.removeEventListener("abort", abort);
      this.approvals.clear();
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("Gesprek gesloten."));
      }
      this.pending.clear();
      child.stdin.end();
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 2000);
      timer.unref();
    }
  }
}

export class ClaudeChatDriver implements ChatDriver {
  private approvals = new Map<string, (reply: ChatReply) => void>();
  respond(id: string, response: ChatReply) {
    const resolve = this.approvals.get(id);
    if (!resolve) throw new Error("Deze vraag is niet meer actief.");
    this.approvals.delete(id);
    resolve(response);
  }
  async run(o: DriverOptions) {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
      for (const resolve of this.approvals.values()) resolve({ allow: false });
      this.approvals.clear();
    };
    o.signal.addEventListener("abort", abort, { once: true });
    if (o.signal.aborted) abort();
    const stream = query({
      prompt: o.prompt,
      options: {
        pathToClaudeCodeExecutable: o.executable,
        cwd: o.cwd,
        additionalDirectories: o.places || [],
        env: { MCP_TOOL_TIMEOUT: String(toolTimeoutSeconds * 1000), ...o.env },
        ...(o.resumeId ? { resume: o.resumeId } : {}),
        abortController: controller,
        includePartialMessages: true,
        settingSources: ["user", "project", "local"],
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: o.instruction,
        },
        mcpServers: { werk_task_context: mcp(o) },
        // canUseTool only fires when Claude's own settings would prompt, so
        // agent policy is enforced here for every tool call.
        ...(o.policy
          ? {
              hooks: {
                PreToolUse: [
                  {
                    hooks: [
                      async (input: any) => {
                        const verdict = o.policy!(
                          String(input.tool_name),
                          input.tool_input || {},
                        );
                        return verdict
                          ? {
                              hookSpecificOutput: {
                                hookEventName: "PreToolUse" as const,
                                permissionDecision: verdict,
                                permissionDecisionReason:
                                  verdict === "deny"
                                    ? "Geweigerd door het beleid van deze agent."
                                    : verdict === "ask"
                                      ? "Het beleid van deze agent vraagt goedkeuring."
                                      : "Toegestaan door het beleid van deze agent.",
                              },
                            }
                          : {};
                      },
                    ],
                  },
                ],
              },
            }
          : {}),
        canUseTool: async (toolName, input, options) => {
          const id = `request:${randomUUID()}`;
          const response = await new Promise<ChatReply>((resolve) => {
            this.approvals.set(id, resolve);
            options.signal.addEventListener(
              "abort",
              () => {
                this.approvals.delete(id);
                resolve({ allow: false });
              },
              { once: true },
            );
            o.emit({
              id,
              turnId: o.turnId,
              kind: toolName === "AskUserQuestion" ? "question" : "approval",
              text: toolName,
              status: "pending",
              detail: {
                ...input,
                questions: Array.isArray(input.questions)
                  ? input.questions.map((q: any) => ({ ...q, id: q.question }))
                  : undefined,
              },
            });
          });
          if (toolName === "AskUserQuestion")
            return {
              behavior: "allow" as const,
              updatedInput: { ...input, answers: response.answers || {} },
            };
          return response.allow
            ? { behavior: "allow" as const, updatedInput: input }
            : {
                behavior: "deny" as const,
                message: "De gebruiker heeft deze actie geweigerd.",
              };
        },
      },
    });
    let activeId = "",
      buffer = "",
      resultSeen = false;
    const tools = new Map<string, string>();
    try {
      for await (const message of stream) {
        const m = message as any;
        if (m.session_id) o.thread(m.session_id);
        if (m.parent_tool_use_id) continue;
        if (m.type === "stream_event") {
          const e = m.event;
          if (e.type === "message_start") {
            activeId = e.message.id;
            buffer = "";
          }
          if (
            e.type === "content_block_delta" &&
            e.delta?.type === "text_delta"
          ) {
            buffer += e.delta.text;
            o.emit({
              id: activeId,
              turnId: o.turnId,
              kind: "assistant",
              text: buffer,
              status: "running",
            });
          }
        } else if (m.type === "assistant") {
          const content = m.message.content || [];
          const body = content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n");
          if (body)
            o.emit({
              id: m.message.id,
              turnId: o.turnId,
              kind: "assistant",
              text: body,
              status: "complete",
            });
          for (const b of content.filter((b: any) => b.type === "tool_use")) {
            tools.set(b.id, b.name);
            o.emit({
              id: b.id,
              turnId: o.turnId,
              kind: "tool",
              text: b.name,
              status: "running",
              detail: { input: printable(b.input) },
            });
          }
        } else if (m.type === "user") {
          for (const b of (Array.isArray(m.message?.content)
            ? m.message.content
            : []
          ).filter((b: any) => b.type === "tool_result"))
            o.emit({
              id: b.tool_use_id,
              turnId: o.turnId,
              kind: "tool",
              text: tools.get(b.tool_use_id) || "Tool",
              status: b.is_error ? "error" : "complete",
              detail: { output: printable(b.content) },
            });
        } else if (m.type === "result") {
          resultSeen = true;
          if (m.is_error || m.subtype !== "success")
            throw new Error((m.errors || [m.result || m.subtype]).join("\n"));
        }
      }
      if (!resultSeen)
        throw new Error("Claude is gestopt voordat het antwoord compleet was.");
    } finally {
      o.signal.removeEventListener("abort", abort);
      abort();
    }
  }
}
