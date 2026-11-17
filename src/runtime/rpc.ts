import net from "node:net";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
// Upper bound for one unread line or for unflushed output on a runner socket. A full snapshot is
// several MB and grows with every session; at 4 MB, two snapshots in a row dropped the app
// ("Verbinding met de achtergrondservice verbroken."). This only guards against a client that
// stopped reading altogether.
export const MAX_SOCKET_BUFFER = 64_000_000;
export class RpcClient extends EventEmitter {
  socket: net.Socket;
  pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  buffer = "";
  constructor(
    socketPath: string,
    public auth: Record<string, string>,
  ) {
    super();
    this.socket = net.createConnection(socketPath);
    this.socket.setEncoding("utf8");
    this.socket.on("data", (data: string) => {
      this.buffer += data;
      if (this.buffer.length > MAX_SOCKET_BUFFER) {
        this.socket.destroy();
        return;
      }
      let end;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.event) this.emit("event", msg.event);
          else {
            const p = this.pending.get(msg.id);
            if (p) {
              clearTimeout(p.timer);
              this.pending.delete(msg.id);
              msg.error
                ? p.reject(new Error(msg.error))
                : p.resolve(msg.result);
            }
          }
        } catch {}
      }
    });
    this.socket.on("error", () => {});
    this.socket.on("close", () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("Verbinding met de achtergrondservice verbroken."));
      }
      this.pending.clear();
      this.emit("disconnected");
    });
  }
  async ready() {
    if (!this.socket.connecting && !this.socket.destroyed) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.destroy();
        reject(new Error("Achtergrondservice niet bereikbaar."));
      }, 3000);
      this.socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }
  async call<T = any>(
    method: string,
    params: any = {},
    timeout = 15000,
  ): Promise<T> {
    await this.ready();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("De aanvraag duurde te lang."));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(
        JSON.stringify({ id, ...this.auth, method, params }) + "\n",
      );
    });
  }
  close() {
    this.socket.destroy();
  }
}
export async function agentRequest(
  method: string,
  params: any,
  timeout = 2500,
) {
  const client = new RpcClient(process.env.WERK_SOCKET!, {
    channel: "agent",
    sessionId: process.env.WERK_SESSION_ID!,
    token: process.env.WERK_SESSION_TOKEN!,
  });
  try {
    return await client.call(method, params, timeout);
  } finally {
    client.close();
  }
}
