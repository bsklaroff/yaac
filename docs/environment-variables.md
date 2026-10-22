# Environment variables

All yaac variables are read, with their defaults and validation, in
`packages/shared/src/env.ts`. The ones you might set:

| Variable | Default | Description |
|----------|---------|-------------|
| `YAAC_DATA_DIR` | `~/.yaac-server` | Data directory. Client state goes in the sibling `<dir>-client`. Unset, the host server uses `~/.yaac-server`, a cluster install (`yaac cluster …`) `~/.yaac-cluster`, and clients `~/.yaac-client`; set, every command uses this one dir. |
| `YAAC_SERVER_PORT` | `8787` | Port the server listens on at `127.0.0.1` (the next free one if taken; `0` for any). Under k8s it is fixed when kind creates the cluster, `8790` by default; the host server skips 8790 when it increments. One exported value applies to both installs, so set it per command when you run both. |
| `YAAC_SERVER_URL` | _(unset)_ | Server to use, overriding the selection in `server.json`. |
| `YAAC_SECRET` / `YAAC_SECRETS` | _(unset)_ | Encryption key(s) for stored secrets (below). |
| `YAAC_USE_TOR` | `false` | Route the server's git and ssh through Tor, and under k8s every workspace's egress too. Off when unset, empty, `0` or `false`. |
| `YAAC_HOST_TOR_SOCKS_URL` | `socks5h://127.0.0.1:9050` | Tor SOCKS endpoint. |
| `YAAC_KIND_CLUSTER` | `yaac` | Name of the kind cluster `yaac cluster install` manages. |
| `YAAC_PREWARM_POOL_SIZE` | `1` | Workspaces kept started ahead of time per active project (`0` disables). |
| `YAAC_WORKSPACE_RETENTION_DAYS` | _(unset)_ | Delete a workspace once it has been stopped this many days, checkout and history included (unset or `0` never does). Checked at server start and then hourly. A project's `stoppedWorkspaceRetentionDays` overrides it. For a cluster's server, export it before `yaac cluster install`, which copies it into the server pod. |
| `YAAC_IMAGE_PREWARM` | on | Build project images in the background. Off when empty, `0` or `false`. |
| `YAAC_AUTO_TITLES` | on | Generate titles with a local model for drafts, queued entries and workspaces whose agent titles nothing (docs/workspace-titles.md). Off when empty, `0` or `false`. |
| `EDITOR` / `VISUAL` | `vi` | Editor for `yaac config edit*` (`$EDITOR`, then `$VISUAL`, then `vi`). |

Every workspace gets `YAAC_WORKSPACE_ID` set automatically. The other variables
in `env.ts` are set by the build, the server's own Deployment, or the test
harness.

## Secret key

Every secret the server stores (project secrets, git HTTPS tokens, the SSH
private keys yaac generates) is encrypted in its database with
[better-auth](https://better-auth.com)'s `symmetricEncrypt`: XChaCha20-Poly1305
with a random nonce per value, keyed by the SHA-256 of a secret string, in a
versioned envelope so keys can be rotated without re-encrypting.

By default the server generates its key at `~/.yaac-server/server-local/secret.key`
(mode 0600). **Back it up with the data dir.** A server that finds no key
file and neither variable set, while its database already holds encrypted
rows, does not generate a new key: it refuses to start, and answers `/health`
with the key path and these variables, until the key is restored or
configured. If the key is lost for good, write a new one to give up the stored
secrets (`openssl rand -base64 32 > ~/.yaac-server/server-local/secret.key`):
the server then starts, and every stored secret reads as unreadable and must
be entered again. To keep it elsewhere, set
`YAAC_SECRET`, or `YAAC_SECRETS` for a versioned set (`"<version>:<secret>,…"`,
newest first):

```sh
# Rotate: the new key first, then the old one so existing values still open.
export YAAC_SECRETS="1:$(openssl rand -base64 32),0:$(cat ~/.yaac-server/server-local/secret.key)"
```
