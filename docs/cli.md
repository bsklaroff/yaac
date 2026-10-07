# CLI reference

`yaac <command> --help` shows every option. A `<workspace-id>` can be a unique
prefix of the id. A `<project>` can be the project's name, its id, or a unique
prefix of the id; `yaac project list` shows both. Names need not be unique
(adding a remote twice makes two projects), so a shared name is refused with
the candidates' ids.

```
yaac server                     The yaac server the CLI and web app talk to
  start | stop | restart        Under k8s these scale or roll the in-cluster server
  run [-p <port>]               Run in the foreground (what `start` runs)
  logs [-f] [-n <lines>]        Print the server log

yaac cluster                    The Kubernetes cluster (k8s driver only)
  check                         Verify prerequisites and wiring
  install                       Create or converge the cluster, images and server.
                                Safe to re-run; never destructive
    --nodes <count>             kind nodes to create (default 1, max 5;
                                ignored if the cluster exists)
    --tailnet                   Publish the server on your tailnet via the
                                Tailscale Kubernetes operator
    --byo                       Install into the cluster your kubeconfig points
                                at instead of creating one (published on the tailnet)
    --rwx-storage-class <name>  With --byo (required): NFS-family class for the
                                shared claim
    --rwo-storage-class <name>  With --byo: class for the server's own claim
                                (default: the cluster's default class)
  delete [-y]                   Delete the kind cluster and its registry; keeps
                                workspaces' checkouts. Refused on a --byo install

yaac host check                 Verify this machine can run containerless workspaces

yaac project
  list
  add <remote-url> <credential> Clone a project (HTTPS or git@host:path) with the
                                named git credential (see `yaac auth list`)

yaac workspace
  create <project>              Create a workspace and attach to its agent
    -t, --tool <tool>           claude, codex, opencode or pi (default: the
                                project's last, else claude)
    -b, --branch <branch>       Base branch (default: the remote's default)
    -p, --prompt <text>         Initial prompt for the agent
    -m, --model <model>         Model id or alias (provider/model for opencode, pi)
    --mode <tui|acp>            Terminal UI, or chat pane over ACP
                                (agent-modes.md)
    --permission-mode <mode>    bypass, auto, accept-edits, manual, plan or
                                read-only (permission-modes.md)
    -g, --group <group>         File it under a sidebar group (created if new)
  list [project]                List running workspaces
    -s, --stopped               List stopped ones instead
    -n, --num <n>               With -s, show at most n (default 25)
    -a, --all                   With -s, show all
  rename <workspace-id> <title>
  stop <workspace-id>           Tear down the runtime; keep the checkout and diff
  restart <workspace-id>        Restart, resuming the agents that were running
  agents <workspace-id>         List the workspace's agent sessions
  attach <workspace-id>         Attach to the workspace's tmux session
  shell <workspace-id>          Open a shell in the workspace
  monitor [project]             Live table of running workspaces
    -n, --interval <seconds>    Refresh interval (default 5)

yaac group                      Named sidebar groups of workspaces
  create <project> <name>
  list [project]
  move <workspace-id> [group]   Omit the group to ungroup
    --project <project>         Required for a stopped workspace
  delete <project> <group>      Its workspaces return to the default list

yaac forward [workspace-id]     Bind a workspace's forwarded ports here (all
                                running workspaces if omitted); runs until stopped
  -p, --port <container[:host]> Forward this port instead (repeatable)
  -b, --bind <address>          Address to bind (default 127.0.0.1)

yaac config
  edit <project>                Edit the project's yaac-config.json in $EDITOR
  edit-dockerfile <project>     Edit the project's Dockerfile.yaac
  edit-user-dockerfile          Edit the global Dockerfile.user
  git-identity                  Show the git identity workspaces commit as
    --name <name> --email <email>  Set it

yaac auth
  list                          List credentials (masked; git credentials by name)
  update                        Add a git credential or sign in an agent tool
  clear                         Remove stored tool credentials
  fake <kinds...>               Seed placeholder credentials for yaac-in-yaac:
                                claude-oauth, opencode-openrouter, pi-openrouter, github
  server start|stop|status|run  The login broker that runs Claude/Codex
                                sign-ins on this machine

yaac remote                     Which server this machine's clients use
  set <url>                     Select a server (checks it identifies this device)
  off | on                      Deselect / reselect it without forgetting it
  unset                         Forget every saved server
  status                        Show the selected server and saved ones
```

In a workspace's tmux session: `Ctrl-B D` detaches, `Ctrl-B C` opens a new
shell, `Ctrl-B N` / `Ctrl-B P` switch windows, and `Ctrl-B k` stops the
workspace after a confirmation.
