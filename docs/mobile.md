# Benchdesk on your phone

Your Mac is the base station. The mobile web app reads the same conversations through the existing `runner.sock` and can send messages to agent conversations that already exist. It does not copy the database and it never starts, upgrades or stops the desktop service.

A native SwiftUI client lives in [`ios/`](../ios/README.md). It uses the same bridge.

## What works

- Pairing with a one-time eight-digit code, valid for ten minutes. Five wrong attempts block that code.
- Searching conversations across all companies, with live status, session notes and terminal output.
- Reading existing agent chats, including paging through history, and continuing the conversation.
- Sending a text message to a running Claude or Codex terminal. Benchdesk can queue the message while the agent is busy.
- Live refresh every 1.5 to 2.5 seconds, reconnecting and unpairing.
- A mobile layout and a web app manifest, so you can open it from your home screen.

The terminal is a view at its original width; scroll sideways to read everything. Your phone never changes the terminal size on the Mac. Permission prompts, shell control, new sessions and resuming closed terminals stay on the Mac in this first version.

## Start locally

Open Benchdesk first. Then, from the repository:

```sh
npm run mobile
```

The terminal shows `http://localhost:5184` and a temporary pairing code. That address only works on the Mac itself. Next time, start the existing build with `npm run mobile:start`.

Stop the bridge with Ctrl+C. All paired browsers become invalid; your real Benchdesk conversations keep running. Sending `SIGHUP` to the bridge process shows a new one-time code without unpairing existing phones. Pairings are temporary in this version: at most thirty days, and always until the bridge restarts. The bridge does not start automatically with the desktop app yet.

## On your phone, through Tailscale

1. Connect the Mac and the phone to the same Tailscale network.
2. Enable **Serve/HTTPS** in Tailscale if the CLI asks for it.
3. Check existing configuration with `tailscale serve status --json` and pick a free HTTPS port. The examples use 8443.
4. Start the bridge with the HTTPS address of the base station:

```sh
BENCHDESK_MOBILE_ORIGIN='https://your-mac.your-tailnet.ts.net:8443' npm run mobile:start
```

5. Point the private HTTPS entry at the local server:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:5184
```

6. Open that HTTPS address on your phone and enter the code from the Mac. Add the page to your home screen if you like; pair again from the home screen app if the browser keeps separate cookies.

This uses **Tailscale Serve**, which stays inside your own Tailscale network. Do not use Funnel. The server only listens on `127.0.0.1`; never expose it to the public internet. Host and Origin checks accept only the configured address. The HTTPS cookie is Secure, HttpOnly and SameSite=Strict. Phones get no general RPC, file or account management endpoint.

Switch the private forwarding off again (only the entry on port 8443):

```sh
tailscale serve --https=8443 off
```

Source: [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve), [CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve).

## When the connection drops

The page retries read requests and shows that the connection is lost. Messages are never resent automatically. A repeated send with the same message ID is deduplicated. After an uncertain send error the text stays in place: check the conversation before you send a changed instruction. A sleeping or switched-off Mac makes the base station unreachable. The web app does not keep the Mac awake and cannot run tasks without it.

## Checks

```sh
npm run mobile:build
npm run test:mobile
./node_modules/.bin/tsc --noEmit
```

The HTTP integration tests cover unauthorized access, Host/Origin, pairing, expiry and lockout, data minimisation, hiding CLI login sessions, double sends, chat paging, unpairing, revoking and independent pairings for several base station addresses.

Not covered yet: a signed iPhone or App Store build, and an Android app.
