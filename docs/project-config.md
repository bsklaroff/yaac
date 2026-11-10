# Project configuration

A project's settings are stored on the server, so a client on another
machine edits them as well as one beside it. Each is a section under Settings
→ Project Config and a `yaac config <setting> <project>` command, which
prints the setting given no value and replaces it given one (docs/cli.md);
`yaac config show <project>` prints them all. They apply to workspaces
created afterwards unless a section says otherwise.

## Forwarded ports

`yaac config port-forwards <project> [ports...]`, each port `3000` or
`3000:8080` (container port, then the host port to start from). Each port is
offered at a host port from its start up, bound on a client by the desktop
app or `yaac forward` ([port-forward-tunnel.md](port-forward-tunnel.md)). The
app also offers to forward ports it sees a workspace listening on
([auto-forward-ports.md](auto-forward-ports.md)). Each workspace gets
`YAAC_PORT_<port>`, the port its dev server should bind: the container port
under k8s, and under containerless a port of its own from the host start up,
since workspaces there share the host's ports. So start the dev server with
it (`pnpm dev --port $YAAC_PORT_3000`). Each port is also served at
`http://<port>.<workspace id prefix>.localhost:<port>/`
([workspace-hostnames.md](workspace-hostnames.md)). yaac's own in-workspace
ports, 10250-10350, are refused.

## Pod settings (k8s)

A containerless server refuses these, since its workspaces run on the host.

- **Cache volumes:** `yaac config cache-volumes <project> [name=/path...]`.
  Named directories that persist across workspaces, stored at
  `global/projects/<project id>/cache-volumes/<name>` and mounted at the
  absolute path given. There is no way to mount a host directory into a
  workspace, since a client on another machine can't name a path on the
  server: use a cache volume, or bake the files into the image.
- **Nested containers:** `yaac config nested-containers <project> [on|off]`.
  Runs a container engine inside the workspace so `docker build`, `docker
  run` and `docker compose` work; see
  [nested-containers.md](nested-containers.md).
- **npm cache:** `yaac config npm-cache <project> [on|off]`, on by default.
  Off, pnpm goes to npmjs through the proxy. A project's own `.npmrc`
  `registry=` wins either way.

## Init steps

What every workspace runs when it starts (install, build, start the dev
server) is the project's init steps: a graph of named steps, each a list of
commands run in a tmux window of its own after the steps it `needs`, with
long-running ones as services. Edit them under Settings → Project Config →
Init steps, or with `yaac config init-steps <project> --file <path>`. See [workspace-steps.md](workspace-steps.md).

## Scratch directories

A project's scratch directories are dirs of installed packages and build
output, relative to the checkout, that each workspace keeps off the shared
checkout and empties when it stops
([workspace-storage.md](workspace-storage.md) "Package installs"). Each has a
cap: under k8s a write past it fails, and under containerless it is not
enforced. A dir names its own cap or gets the default, 16 GiB, which a large
cargo build can pass. The default dirs are `node_modules` and `target`. Edit
them under Settings → Project Config, or with
`yaac config scratch-dirs <project> [dirs...]`, each dir `path` or `path:GiB`
(`--none` for none). The webapp's file explorer hides them like ignored
folders unless one holds a file git would list ([file-editor.md](file-editor.md)).

A stop empties a scratch directory even where git tracks files in it: they
stay in git history, and `git checkout` brings them back, but after a
restart they show as deleted, and committing that deletes them from the
branch. Under k8s they show as deleted while the workspace runs too, hidden
by the dir's volume. So when a workspace starts, the server checks its base
branch, and its own branch once pushed, for scratch directories git tracks,
and the workspace bar warns about any it finds, with two answers. One keeps
the dir in the checkout: it comes off the project's list and off the list
this workspace started with, so the stop of the restart that follows leaves
the dir as it is, and the workspace comes back with it in its checkout.
Under k8s that is the dir as checked out beneath the volume; what was
written into the volume is gone. The other stops warning about the dir in
this project. Settings lists the ones not warned about, each of which can be
warned about again.

## Environment variables and secrets

Set them under Settings → Project Config →
Environment, or with `yaac config env <project>` (`NAME=value` for a variable,
`--secret NAME` with its rule as options and its value on stdin). A plain variable is placed in every workspace's environment. A
secret is stored encrypted. Under k8s its value never enters the workspace:
the workspace gets a placeholder, and the proxy swaps in the real value on
requests matching the rule you give (hosts, an optional path glob, and where
it goes: a header, `authorization` with a `Bearer ` prefix by default, or a
form/JSON body field). Under containerless the real value goes into the
environment. GitHub access comes from the project's HTTPS git credential, so
you don't need a `GITHUB_TOKEN` secret.

### Run secrets

A **run secret** is a value a workspace needs as it is, under k8s too: a
key it signs with, say, which no proxy swap can stand in for. Run secrets
are kept apart from the secrets above (`project_run_secrets`), encrypted
the same way, and reach a workspace only through a named workflow that
names them, on a commit a person ran it on
(docs/workflows.md). An interactive workspace never gets one. Only a person
sets them, under Settings → Project Config → Run secrets or with `yaac
config env <project> NAME --run-secret`, the value on stdin (`--unset NAME`
removes one); `yaac-mama` has no verb for them.

Under k8s a workspace that gets one mounts nothing the project's other
workspaces write, as a release does (docs/public-sites.md "Sites and
releases"): no tool home, memory or cache volume an agent could have
planted code in. What it prints still lands in its step logs, which the
project's agents read with `yaac-mama logs`, so a step must not echo one.
Under containerless an agent runs as you and can read a run secret as it
can every other secret, so there the split keeps values out of interactive
workspaces' environments but is no boundary.

Under k8s the values sit in the Secret `yaac-run-secrets-<project>`, one key
per name, which the server rewrites whenever it launches a workspace that
gets one and when one is removed; the pod reads the ones it is given by
`secretKeyRef`, so no value is written into its Job. The proxy is not given
that Secret (its Role could read it, as it can every Secret in the
namespace), and the hosts the workspace reaches with it need no rule, so
they are tunneled untouched. Under containerless they are ordinary
environment entries.

## Icon

The picture a project's chip shows in the rail (and the mobile projects
list) instead of its initial. It is set only from the webapp: paste or drop
an image on the preview chip, or choose a file, then place it in the crop
dialog (drag to move, slider or scroll wheel to zoom). The browser draws the
chosen square to a 256px PNG and uploads that; removing the icon returns the
chip to the initial.

Every image, SVG included, is drawn to a canvas before upload, and the
server stores only PNG, JPEG, GIF or WebP (up to 512 KB, in the
`project_icons` table), refusing SVG. An SVG can carry script: inside an
`<img>` it never runs, but a stored SVG served from yaac's origin would run
it in that origin if its URL were opened directly. The server serves the
icon at `GET /api/project/:id/icon`; the snapshot names it by a hash of its
bytes, which the image URL carries, so the browser caches it until it
changes.

## Kept ignored files

Stopping a workspace deletes every file the repository's `.gitignore`
matches, not only build output: `.env` files, local databases, editor and
agent settings, and any new file in an ignored folder. Files git lists as
untracked stay. Under Settings
→ Project Config → Kept ignored files, or with `yaac config
kept-ignored-paths <project> [paths...]`, list paths relative to the
repository root to keep anyway, each a file or a folder and everything in
it (`.env`, `data/dev.db`). Changes apply from the next stop. See
[workspace-storage.md](workspace-storage.md) "Ignored files at stop".

## Egress allowlist (k8s)

Set it under Settings → Project Config →
Egress allowlist, with `yaac config egress-allowlist <project> [hosts...]
[--defaults on|off]`, or allow a blocked host for the whole project from a
workspace's blocked-hosts badge. A workspace may reach the proxy's default
hosts (`DEFAULT_ALLOWED_HOSTS` in `packages/server/src/lib/allowed-hosts.ts`)
plus the hosts you add: exact names (`api.example.com`) or wildcards
(`*.example.com`, or `*` inside a label as in `store*.example.com`, which
matches letters, digits, `-` and `_` within that one label); `*` allows
everything. Turning the defaults off leaves only your hosts, so an empty list
blocks all external access; `yaac config egress-allowlist` warns if that leaves out
`api.anthropic.com` or `github.com`. Changes apply to workspaces created afterwards.
See [workspace-egress.md](workspace-egress.md).

## Custom images (k8s)

The default workspace image is Ubuntu 26.04 with Node.js, gh, tmux, the agent
CLIs, and pnpm 12 through corepack (a project's own `packageManager` pin wins).
Two files customize it:

- **`Dockerfile.yaac`** (per project: Settings → Project Config → Dockerfile,
  or `yaac config dockerfile <project> --file <path>`, `-` for stdin).
  - **Layered (recommended):** built on top of the default image. It must
    start with:
    ```dockerfile
    ARG BASE_IMAGE
    FROM ${BASE_IMAGE}
    ```
  - **Standalone:** any other `FROM` replaces the default image entirely. You
    must then install the agent CLIs yourself and set up the user as
    [arbitrary-uid-images.md](arbitrary-uid-images.md) describes. Its `tar`
    is its own: a GNU tar that extracts through `openat2` (Ubuntu's from
    26.04) cannot unpack nested paths in a pod, since gVisor lacks that call.
- **`Dockerfile.user`** (yours, Settings → User Dockerfile or
  `yaac config user-dockerfile --file <path>`): applied last, on top of the image of
  every project you own, for things like editor or shell config. It must use the
  same `ARG BASE_IMAGE` / `FROM ${BASE_IMAGE}` header.

Build order: default, then the agent CLI layer (`Dockerfile.tools`), then
`Dockerfile.nestable` (only with nested containers on), then a layered
`Dockerfile.yaac`, then `Dockerfile.user`. A standalone `Dockerfile.yaac`
replaces the first three.

The pod may run as a uid other than the image's `yaac` user (uid 1000,
primary group 0), and reaches the image's files through group 0. So every
step that writes under `/home/yaac` needs `umask 002`, and ownership is
`yaac:0`, never `yaac:yaac` (there is no `yaac` group):

```dockerfile
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
RUN umask 002 && npm install -g my-tool
```

Without the umask the step works on a Linux host with uid 1000 and fails with
`Permission denied` elsewhere. If a standalone image sets its own
`ENTRYPOINT`, the entrypoint must not rely on the `yaac` user's passwd entry:
yaac fixes that entry from the pod's postStart hook, which may run after the
entrypoint starts, so `sudo`, `ssh` or `os.userInfo()` there can see the old
one. See
[arbitrary-uid-images.md](arbitrary-uid-images.md).

The default image's `tar` is a wrapper (`/usr/local/bin/tar`): an extraction
using only options bsdtar shares (`-xzf`, `-C`, `--strip-components`, …) runs
bsdtar, because GNU tar cannot unpack nested paths under gVisor, and any
other call runs GNU tar (`/usr/bin/tar`). So an extraction with a GNU-only
option such as `--wildcards` still fails in a pod, and in a `Dockerfile.yaac`
or `Dockerfile.user` step, which builds in a gVisor pod
([trust-split-builds.md](trust-split-builds.md)). Drop the option (bsdtar
globs member names anyway) or call `bsdtar` directly.
