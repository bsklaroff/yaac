# Signing in to Claude and Codex

A Claude or Codex sign-in is an OAuth authorization-code grant with PKCE,
run by the server (`domain/auth/tool-login.ts`) with each vendor's public
client id, the same one its CLI uses. The server makes the PKCE verifier,
builds the authorize URL, trades the code that comes back for tokens, and
stores them as the user's sign-in (`signInTool`). Any client can drive it
through `POST /auth/:tool/login/start`, `GET /auth/login/:id`,
`POST /auth/login/:id/input` and `POST /auth/login/:id/cancel`, so a phone
signs in as easily as a laptop. Neither vendor's CLI is involved, on the
server or on the user's machine.

## Getting the code back

The authorize page sends the browser back with the code, and where it can
send it depends on where the browser runs:

| Mode | Claude | Codex | Used by |
|---|---|---|---|
| loopback, caught by the desktop app | `http://localhost:<port>/callback`, a port the server picks from the dynamic range | `http://127.0.0.1:1455/auth/callback`, the one port Codex's client allows | the webapp in the desktop app (`callback: 'auth-daemon'`) |
| loopback, caught by the caller | the same | the same | `yaac auth update` where a browser it opens runs on the same machine (`callback: 'caller'`) |
| manual | Claude's own callback page shows `code#state`, which the user pastes | the device flow: the user enters a short code on `auth.openai.com/codex/device` while the server polls | the webapp in a browser or the iPhone app, and `yaac auth update` over SSH |

Only the code and state come back through a loopback listener. The code is
worthless without the verifier, which never leaves the server, so neither
the desktop app nor the CLI ever holds a token.

The desktop app's auth daemon keeps one WebSocket to the server
(`/api/agent/sign-in`). For an `auth-daemon` sign-in the server sends it
`listen` with the authorize URL, the daemon binds the port that URL's
`redirect_uri` names and says it is `listening`, then reports the code it
catches (wire format in `@yaac/shared/auth-agent-protocol`). The start
answers only once the daemon is listening, so the SPA opens the page at once
knowing the redirect has somewhere to land. The SPA knows it runs in the desktop
app, and so on the daemon's machine, so it asks for this mode only there.
A phone asking for it while the desktop app runs on a laptop would send its
browser to its own loopback, where nothing listens.

A sign-in never strands on a missing listener: when the user has no daemon
connected, when the daemon cannot bind (another program holds Codex's port
1455) or does not answer within a few seconds, or when it disconnects
mid-flow, the server carries the same flow on in manual mode. The CLI does the same for itself, restarting the flow
without a callback when it cannot bind.

## Limits

- The vendors' authorize parameters, scopes and endpoints are copied from
  their CLIs and are not documented APIs. When a vendor changes them,
  sign-in fails with the vendor's error until `claude-oauth.ts` or
  `codex-oauth.ts` follows.
- Codex refuses device codes for an account that has them turned off in
  ChatGPT's security settings, so a manual Codex sign-in fails there; the
  error says so, and a loopback sign-in still works.
- Flows live in the server's memory for 15 minutes, so a server restart
  ends any in progress. A flow does not depend on a client watching it:
  the user is on the vendor's page while it runs, where a hidden tab or a
  suspended iPhone app stops polling. The SPA cancels a running flow when
  its panel closes and the CLI on Ctrl-C; one whose client vanished
  outright runs out its 15 minutes.

## Tests

`YAAC_E2E_VENDOR_OAUTH_ORIGIN` moves every vendor URL the flows dial onto
the fake vendor in `packages/test-utils/src/fake-vendor-oauth.ts`, whose
authorize pages approve at once. It issues each code from the authorize
URL's challenge and accepts it only with the matching verifier, so the
tests prove the server's PKCE pairing rather than just its plumbing.
