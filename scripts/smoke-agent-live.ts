// Opt-in paid-provider smoke test. Run the compiled file with Electron-as-Node.
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { RpcClient } from "../src/runtime/rpc";
import type { AgentConversation, ChatRead } from "../src/shared/agents";
import type { Snapshot } from "../src/shared/types";

async function main() {
  assert.equal(
    process.env.BENCHDESK_LIVE_CHAT_TEST,
    "1",
    "Opt in with BENCHDESK_LIVE_CHAT_TEST=1",
  );
  const root = mkdtempSync(join(tmpdir(), "benchdesk-chat-live-")),
    dataDir = join(root, "data"),
    workspace = join(root, "workspace");
  mkdirSync(dataDir);
  mkdirSync(workspace);
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    WERK_DATA_DIR: dataDir,
  };
  for (const key of [
    "WERK_SOCKET",
    "WERK_SESSION_ID",
    "WERK_SESSION_TOKEN",
    "WERK_LAUNCH_FILE",
  ])
    delete env[key as keyof typeof env];
  const runner = spawn(process.execPath, [join(process.env.WERK_TEST_RUNTIME_DIR || resolve("dist/runtime"), "runner.cjs")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "",
    client: RpcClient | undefined;
  runner.stdout.on("data", (d) => (logs += d));
  runner.stderr.on("data", (d) => (logs += d));
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    for (let i = 0; i < 200; i++) {
      if (runner.exitCode !== null) throw new Error(logs);
      if (existsSync(join(dataDir, "runner.sock"))) {
        const c = new RpcClient(join(dataDir, "runner.sock"), {
          channel: "app",
          token: readFileSync(join(dataDir, "control-token"), "utf8"),
        });
        try {
          await c.call("ping");
          client = c;
          break;
        } catch {
          c.close();
        }
      }
      await delay(50);
    }
    assert.ok(client, "Runner ready");
    const rpc = client;
    const companyId = await rpc.call<string>("company.save", {
      value: {
        name: "Isolated chat integration test",
        workspacePath: workspace,
      },
    });
    for (const provider of process.argv.slice(2).length
      ? process.argv.slice(2)
      : ["codex", "claude"]) {
      const id = await rpc.call<string>("agent.save", {
        value: {
          companyId,
          name: `${provider} test`,
          provider,
          brief:
            "Only run the explicitly requested Benchdesk context/memory tools. No shell, filesystem, web, external service or computer actions. Keep replies extremely short.",
        },
      });
      const c = await rpc.call<AgentConversation>("chat.start", {
        companyId,
        agentId: id,
      });
      const nonce = randomUUID();
      const turn = async (message: string) => {
        await rpc.call("chat.send", {
          id: c.id,
          message,
          clientMessageId: randomUUID(),
        });
        const end = Date.now() + 180000;
        let afterSequence = 0;
        const handled = new Set<string>();
        while (Date.now() < end) {
          const read = await rpc.call<ChatRead>("chat.read", {
            id: c.id,
            afterSequence,
          });
          afterSequence = read.nextSequence;
          for (const item of read.items) {
            if (
              item.kind === "question" &&
              item.status === "pending" &&
              !handled.has(item.id)
            ) {
              handled.add(item.id);
              throw new Error(
                "Unexpected provider question in controlled test",
              );
            }
            if (
              item.kind === "approval" &&
              item.status === "pending" &&
              !handled.has(item.id)
            ) {
              handled.add(item.id);
              const allow =
                (item.detail?.serverName === "werk_task_context" &&
                  /^Allow the werk_task_context MCP server to run tool "(get_agent_context|get_task_context|save_agent_memory|patch_session_memory)"\?$/.test(
                    item.text,
                  )) ||
                /^mcp__werk_task_context__(get_agent_context|get_task_context|save_agent_memory|patch_session_memory)$/.test(
                  item.text,
                );
              await rpc.call("chat.respond", {
                id: c.id,
                requestId: item.id,
                allow,
              });
              console.log(
                provider,
                "permission",
                item.text,
                allow ? "allowed" : "denied",
              );
            }
            if (item.kind === "tool" && item.status !== "running")
              console.log(
                provider,
                "tool",
                item.text,
                item.status,
                item.status === "error" ? item.detail?.output : "",
              );
            if (item.kind === "error")
              throw new Error(`${provider}: ${item.text}`);
          }
          const snap = await rpc.call<Snapshot>("snapshot"),
            session = snap.sessions.find((s) => s.id === c.sessionId)!;
          if (!session.agentRunning) {
            assert.equal(session.state, "idle", session.error);
            assert.ok(
              session.providerSessionId,
              "Provider thread was persisted",
            );
            return {
              snap,
              read: await rpc.call<ChatRead>("chat.read", { id: c.id }),
            };
          }
          await delay(250);
        }
        throw new Error(`${provider} timed out`);
      };
      const first = await turn(
        `This is an isolated integration test. Call get_agent_context and get_task_context. Then save_agent_memory with content exactly "Keep replies concise." and the current expectedRevision. Do not use any other tools. Remember this conversation-only nonce (do not put it in shared memory): ${nonce}. Reply only READY.`,
      );
      assert.equal(
        first.snap.agents?.find((a) => a.id === id)?.memory.content,
        "Keep replies concise.",
      );
      const second = await turn(
        "Read get_agent_context and get_task_context. Reply with the conversation-only nonce from my previous message. Use no other tools.",
      );
      assert.ok(
        second.read.items.some(
          (i) => i.kind === "assistant" && i.text.includes(nonce),
        ),
        "Conversation history resumed correctly",
      );
      console.log(
        `PASS: ${provider} context tools, memory save, streaming and provider history resume`,
      );
    }
  } finally {
    if (client) {
      try {
        const snap = await client.call<Snapshot>("snapshot");
        for (const s of snap.sessions.filter((s) => s.agentRunning))
          await client.call("chat.interrupt", { id: s.conversationId });
        await client.call("shutdown");
      } catch {}
      client.close();
    }
    runner.kill("SIGTERM");
    await delay(500);
    rmSync(root, { recursive: true, force: true });
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
