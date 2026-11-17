# Agents and chat

Every company can have named agents under **Agents**. You set the profile yourself: name, role, avatar, colour, briefing, provider (Claude or Codex) and account. A conversation can start free or be linked to a task. Starting from a task sends the assignment right away; from **New conversation** you write the first message yourself.

Agents use the Claude Code and Codex you have installed, with your existing tool permissions. A new agent conversation gets no Gmail access by default; you choose that when you open the chat.

## Storage and execution

- Agent profiles, conversations, chat items and their links to tasks live in the local SQLite database and are included in backups. Terminal (PTY) sessions are separate and unchanged by agents.
- `src/core/agents.ts` keeps profile revisions, shared memory, conversation snapshots and monotonic message sequences. Profile and memory changes have independent revisions, so a correction of yours is not overwritten by a simultaneous agent update.
- `src/runtime/chats.ts` handles starting, idempotent sending, stopping, feedback and task locking. The RPC request does not wait for the model. Each turn gets a fresh MCP session token that is revoked afterwards.
- `src/runtime/chat-drivers.ts` talks to the Codex app-server over JSON-RPC and to the Claude Agent SDK with the locally installed Claude CLI. Both keep the native provider conversation. Benchdesk does not switch off any sandbox or permission.
- `get_agent_context` and `save_agent_memory` derive the agent only from the authenticated session. A tool call cannot pick another agent or another company. Memory is context, not extra authorization.
- Shared agent memory differs from session notes: the first holds durable preferences and lessons across assignments, the second describes the progress of one conversation.
- After a crash or restore, open questions lapse. Resuming is explicit, through a new message. Provider transcripts and credentials stay with Claude and Codex and are not copied by a Benchdesk backup.
- Profile changes apply to new conversations. Existing conversations keep their original briefing, provider and account. Archiving keeps everything and blocks new messages until you restore the agent.

## What an agent can have

- **Search.** `search_agent_history` and the Search tab only search the agent's own user and assistant messages, with at most 30 fragments and links to the conversation. Tool output is excluded.
- **Skills.** Up to 50 procedures per agent, each with a name, when to use it, steps, status and its own revision. `get_agent_context` returns a short catalogue; `get_agent_skill` fetches the content. `save_agent_skill` can store or improve procedures, but cannot re-enable a skill you switched off. Skills are instructions, not permissions.
- **Routines.** Daily, weekly or on an interval of at least 15 minutes, with a time zone. Every run opens a new conversation. Routines are off by default and also need permission in the agent profile. Gmail access is chosen per routine. The local background service checks every eight seconds. Sleep or shutdown means no exact-time guarantee; missed runs are not caught up. A busy agent is skipped with a visible notice.
- **Rights.** Extra work folders are passed to the provider; the company or project folder stays the base. This is no new OS isolation: the provider applies its own sandbox and permissions. Access to Gmail, GitHub, Fireflies, Pocket, Unipile and Blotato through Benchdesk is checked against the current agent rights before every tool call.
- **Handoffs.** Both agents must allow messages, and the sender picks allowed recipients inside the same company. `handoff_agent_work` and the chat button create a new conversation with the recipient, with links in both conversations. The source task is not moved. There are limits per conversation and per chain, and returning to an agent earlier in the same chain is blocked.

## Policy and audit

Every agent action goes through one gateway (`src/runtime/gateway.ts`): evaluate policy, write an audit row, and only then act.

**Policy**

- The policy sits per agent in `access.policy` (`src/shared/policy.ts`). It is a list of JSON rules, not an expression language.
- Order of decisions: deny first, then ask, then allow. If no rule matches, the default per kind of action applies (`read`, `write`, `internal`).
- A broken pattern fails closed: a deny rule counts as a match, an allow rule does not.
- With `dry_run` the gateway records everything but lets everything through.
- Unknown tools count as `write`.
- New agents get `write: ask`.

**Enforcement**

- **Benchdesk MCP tools:** the runner routes every tool call through the gateway. When the outcome is "ask", an approval item appears in the chat.
- **Claude:** a `PreToolUse` hook in the Agent SDK. On deny or ask, the policy decides. On allow, the gateway leaves it to Claude's own permissions.
- **Codex:** the Benchdesk tools are fully covered. Commands and file changes only pass the gateway when Codex asks for approval outside its sandbox; a deny rule then rejects them automatically.
- **Terminal sessions:** these never have an agent, since agents always run through chat. No policy applies there.

**Audit**

- Audit rows live in the `agent_audit` table. Input is redacted and cut off at 4 KB.
- The runner cleans up on start: rows older than 90 days are removed, with a maximum of 200,000 rows.
- Audit rows are not part of backups and stay in place after a restore.

## Questions and components

- **`ask_person`** creates a question item and asks the agent to end its turn. The conversation stays on "waiting" while a question is open. Your answer starts a new turn or is queued.
- **`show_component`** renders from a fixed catalogue (`src/shared/components.ts`): card, table, chart, form, choice and checklist, with hard limits. There is always a text version for search, mobile and handoffs. Forms, choices and checklists wait for your input, which is validated and sent as the next user message.

## Providers with their own MCP server

Blotato is connected through its own MCP server. Benchdesk contacts the server itself and sends the API key, which is stored encrypted in the vault, as a header. The server's tools show up in conversations as `blotato_*`. Calls run through the runner, so agent rules, the audit log and the checks per company and conversation apply. The key never ends up in a conversation, a config file or a command line.

To add another provider with its own MCP server, add an entry to `remoteMcp`, `externalProvider` and `externalConfig` in `src/shared/integrations.ts`, the card list in `src/ui/ExternalIntegrations.tsx` and the agent rights.

## Checks

```sh
npm test
npm run build
npm run test:agents
```

The unit and integration tests use temporary databases and fake drivers. No paid model calls are made.

The optional real provider test costs model usage and only runs after an explicit opt-in:

```sh
npx esbuild scripts/smoke-agent-live.ts --bundle --platform=node --format=cjs --outfile=tmp/agents-smoke/live.cjs
BENCHDESK_LIVE_CHAT_TEST=1 ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron tmp/agents-smoke/live.cjs
```

Add `codex` or `claude` to test one provider. The test uses temporary company data and only allows the context and memory tools; other permission prompts are refused.
