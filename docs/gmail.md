# Gmail in Benchdesk

The desktop app has a Connections page with several Gmail accounts, access per company and extra limits per conversation. Claude and Codex use the same four MCP tools: `gmail_list_accounts`, `gmail_search`, `gmail_read_thread` and `gmail_create_draft`.

Benchdesk can search, read and create drafts. It cannot send email.

## One-time setup

You bring your own Google OAuth client. Nothing is shared with the makers of Benchdesk.

1. Create or pick a Google Cloud project and enable the **Gmail API**.
2. Set up Google Auth Platform (branding, audience and data access). For personal use, put the external app in Testing and add your own Google account as a test user. An internal Workspace app also works where your organization allows it.
3. Under Clients, create an OAuth client of type **Desktop app** and download the JSON client file.
4. In Benchdesk, open **Connections → Set up Gmail**. Import the JSON file, or enter the client ID and client secret by hand.
5. Choose **Connect account** for the company you want. Reading is the default; creating drafts is optional. Finish the login in your regular browser and check the connection status in Benchdesk.
6. Check company access per account. One account can be linked to several companies. New conversations follow those rights. When you start a conversation, and under Connections, you can limit it to read-only or no Gmail at all.

For draft access Google asks for the `gmail.compose` scope, which also covers sending. Benchdesk offers no send tool and no general Gmail request tool: only search, read and create drafts. Draft access is checked by Benchdesk on every request.

A reconnected account keeps its company links. Logging in again from another company does not give that company access automatically. After adding draft rights, tick Drafts per company yourself.

## Storage and behaviour

- Google tokens and client details live in `integrations.vault`, encrypted with AES-256-GCM. The random key is in `integrations.key`, protected with Electron safeStorage and the system keychain. There is no unencrypted fallback.
- The desktop app hands the key to the background service over the existing authenticated local RPC connection. The key and tokens never appear in renderer responses, MCP responses, session configuration or normal company backups.
- OAuth uses a temporary listener on `127.0.0.1`, a random port, PKCE S256 and a one-time state. Login requests expire after three minutes and can be cancelled.
- Gmail accounts are chosen from the authenticated Benchdesk session and its company. Every action is checked again, also after a token refresh. An action already submitted to Google cannot be undone by switching rights off afterwards.
- Removing an account wipes the local tokens and links. You can also revoke consent in your Google account.
- A draft carries a request ID so repeated requests in the same session are recognised. After an uncertain timeout Benchdesk refuses a blind retry; check your Gmail drafts first.
- Session rights are kept for the lifetime of the background service, including resume. After a service restart, a resumed session without known rights gets no Gmail by default; choose the rights again.
- This is access control inside Benchdesk, not an OS sandbox for arbitrary programs running under the same user account.

## Limits

No sending, no deleting mail, no attachment downloads, no background inbox sync. Drafts are new plain-text emails without attachments or automatic reply threading. Reading shows at most the last 20 messages per thread and caps message bodies; truncation is reported. HTML is returned as source data and never executed.

The browser view points to the desktop app for connections.

For wider distribution, Google requires OAuth verification of the restricted Gmail scopes. The automated tests run against simulated Google responses; a real account login needs your own Google app configuration and consent.

## Checks

`npm test` covers encryption, invalid keys, OAuth/PKCE/state, limited scopes, cancellation, company separation, session rights, revoked access during token refresh, repeated draft requests, MIME and the real MCP/RPC route. `npm run test:integrations` checks the desktop UI with temporary data and simulated Gmail accounts (needs an unlocked keychain). No real mail is read and no drafts are created during these tests.

## References

- [Google OAuth for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Gmail drafts](https://developers.google.com/workspace/gmail/api/guides/drafts)
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)
