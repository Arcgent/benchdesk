import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexChatDriver,
  type DriverOptions,
} from "../src/runtime/chat-drivers";
import type { ChatUpdate } from "../src/shared/agents";

function options(t: any) {
  const root = mkdtempSync(join(tmpdir(), "benchdesk-driver-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const items: ChatUpdate[] = [];
  const controller = new AbortController();
  const o: DriverOptions = {
    executable: join(root, "fake-codex"),
    cwd: root,
    runtimeDir: root,
    env: { ...process.env },
    prompt: "Hello",
    instruction: "Test only",
    turnId: "turn",
    resumeId: null,
    emit: (item) => items.push(item),
    thread: () => {},
    signal: controller.signal,
  };
  return { root, items, controller, o };
}
test(
  "Codex stdio handshake, streamed items and typed MCP consent",
  { timeout: 10000 },
  async (t) => {
    const { o, items } = options(t);
    writeFileSync(
      o.executable,
      `#!/usr/bin/env node
const send = v => process.stdout.write(JSON.stringify(v)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{}});
 if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'thread-1'}}});
 if(m.method==='turn/start') {
   send({id:m.id,result:{turn:{id:'turn-1'}}});
   send({method:'item/agentMessage/delta',params:{itemId:'a',delta:'Hel'}});
   send({method:'item/agentMessage/delta',params:{itemId:'a',delta:'lo'}});
   send({id:'permission',method:'mcpServer/elicitation/request',params:{mode:'form',serverName:'test',message:'Allow tool?',requestedSchema:{type:'object',required:['allow'],properties:{allow:{type:'boolean'},limit:{type:'integer'}}}}});
 }
 if(m.id==='permission' && m.result) {
   if(m.result.action!=='accept'||m.result.content.allow!==true||m.result.content.limit!==2) process.exit(2);
   send({method:'item/completed',params:{item:{id:'a',type:'agentMessage',text:'Hello'}}});
   send({method:'turn/completed',params:{turn:{status:'completed'}}});
 }
});
`,
      { mode: 0o755 },
    );
    const driver = new CodexChatDriver();
    o.thread = (id) => assert.equal(id, "thread-1");
    o.emit = (item) => {
      items.push(item);
      if (item.kind === "question") {
        assert.throws(
          () =>
            driver.respond(item.id, {
              allow: true,
              answers: { allow: "wrong" },
            }),
          /true of false/,
        );
        driver.respond(item.id, {
          allow: true,
          answers: { allow: "true", limit: "2" },
        });
      }
    };
    await driver.run(o);
    assert.deepEqual(
      items
        .filter((i) => i.kind === "assistant")
        .map((i) => [i.text, i.status]),
      [
        ["Hel", "running"],
        ["Hello", "running"],
        ["Hello", "complete"],
      ],
    );
  },
);
test(
  "missing Codex executable fails promptly instead of waiting for the protocol timeout",
  { timeout: 3000 },
  async (t) => {
    const { o } = options(t);
    await assert.rejects(new CodexChatDriver().run(o), /ENOENT/);
  },
);
test(
  "Codex interruption terminates an idle child and rejects pending initialization",
  { timeout: 5000 },
  async (t) => {
    const { o, controller } = options(t);
    writeFileSync(
      o.executable,
      "#!/usr/bin/env node\nsetInterval(()=>{},1000);\n",
      { mode: 0o755 },
    );
    const running = new CodexChatDriver().run(o);
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(running, /onderbroken/);
  },
);
