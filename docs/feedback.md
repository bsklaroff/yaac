# Feedback

The feedback button at the top of the rail's bottom icons (a row on the
mobile projects screen) opens a form. Send posts its message, any
screenshots pasted, dropped or picked into it, and what the webapp knows
about itself to the user's own yaac server (`POST /api/feedback`). The
server forwards all of it to the endpoint named by `YAAC_FEEDBACK_URL`.
`yaac feedback <message> [--image <file>…]` sends the same report from the
CLI and prints the host it went to. Its images go unshrunk, so a large
screenshot can exceed the cap. A report goes out only when the user sends
it. Nothing else is sent anywhere.

The variable is read from the server's own environment. A host server
inherits it from the shell that runs `yaac server start`. A cluster's server
pod gets it from the shell that runs `yaac cluster install`, which copies it
into the Deployment, so changing it means running install again. If the
variable is unset or not a URL, the snapshot's `feedbackHost` is null, the
webapp hides the form, and the route answers `NOT_SUPPORTED`. Otherwise the
form names that host. The endpoint is whatever the server's operator set,
and under tailnet access that may not be the person sending.

The server posts to that URL alone. A redirect fails the send rather than
being followed, so a report never reaches a host the user was not shown.
An endpoint that cannot be reached, or answers anything but 2xx, fails it
too. The user sees the status code but never the endpoint's response body.

The server forwards the message rather than the browser sending it, for
two reasons:

- The webapp's CSP keeps `connect-src 'self'`.
- The request can be signed with a key no client holds.

## What the endpoint receives

```
POST <YAAC_FEEDBACK_URL>
Content-Type: application/json
X-Yaac-Key: <base64url raw Ed25519 public key, 32 bytes>
X-Yaac-Signature: <base64url Ed25519 signature over the raw body bytes>

{
  "message": "…",                    // 1–10,000 characters, trimmed
  "images": [{ "mimeType": "image/png", "data": "<base64>" }],
  "sentAt": "2026-11-03T12:00:00.000Z",
  "from": { "source": "tailscale" | "git", "email": "…", "name": "…" } | null,
  "server": {
    "version": "0.1.2" | null,
    "gitCommit": "<sha>" | "<sha>-dirty" | null,
    "buildId": "<content hash of the server's build>",
    "driver": "k8s" | "containerless"
  },
  "client": {
    "version": … | null,
    "gitCommit": … | null,
    "userAgent": "…",
    "app": { "kind": "desktop" | "ios", "version": …, "build": …, "gitCommit": … } | null
  } | null
}
```

`server` is the build that forwarded the report. `client` is the webapp or
CLI build that sent it. Its user agent is the browser's for the webapp
(which names Electron for the desktop app) and starts with `yaac-cli` for
the CLI.

`client.app` is the native app around the webapp, which describes itself
on its bridge (`window.yaacWindow.app`). The desktop app gives the version
and commit its bundle was built from, stamped the same way. The iPhone app
gives its Info.plist's version and build number, and the commit its scheme's
pre-action stamps into it (ios/README.md). A browser or the CLI sends
`null`. A field the app leaves out is `null`.

The webapp's stamp and the server's usually match, since the server serves
the webapp. A client older than the server means a tab left open across an
upgrade. A different commit can also mean the webapp came from a dev Vite
server, or from a build that reused an earlier webapp build. The
`pnpm watch` loop (`scripts/build-frontend-if-changed.ts`) and the e2e
tiers' bundle rebuild the webapp only when its own sources change, so after
a commit that leaves it alone the webapp keeps the older commit while the
server takes the new one.

The build stamps `version` (the root `package.json`) and `gitCommit` (the
checkout's `HEAD`) into the CLI bundle and the webapp (`buildStamp`).
`gitCommit` ends in `-dirty` when tracked files had uncommitted changes. A
tree that is not the top level of a git checkout gets no commit. Code run
from source has no stamp and reports `null`. Because the commit is
part of the bundle, a cluster's server image is rebuilt for every new
commit, since its tag hashes the bundle.

`images` may be empty. The webapp shrinks each image the way it does for a
chat message (docs/agent-modes.md, "Images"). The server types it by its
bytes (PNG, JPEG, GIF or WebP) and refuses the whole report if any is not
one of those or if they total over 5 MB, so the endpoint never receives a
partial report.

The endpoint's own API is not written yet. Until it is, this is the request
shape the server sends, and the recipient should accept it as is.

`from` is the caller's tailnet login and display name when the request came
through `tailscale serve`. Otherwise it is the git identity that user's
workspaces commit as (Settings → General → Git identity), or `null` if they
have not set one.

## What the signature proves

Each install generates an Ed25519 key pair the first time it sends feedback,
and keeps the private half in SERVER-LOCAL `feedback.key` (mode 0600). The
signature proves that a submission comes from the same install as earlier
ones with that key. It does not prove the install is genuine yaac: the code
is open source, so anyone can make a key. Nor does it prove the `from`
identity: the install vouches for that, and a local caller can set any git
identity, and the client reports `client` about itself. Treat `from` and
`client` as claims made by the install the key names.

The endpoint should, in this order:

1. Cap the body before reading or verifying it. A well-formed report is at
   most about 7 MB, so a forged flood cannot exhaust the endpoint.
2. Verify `X-Yaac-Signature` over the exact body bytes with `X-Yaac-Key`.
3. Reject a `sentAt` more than a few minutes from its own clock. Reject a
   hash of key plus body it has already seen, keeping those hashes for at
   least that window, so a captured request cannot be replayed. Ed25519
   signatures are deterministic, so this matches deduping on the signature
   for honest senders without relying on the verifier to reject malleable
   ones.
4. Record each key the first time it sees it, and rate-limit or block per
   key, with a global cap on new keys, since a key costs nothing to make.
   Every user of an install shares its key.

Treat `images` as untrusted bytes. The server checks only their leading
magic bytes, which a polyglot (a PNG signature followed by HTML) passes.
Serve them with a fixed `Content-Type`, `X-Content-Type-Options: nosniff`
and `Content-Disposition: attachment`, or re-encode them. Never show them
inline on an origin that matters.

Losing `feedback.key` only gives the install a new key, which the endpoint
sees as a new install. So the server replaces a key file that does not
parse with a new key, and logs that it did, rather than failing every
send.
