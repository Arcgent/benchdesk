import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { findCuaInstallation } from "../runtime/cua-repl";
import type { ComputerStatus } from "../shared/computer";
import type { Snapshot } from "../shared/types";
import { RpcClient } from "../runtime/rpc";

export class DesktopComputer {
  constructor(
    private dataDir: string,
    private runtime: () => Promise<RpcClient>,
  ) {}
  async ui(method: string, params: any): Promise<ComputerStatus> {
    if (method !== "computer.get")
      throw new Error(
        "De oude muisbediening is vervangen door OpenAI Computer Use. Start een nieuw Codex-gesprek.",
      );
    const id = z.string().uuid().parse(params?.sessionId);
    const snap = await (await this.runtime()).call<Snapshot>("snapshot");
    const session = snap.sessions.find(
      (s) => s.id === id && s.provider === "codex",
    );
    if (!session) throw new Error("Codex-gesprek niet gevonden.");
    const installation = findCuaInstallation(
      session.accountConfigDir || join(homedir(), ".codex"),
    );
    let marker: any;
    try {
      marker = JSON.parse(
        readFileSync(
          join(this.dataDir, "sessions", id, "launch.json.cua.json"),
          "utf8",
        ),
      );
    } catch {}
    return {
      available: installation.available,
      version: installation.version,
      reason: installation.reason,
      configured: !!marker?.configured && !!session.agentRunning,
      sessionVersion:
        typeof marker?.version === "string" ? marker.version : null,
    };
  }
  async start() {
    // Old MCP processes may still have cached computer_action. There is no
    // native socket or global-input backend to service these calls anymore.
    const legacy = join(this.dataDir, "computer.sock");
    if (existsSync(legacy)) unlinkSync(legacy);
  }
  close() {}
}
