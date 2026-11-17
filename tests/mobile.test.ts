import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { createMobileServer } from "../src/mobile/server";

const id = "10000000-0000-4000-8000-000000000001";
const loginId = "10000000-0000-4000-8000-000000000002";
const msgId = "10000000-0000-4000-8000-000000000003";
const chatId = "10000000-0000-4000-8000-000000000004";
const origin = "https://station.example.test";
async function setup(t: any, configuredOrigin = origin) {
  const origin = configuredOrigin;
  let now = Date.now(),
    writes = 0;
  const calls: { method: string; params: any }[] = [];
  const sessions: any[] = [
    {
      id,
      companyId: "company",
      taskId: null,
      provider: "codex",
      state: "idle",
      purpose: "work",
      alive: true,
      agentRunning: true,
      updatedAt: "2026-09-21",
      cwd: "/private/work",
      accountConfigDir: "/private/account",
    },
    { id: loginId, purpose: "login" },
  ];
  const bridge = createMobileServer({
    origin,
    uiRoot: "dist/mobile/ui",
    station: "Test laptop",
    now: () => now,
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "snapshot")
        return {
          sessions,
          companies: [
            { id: "company", name: "Testbedrijf", secret: "private" },
          ],
          tasks: [],
          agentConversations: [],
        } as any;
      if (method === "session.screen")
        return { screen: "hello", sequence: 1, cols: 80, rows: 24 } as any;
      if (method === "session.message") {
        writes++;
        await new Promise((r) => setTimeout(r, 20));
        return { queued: false } as any;
      }
      if (method === "chat.send")
        return { turnId: params.clientMessageId } as any;
      if (method === "chat.read")
        return {
          items: [],
          nextSequence: params.afterSequence,
          more: false,
          conversation: { profile: { secret: "hidden" } },
        } as any;
      throw Error("Unexpected call");
    },
  });
  bridge.server.listen(0, "127.0.0.1");
  await once(bridge.server, "listening");
  const address = bridge.server.address() as { port: number };
  t.after(() => {
    bridge.server.closeAllConnections();
    bridge.server.close();
  });
  const url = `http://127.0.0.1:${address.port}`;
  // Node fetch rewrites Host; raw HTTP models the HTTPS proxy accurately.
  const request = (
    path: string,
    body?: unknown,
    cookie = "",
    headers: Record<string, string> = {},
  ) =>
    new Promise<Response>((resolve, reject) => {
      const req = http.request(
        url + path,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Host: new URL(origin).host,
            ...(body === undefined
              ? {}
              : { Origin: origin, "Content-Type": "application/json" }),
            ...(cookie ? { Cookie: cookie } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode,
                headers: res.headers as any,
              }),
            ),
          );
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const pair = async () => {
    const response = await request("/api/pair", {
      code: bridge.newPairing().code,
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie")!.split(";")[0];
  };
  return {
    request,
    pair,
    bridge,
    calls,
    sessions,
    writes: () => writes,
    advance: (ms: number) => (now += ms),
  };
}

test("mobile rejects unauthenticated access, bad hosts, cross-origin requests and arbitrary RPC", async (t) => {
  const f = await setup(t);
  assert.equal((await f.request("/api/sessions")).status, 401);
  assert.equal(
    (await f.request("/api/sessions", undefined, "", { Host: "evil.example" }))
      .status,
    403,
  );
  const cookie = await f.pair();
  assert.equal(
    (
      await f.request("/api/message", {}, cookie, {
        Origin: "https://evil.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/sessions", undefined, cookie, {
        "Sec-Fetch-Site": "cross-site",
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.request("/api/call", { method: "session.write" }, cookie)).status,
    404,
  );
  assert.equal(f.calls.length, 0);
});
test("pairing is one-time, expires, locks after five attempts, and sets secure HttpOnly cookies", async (t) => {
  const f = await setup(t),
    code = f.bridge.newPairing().code;
  const response = await f.request("/api/pair", { code });
  assert.match(
    response.headers.get("set-cookie")!,
    /HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000; Secure/,
  );
  assert.equal((await f.request("/api/pair", { code })).status, 429);
  const expired = f.bridge.newPairing().code;
  f.advance(600001);
  assert.equal((await f.request("/api/pair", { code: expired })).status, 429);
  const locked = f.bridge.newPairing().code;
  for (let i = 0; i < 5; i++)
    assert.equal((await f.request("/api/pair", { code: "wrong" })).status, 403);
  assert.equal((await f.request("/api/pair", { code: locked })).status, 429);
});
test("session output is scoped and minimized; login sessions and local config stay private", async (t) => {
  const f = await setup(t),
    cookie = await f.pair();
  const response = await f.request("/api/sessions", undefined, cookie),
    data = await response.json();
  assert.equal(data.sessions.length, 1);
  assert.equal(data.station, "Test laptop");
  assert.equal(data.sessions[0].company, "Testbedrijf");
  assert.equal(JSON.stringify(data).includes("/private"), false);
  assert.equal(
    (await f.request(`/api/session?id=${loginId}`, undefined, cookie)).status,
    404,
  );
  const detail = await (
    await f.request(`/api/session?id=${id}`, undefined, cookie)
  ).json();
  assert.equal(detail.frame.screen, "hello");
  assert.equal(
    (await f.request("/api/session?id=../../etc/passwd", undefined, cookie))
      .status,
    400,
  );
});
test("concurrent retries deliver PTY message once; reused ID with different text is refused", async (t) => {
  const f = await setup(t),
    cookie = await f.pair(),
    body = { id, message: "Continue", clientMessageId: msgId };
  const responses = await Promise.all([
    f.request("/api/message", body, cookie),
    f.request("/api/message", body, cookie),
  ]);
  assert.deepEqual(
    responses.map((r) => r.status),
    [200, 200],
  );
  assert.equal(f.writes(), 1);
  assert.equal(
    (
      await f.request(
        "/api/message",
        { ...body, message: "Another command" },
        cookie,
      )
    ).status,
    409,
  );
  f.sessions[0].provider = "shell";
  assert.equal((await f.request("/api/message", body, cookie)).status, 409);
});
test("chat pagination and idempotent client ID reach the existing conversation only", async (t) => {
  const f = await setup(t),
    cookie = await f.pair();
  Object.assign(f.sessions[0], { transport: "chat", conversationId: chatId });
  const detail = await (
    await f.request(`/api/session?id=${id}&after=220`, undefined, cookie)
  ).json();
  assert.deepEqual(detail.chat, { items: [], nextSequence: 220, more: false });
  const result = await f.request(
    "/api/message",
    { id, message: "Continue", clientMessageId: msgId },
    cookie,
  );
  assert.equal(result.status, 200);
  assert.deepEqual(f.calls.at(-1), {
    method: "chat.send",
    params: { id: chatId, message: "Continue", clientMessageId: msgId },
  });
});
test("logout, expiry and revocation immediately invalidate device access", async (t) => {
  const f = await setup(t);
  let cookie = await f.pair();
  assert.equal((await f.request("/api/logout", {}, cookie)).status, 200);
  assert.equal(
    (await f.request("/api/sessions", undefined, cookie)).status,
    401,
  );
  cookie = await f.pair();
  f.advance(31 * 86400000);
  assert.equal(
    (await f.request("/api/sessions", undefined, cookie)).status,
    401,
  );
  cookie = await f.pair();
  f.bridge.revokeAll();
  assert.equal(
    (await f.request("/api/sessions", undefined, cookie)).status,
    401,
  );
});
test("remote plaintext origin is never accepted", () => {
  assert.throws(
    () =>
      createMobileServer({
        origin: "http://192.168.1.2:5184",
        uiRoot: ".",
        station: "test",
        call: async () => null as any,
      }),
    /HTTPS/,
  );
});

test("two stations on different ports keep independent browser pairings", async (t) => {
  const a = await setup(t, "https://station.example.test:8443");
  const b = await setup(t, "https://station.example.test:8444");
  const cookieA = await a.pair(),
    cookieB = await b.pair();
  assert.notEqual(cookieA.split("=")[0], cookieB.split("=")[0]);
  const cookies = `${cookieA}; ${cookieB}`;
  assert.equal(
    (await a.request("/api/sessions", undefined, cookies)).status,
    200,
  );
  assert.equal(
    (await b.request("/api/sessions", undefined, cookies)).status,
    200,
  );
  await a.request("/api/logout", {}, cookies);
  assert.equal(
    (await b.request("/api/sessions", undefined, cookies)).status,
    200,
  );
});
