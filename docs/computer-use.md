# Computer use in Benchdesk

Benchdesk uses the installed OpenAI **unified-computer-use** plugin, with the MCP server **cua_repl** and the tools **js** and **js_reset**. Benchdesk itself ships no mouse or keyboard tools.

## Use

1. Keep ChatGPT and the Computer Use plugin installed.
2. Start a new Codex conversation in Benchdesk, or stop and resume an existing one when resume is available.
3. Click **Computer**. The panel shows whether the plugin was found and set up for this conversation.
4. Ask Codex, for example: "Use Computer Use to open Calculator and work out 12 × 8."
5. Confirm app access through OpenAI Computer Use's own prompts.

Cursor display, app selection, background control and permissions are handled by OpenAI Computer Use. The macOS permissions belong to **Codex Computer Use**, not to Benchdesk. An app can have its own focus or visibility requirements; this is not a second, independent macOS desktop.

## Connection and accounts

On every new Codex process start, `src/runtime/cua-repl.ts` looks first in the selected account profile and then in `~/.codex/plugins/cache/openai-bundled/unified-computer-use`. It uses the newest complete installed version. The official launcher, runtime and signed service stay where they are; Benchdesk does not copy or change them.

The launcher gets a `mcp_servers.cua_repl` override per conversation, so a separate Benchdesk Codex account can also reach the installed plugin. Only the two intended tools are made available. The MCP process uses the selected `CODEX_HOME` for session context; the Codex login and your global configuration are not changed.

Codex supplies the real session and turn metadata to the tool. Benchdesk fabricates no metadata and offers no alternative permission route. A standalone MCP client can discover the tools, but a UI call without Codex turn context rightly returns an error.

The status **Connection set up** means the launcher passed the MCP configuration along. It does not claim that every app permission was granted or that every tool call succeeds. Missing plugin files never block a normal terminal conversation; the Computer panel gives installation advice.

## Checks

The unit and integration tests cover profile isolation, plugin selection, missing installs and keeping the resume ID and prompt. `npm run test:computer` checks the real launcher arguments and the Computer dialog in both themes with isolated data.

The [official OpenAI documentation on Computer Use](https://learn.chatgpt.com/docs/computer-use) describes the plugin, app permissions and background use on macOS. This connection depends on the locally installed OpenAI plugin; changes to that plugin can require changes here.
