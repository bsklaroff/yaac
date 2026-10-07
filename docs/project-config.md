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
  "addAllowedUrls": ["internal.corp.example.com", "*.mycdn.example.com"],
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
- **addAllowedUrls:** hosts to allow in addition to the proxy's default
  allowlist (`DEFAULT_ALLOWED_HOSTS` in `packages/server/src/lib/allowed-hosts.ts`).
  Exact names (`api.example.com`) or wildcards (`*.example.com`). k8s only; see
  [workspace-egress.md](workspace-egress.md).
- **setAllowedUrls:** replace the default allowlist entirely. Can't be combined
  with `addAllowedUrls`. `["*"]` allows everything; `[]` blocks all external
  access. yaac warns if the list leaves out `api.anthropic.com` or
  `github.com`.
- **nestedContainers:** run a container engine inside the workspace so
  `docker build`, `docker run` and `docker compose` work. k8s only; see
  [nested-containers.md](nested-containers.md).
- **npmCache:** whether workspaces use the install's npm cache (k8s only;
  default `true`). With `false`, pnpm goes to npmjs through the proxy. A
  project's own `.npmrc` `registry=` wins either way.
- **ephemeralModulesPaths:** dependency directories (relative to the checkout)
  that live with the workspace's runtime instead of the shared checkout, and
  are removed at stop. Default `["node_modules"]`; `[]` turns it off.

There is no way to mount a host directory into a workspace, since a client on
another machine can't name a path on the server. Use `cacheVolumes`, or bake
the files into the image.

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

## Custom images (k8s)

The default workspace image is Ubuntu 26.04 with Node.js, gh, tmux and the
agent CLIs. Two files customize it:

- **`Dockerfile.yaac`** (per project).
  - **Layered (recommended):** built on top of the default image. It must
    start with:
    ```dockerfile
    ARG BASE_IMAGE
    FROM ${BASE_IMAGE}
    ```
  - **Standalone:** any other `FROM` replaces the default image entirely. You
    must then install the agent CLIs yourself and set up the user as
    [arbitrary-uid-images.md](arbitrary-uid-images.md) describes.
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
