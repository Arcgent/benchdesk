import { hostname, homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { RpcClient } from "../runtime/rpc";
import { createMobileServer } from "./server";

const port = Number(process.env.BENCHDESK_MOBILE_PORT || 5184);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Ongeldige poort.");
const dataDir =
  process.env.WERK_DATA_DIR ||
  join(homedir(), "Library", "Application Support", "Werk");
let client: RpcClient | undefined;
// Attach to the existing runner only. Never start, upgrade or stop desktop work.
async function call<T = any>(method: string, params?: any): Promise<T> {
  if (!client || client.socket.destroyed)
    client = new RpcClient(join(dataDir, "runner.sock"), {
      channel: "app",
      token: readFileSync(join(dataDir, "control-token"), "utf8"),
    });
  return client.call<T>(method, params);
}
const origin =
  process.env.BENCHDESK_MOBILE_ORIGIN || `http://localhost:${port}`;
const bridge = createMobileServer({
  origin,
  uiRoot: resolve(__dirname, "ui"),
  call,
  station: hostname(),
});
bridge.server.listen(port, "127.0.0.1", () => {
  const pair = bridge.newPairing();
  console.log(
    `Benchdesk Mobiel: ${origin}\nKoppelcode: ${pair.code}\nGeldig tot: ${pair.expiresAt}\nStop met Ctrl+C om alle telefoons te ontkoppelen.`,
  );
  void call("snapshot").then(
    () => console.log("Verbonden met bestaande Benchdesk-sessies."),
    () =>
      console.error(
        "Open Benchdesk op je laptop. De mobiele app probeert bij je volgende aanvraag opnieuw te verbinden.",
      ),
  );
});
bridge.server.on("error", (e) => {
  console.error(e.message);
  process.exit(1);
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    bridge.revokeAll();
    client?.close();
    bridge.server.closeAllConnections();
    bridge.server.close(() => process.exit(0));
  });
// Generate another short-lived, single-use code without interrupting sessions.
process.on("SIGHUP", () =>
  console.log("Nieuwe koppelcode:", bridge.newPairing().code),
);
