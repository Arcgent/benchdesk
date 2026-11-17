import assert from "node:assert/strict";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = await mkdtemp(join(tmpdir(), "benchdesk-agents-desktop-"));
const dataDir = join(root, "data"), workspace = join(root, "work");
await mkdir(dataDir); await mkdir(workspace);
const env = { ...process.env, WERK_DATA_DIR: dataDir, WERK_HIDDEN: "1" };
for (const key of ["ELECTRON_RUN_AS_NODE", "WERK_SOCKET", "WERK_SESSION_ID", "WERK_SESSION_TOKEN", "WERK_LAUNCH_FILE"]) delete env[key];
const app = await electron.launch({ ...(process.env.WERK_TEST_EXECUTABLE ? { executablePath: process.env.WERK_TEST_EXECUTABLE, args: [] } : { args: [resolve(".")] }), env });
let pid;
const errors = [];
try {
  const page = await app.firstWindow();
  page.on("pageerror", e => errors.push(e.message));
  await page.waitForFunction(() => !!window.werk);
  const call = (method, params = {}) => page.evaluate(({method,params}) => window.werk.call(method,params), {method,params});
  const companyId = await call("company.save", { value: { name: "Desktop agent test", workspacePath: workspace } });
  await call("project.save", { value: { companyId, name: "Work" } });
  await page.reload();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "Nieuwe agent", exact: true }).click();
  await page.getByRole("textbox", { name: "Naam", exact: true }).fill("Desktop agent");
  await page.getByRole("textbox", { name: "Vaste briefing", exact: true }).fill("Desktop test briefing.");
  await page.getByRole("button", { name: "Opslaan", exact: true }).click();
  await page.getByRole("heading", { name: "Desktop agent", exact: true }).waitFor();
  await page.getByRole("button", { name: "Nieuw gesprek", exact: true }).click();
  await page.getByText("Gmail-toegang", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Gesprek openen", exact: true }).click();
  await page.getByRole("textbox", { name: "Bericht aan je agent", exact: true }).fill("Local desktop draft.");
  const snapshot = await call("snapshot");
  const c = snapshot.agentConversations[0];
  assert.equal(c.profile.brief, "Desktop test briefing.");
  assert.equal((await call("chat.read", { id: c.id })).items.length, 0);
  assert.equal(snapshot.sessions[0].transport, "chat");
  await page.getByRole("tab", { name: "Geheugen", exact: true }).click();
  await page.getByRole("textbox", { name: "Agentgeheugen", exact: true }).fill("Desktop memory.");
  await page.getByRole("button", { name: "Geheugen opslaan", exact: true }).click();
  await page.waitForFunction(async () => (await window.werk.call("snapshot")).agents[0].memory.content === "Desktop memory.");
  const agentId = snapshot.agents[0].id;
  const skill = await call("agent.skill.save", { agentId, value: { name: "Native skill", trigger: "For native verification", content: "Read context and verify the result." } });
  assert.equal(skill.name, "Native skill");
  assert.deepEqual(await call("agent.search", { id: agentId, query: "missing" }), []);
  const routine = await call("agent.routine.save", { value: { agentId, name: "Native routine", prompt: "Prepare a draft", schedule: "daily", timezone: "Europe/Amsterdam", enabled: false } });
  assert.equal((await call("agent.routine.list", { agentId }))[0].id, routine.id);
  await page.getByRole("tab", { name: "Skills", exact: true }).click();
  await page.getByRole("heading", { name: "Native skill", exact: true }).waitFor();
  await page.getByRole("tab", { name: "Routines", exact: true }).click();
  await page.getByRole("heading", { name: "Native routine", exact: true }).waitFor();
  assert.equal(await page.locator(".agent-roster nav > button").count(), 1);
  assert.deepEqual(errors, []);
  console.log("PASS: packaged desktop agent roster, skills, routines, search, IPC, chat storage and memory editing");
} finally {
  try { pid = Number(await readFile(join(dataDir,"runner.pid"),"utf8")); } catch {}
  await app.close();
  if (pid) { try { process.kill(pid,"SIGTERM"); } catch {} }
  await rm(root,{ recursive:true, force:true });
}
