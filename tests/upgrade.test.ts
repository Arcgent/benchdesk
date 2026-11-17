import test from "node:test";
import assert from "node:assert/strict";
import { ActiveRunnerUpgrade, prepareRunner } from "../src/runtime/upgrade";

function fixture(version: number, live: boolean, rejectShutdown = false) {
  const calls: string[] = [];
  const client: any = {
    socket: { destroyed: false },
    call: async (method: string) => {
      calls.push(method);
      if (method === "ping") return { version };
      if (method === "snapshot")
        return {
          companies: [{ id: "c", name: "Bedrijf" }],
          tasks: [],
          sessions: [
            { id: "s", companyId: "c", provider: "shell", alive: live },
          ],
        };
      if (method === "shutdown") {
        if (rejectShutdown) throw new Error("Er zijn nog actieve gesprekken.");
        client.socket.destroyed = true;
      }
    },
  };
  return { client, calls };
}
test("een service-update laat bestaande terminals doorlopen", async () => {
  const f = fixture(2, true);
  await assert.rejects(
    prepareRunner(f.client),
    (error: any) =>
      error instanceof ActiveRunnerUpgrade && error.sessions[0].id === "s",
  );
  assert.deepEqual(f.calls, ["ping", "snapshot"]);
});
test("een service-update respecteert de laatste shutdowncontrole van de oude service", async () => {
  const f = fixture(1, false, true);
  await assert.rejects(prepareRunner(f.client), ActiveRunnerUpgrade);
  assert.equal(f.client.socket.destroyed, false);
});
test("alleen een lege oude service wordt afgesloten; de actuele service blijft verbonden", async () => {
  const f = fixture(1, false);
  await assert.rejects(prepareRunner(f.client), /veilig afgesloten/);
  assert.equal(f.client.socket.destroyed, true);
  const current = fixture(17, true);
  await prepareRunner(current.client);
  assert.deepEqual(current.calls, ["ping"]);
});

test("workspace output update waits for active conversations before replacing runtime 15", async () => {
  const active = fixture(15, true);
  await assert.rejects(prepareRunner(active.client), ActiveRunnerUpgrade);
  assert.deepEqual(active.calls, ["ping", "snapshot"]);
  const idle = fixture(15, false);
  await assert.rejects(prepareRunner(idle.client), /veilig afgesloten/);
  assert.deepEqual(idle.calls, ["ping", "snapshot", "shutdown"]);
});

test("brain sync fix replaces runtime 16 once no conversation is running", async () => {
  const active = fixture(16, true);
  await assert.rejects(prepareRunner(active.client), ActiveRunnerUpgrade);
  const idle = fixture(16, false);
  await assert.rejects(prepareRunner(idle.client), /veilig afgesloten/);
  assert.deepEqual(idle.calls, ["ping", "snapshot", "shutdown"]);
});
