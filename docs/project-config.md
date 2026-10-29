# Project configuration

Each project has a `yaac-config.json` and, under k8s, an optional
`Dockerfile.yaac`. Edit them in the app under Settings → Project Config, or
with `yaac config edit <project>` and `yaac config edit-dockerfile <project>`.
Both are stored on the server, so this works against a remote server too.

## yaac-config.json

```json
{
  "cacheVolumes": { "pip-cache": "/home/yaac/.cache/pip" },
  "initCommands": ["pnpm install"],
  "portForward": [{ "containerPort": 3000, "hostPortStart": 3000 }],
  "hideInitPane": false
}
```

- **initCommands:** commands run in every workspace after it starts. Two forms,
  which can't be mixed:
  - A list of strings, chained with `&&` in one tmux window named `init`.
  - A list of `{ "name", "commands", "hidePane"? }` objects, each in its own
    tmux window, so several long-running processes (a backend and a frontend
    dev server, say) run side by side. Windows run independently, so repeat
    shared setup such as `pnpm install` in each. Names must not be an agent
    tool's name, `init` or `yaac`.
- **hideInitPane:** close init windows when their commands finish (default
  `false`, which keeps them open to inspect the output).
- **portForward:** ports to forward from every workspace. Each entry maps a
  `containerPort` to a host port chosen from `hostPortStart` up. The ports are
  bound on a client, by the desktop app or `yaac forward`
  ([port-forward-tunnel.md](port-forward-tunnel.md)). The app also offers to
  forward ports it sees a workspace listening on
  ([auto-forward-ports.md](auto-forward-ports.md)).
- **cacheVolumes:** named directories that persist across workspaces. Keys
  are names (stored at `global/projects/<project id>/cache-volumes/<name>`),
  values are absolute paths in the workspace.
- **nestedContainers:** run a container engine inside the workspace so
  `docker build`, `docker run` and `docker compose` work. k8s only; see
  [nested-containers.md](nested-containers.md).
- **npmCache:** whether workspaces use the install's npm cache (k8s only;
  default `true`). With `false`, pnpm goes to npmjs through the proxy. A
  project's own `.npmrc` `registry=` wins either way.
A field not listed here is an error: saving the file refuses it, and so does
every create while it is there, rather than ignoring a misspelt key.

There is no way to mount a host directory into a workspace, since a client on
another machine can't name a path on the server. Use `cacheVolumes`, or bake
the files into the image.

## Scratch directories

A project's scratch directories are dirs of installed packages and build
output, relative to the checkout, that each workspace keeps off the shared
checkout and empties when it stops
([workspace-storage.md](workspace-storage.md) "Package installs"). Each has a
cap: under k8s a write past it fails, and under containerless it is not
enforced. A dir names its own cap or gets the default, 16 GiB, which a large
cargo build can pass. The default dirs are `node_modules` and `target`. They
are a project setting stored on the server rather than a `yaac-config.json`
key: edit them under Settings → Project Config, or with
`yaac config scratch-dirs <project> [dirs...]`, each dir `path` or `path:GiB`
(`--none` for none).

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

These are not in `yaac-config.json`. Set them under Settings → Project Config →
Environment. A plain variable is placed in every workspace's environment. A
secret is stored encrypted. Under k8s its value never enters the workspace:
the workspace gets a placeholder, and the proxy swaps in the real value on
requests matching the rule you give (hosts, an optional path glob, and where
it goes: a header, `authorization` with a `Bearer ` prefix by default, or a
form/JSON body field). Under containerless the real value goes into the
environment. GitHub access comes from the project's HTTPS git credential, so
you don't need a `GITHUB_TOKEN` secret.

## Kept ignored files

Stopping a workspace deletes every file the repository's `.gitignore`
matches, not only build output: `.env` files, local databases, editor and
agent settings, and any new file in an ignored folder. Files git lists as
untracked stay. Also not in `yaac-config.json`: under Settings
→ Project Config → Kept ignored files, list paths relative to the
repository root to keep anyway, each a file or a folder and everything in
it (`.env`, `data/dev.db`). Changes apply from the next stop. See
[workspace-storage.md](workspace-storage.md) "Ignored files at stop".

## Egress allowlist (k8s)

Also not in `yaac-config.json`: set it under Settings → Project Config →
Egress allowlist, or allow a blocked host for the whole project from a
workspace's blocked-hosts badge. A workspace may reach the proxy's default
hosts (`DEFAULT_ALLOWED_HOSTS` in `packages/server/src/lib/allowed-hosts.ts`)
plus the hosts you add: exact names (`api.example.com`) or wildcards
(`*.example.com`, or `*` inside a label as in `store*.example.com`, which
matches letters, digits, `-` and `_` within that one label); `*` allows
everything. Turning the defaults off leaves only your hosts, so an empty list
blocks all external access; yaac warns if that leaves out `api.anthropic.com`
or `github.com`. Changes apply to workspaces created afterwards.
See [workspace-egress.md](workspace-egress.md).

## Custom images (k8s)

The default workspace image is Ubuntu 26.04 with Node.js, gh, tmux, the agent
CLIs, and pnpm 12 through corepack (a project's own `packageManager` pin wins).
Two files customize it:

- **`Dockerfile.yaac`** (per project).
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
  `yaac config edit-user-dockerfile`): applied last, on top of the image of
  every project you own, for things like editor or shell config. It must use the
  same `ARG BASE_IMAGE` / `FROM ${BASE_IMAGE}` header.

Build order: default, then the agent CLI layer (`Dockerfile.tools`), then
`Dockerfile.nestable` (only with `nestedContainers`), then a layered
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
