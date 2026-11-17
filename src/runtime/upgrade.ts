import type { RpcClient } from "./rpc";
import type { Snapshot } from "../shared/types";

export type UpgradeSession = {
  id: string;
  title: string;
  company: string;
  provider: string;
};
export class ActiveRunnerUpgrade extends Error {
  constructor(readonly sessions: UpgradeSession[]) {
    super(
      "De nieuwe achtergrondservice start zodra je lopende gesprekken zijn afgesloten.",
    );
  }
}

// Only the old service can decide whether it is safe to stop: a session may
// have started since the snapshot. Its shutdown endpoint guards that race.
export async function prepareRunner(client: RpcClient) {
  const info = await client.call<{ version: number }>("ping", {}, 2000);
  if (info.version === 17) return;
  if (info.version > 17)
    throw new Error(
      "Open de nieuwere versie van Benchdesk om deze achtergrondservice te gebruiken.",
    );
  const pending = async () => {
    const snap = await client.call<Snapshot>("snapshot");
    return snap.sessions
      .filter((s) => s.alive)
      .map((s) => ({
        id: s.id,
        title:
          snap.tasks.find((t) => t.id === s.taskId)?.title ||
          (s.mode === "planning"
            ? "Prioriteitenadvies"
            : s.mode === "intake"
              ? "Bedrijfsintake"
              : "Vrij gesprek"),
        company:
          snap.companies.find((c) => c.id === s.companyId)?.name || "Benchdesk",
        provider: s.provider,
      }));
  };
  const sessions = await pending();
  if (sessions.length) throw new ActiveRunnerUpgrade(sessions);
  try {
    await client.call("shutdown");
  } catch {
    throw new ActiveRunnerUpgrade(await pending());
  }
  // Wait for the listening socket to go away before a replacement may boot.
  for (let i = 0; i < 30 && !client.socket.destroyed; i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  if (!client.socket.destroyed) throw new ActiveRunnerUpgrade(await pending());
  throw new Error("De vorige achtergrondservice is veilig afgesloten.");
}
