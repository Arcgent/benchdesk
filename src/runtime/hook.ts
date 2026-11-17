import { randomUUID } from "node:crypto";
import { agentRequest } from "./rpc";
async function main() {
  if (!process.env.WERK_SESSION_ID) return;
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 1_000_000) return;
  }
  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }
  const outcome = await agentRequest("hook", {
    id: randomUUID(),
    name: event.hook_event_name,
    at: Date.now(),
    providerSessionId: event.session_id,
    source: event.source,
    toolName: event.tool_name,
    stopHookActive: event.stop_hook_active === true,
  });
  if (event.hook_event_name === "Stop" && outcome?.memoryReminder) {
    process.stdout.write(
      JSON.stringify({ decision: "block", reason: outcome.memoryReminder }),
    );
  }
  if (event.hook_event_name === "SessionStart") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: "Benchdesk: haal het actuele startpakket en sessiegeheugen op via get_task_context, ook na hervatten of compactie.",
        },
      }),
    );
  }
}
main().catch(() => {});
