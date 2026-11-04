# CLI reference

`yaac <command> --help` shows every option. A `<workspace-id>` can be a unique
prefix of the id. A `<project>` can be the project's name, its id, or a unique
prefix of the id; `yaac project list` shows both. Names need not be unique
(adding a remote twice makes two projects), so a shared name is refused with
the candidates' ids.

## Whose projects

On an install with several users (docs/multi-user.md), a project's name or
id prefix means one of your own projects, and `project list`, `workspace
list` and `group list` show only yours. The global `--user <user>` (a login,
display name or user id, before or after the command) points all of that at
a teammate's projects instead: `yaac workspace list --user ada@example.com`.
A full project id names anyone's project either way. The CLI resolves the
project itself and sends the server its id, so two users each holding a
project of the same name (a hosted project and its share,
docs/hosted-projects.md) never collide. Workspace ids are unaffected.

```
yaac --user <user> <command>    Mean this user's projects rather than your own

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
    --site-domain <domain>      A domain public sites' hostnames may use
                                (repeatable); the Cloudflare tunnel's token
                                comes from CF_TUNNEL_TOKEN (public-sites.md)
  delete [-y]                   Delete the kind cluster and its registry; keeps
                                workspaces' checkouts. Refused on a --byo install

yaac host check                 Verify this machine can run containerless workspaces

yaac project
  list                          Your projects (or --user's)
  add <remote-url> <credential> Clone a project (HTTPS or git@host:path) with the
                                named git credential (see `yaac auth list`)
  create <name>                 Create an empty project whose git remote yaac
                                hosts (docs/hosted-projects.md)
  clone <project> [dir]         Clone a hosted project's remote to this machine

yaac workspace
  create [project]              Create a workspace and attach to its session
    -w, --workspace <id>        Open the session in this running workspace
                                instead (no project, and none of the workspace
                                options: --branch, --group, --timeout, --start-*)
    --resume <conversation>     With --workspace: on one of its conversations
    --no-session                A workspace with no agent session
    --non-interactive           Run --steps untouched, with no session, and
                                stop when they finish: a CI run. Only stop
                                touches it; rerun, never restart
                                (workspace-steps.md)
    --wait                      With --non-interactive: wait for its steps,
                                exiting non-zero unless they all succeeded
    --steps <file>              JSON file of the steps to start with, in
                                place of the project's init steps
    --no-steps                  Start with no steps
    -t, --tool <tool>           claude, codex, opencode or pi (default: the
                                project's last, else claude)
    -b, --branch <branch>       Base branch (default: the remote's default)
    --commit <sha>              Start at this full commit instead; no base
                                branch then (not with --branch)
    -p, --prompt <text>         Initial prompt for the agent
    -m, --model <model>         Model id or alias (provider/model for opencode, pi)
    -e, --effort <level>        Effort level the model offers (effort-levels.md)
    --mode <tui|acp>            Terminal UI, or chat pane over ACP
                                (agent-modes.md)
    --permission-mode <mode>    bypass, auto, accept-edits, manual, plan or
                                read-only (permission-modes.md)
    -g, --group <group>         File it under a sidebar group (created if new)
    --timeout <duration>        Stop it this long after it starts (45m, 2h,
                                1h30m; whole minutes; routines.md)
    --start-at <time>           Queue it for HH:MM, YYYY-MM-DD HH:MM or ISO 8601,
                                read in your yaac time zone (needs --prompt)
    --start-in <duration>       Queue it to start this long from now
  list [project]                List running workspaces of your projects, then
                                those scheduled for later
    -s, --stopped               List stopped ones instead
    -n, --num <n>               With -s, show at most n (default 25)
    -a, --all                   With -s, show all
  rename <workspace-id> <title>
  stop <workspace-id>           Tear down the runtime; keep the checkout and diff
    --session                   <id> names a session: close only it (sessions.md)
  delete <workspace-id>         Delete a stopped workspace's checkout and history,
                                or discard a queued one
    -y, --yes                   Without the confirmation prompt
  restart <workspace-id>        Restart, resuming the sessions it had open
    --timeout <duration>        Stop it this long after the restart (a restart
                                otherwise clears its timeout)
  rerun <workspace-id>          Run a non-interactive workspace's steps again in
                                a new one, at the commit it ran at
    --interactive               An interactive workspace there instead, to
                                reproduce a failure in
    --wait                      As for workspace create
  step add <workspace-id>       Add a step to a running workspace; prints its name
    --run <command>             A command (repeatable; run in order in one shell)
    --name <name>               Its name (default: run-<8 hex>)
    --needs <a,b>               Steps that must succeed (or be ready) first
    --service [--ready <cmd>]   It keeps running; steps needing it wait for the
                                ready check, if any
  step rerun <workspace-id> <name>
                                Run a finished step again, with the steps it
                                caused to be skipped
  step cancel <workspace-id> <name>
                                Stop an unfinished step; its dependents are skipped
  logs <workspace-id> [window]  List a life's terminal logs, or print one
                                window's (a step's name, or `shell`, …), running
                                or stopped (workspace-steps.md "Logs")
    --life <n|name>             Which life: 1 (the default) is the newest
    --raw                       Keep the terminal escape codes
  timeout <workspace-id> <duration|none>
                                Stop a running workspace this long from now, or never
  conversations <workspace-id>  List the conversations the workspace has held
  attach <workspace-id>         Attach to the workspace's tmux session
    -s, --session <id>          On this session's window (default: its first)
  shell <workspace-id>          Open a shell in the workspace

yaac routine                    Workspaces started on a cron schedule (routines.md)
  create <project>              --name, --cron and --prompt (or
                                --non-interactive with --steps) required
    --name <name>               Heads each run's title; names its default group
    --cron <expr>               5-field cron or a nickname like @daily
    -p, --prompt <text>         Each run's prompt; - reads it from stdin
    --prompt-file <path>        Read the prompt from this file instead
    --tz <zone>                 Zone the cron is read in (default: yours)
    --timeout <duration|next>   Stop each run this long after it starts;
                                next (the default) stops it at the next tick
    -t/-m/-e/-b, --mode, --permission-mode, --commit, --steps, --no-steps,
    --non-interactive           As for workspace create
    -g, --group <group>         Group runs are filed under (default: one named
                                after the routine)
    --no-group                  File runs in the default list
  list [project]                Routines with their next and last runs
  edit <routine-id>             The same options; a new cron or zone takes
                                effect from its next tick
  pause | resume <routine-id>   Resuming does not catch up missed ticks
  run <routine-id>              Start a run now, stopped at the next tick
  delete <routine-id>           Running runs keep going until their stop time

yaac site                       A project's public sites, each served by a
                                locked workspace, its release (cluster servers
                                only; public-sites.md)
  create <project> <name>       --hostname, --port and --steps required; prints
                                what to add to the Cloudflare tunnel
    --hostname <host>           Public hostname, under a --site-domain
    --port <n>                  Port its releases serve on
    --steps <file>              JSON file of the steps each release runs
    --volume <name>             Volume each release mounts (see `yaac volume`)
  edit <project> <name>         The same options; the next deploy uses them
    --no-volume                 Mount no volume
  list <project>                Sites with their live release and last deploy
  show <project> <name>         A site and its recent releases
  deploy <project> <name>       Start a release; once ready the hostname moves
                                to it and the old one stops
    --ref <branch|sha>          What to deploy (default: the default branch)
    --timeout <duration>        Fail unless ready this long after it starts
                                (default 15m)
    --wait                      Wait for it, exiting non-zero unless it succeeded
  stop <project> <name>         Stop the live release; the hostname answers 503
  start <project> <name>        Start a replacement of the last release
  delete <project> <name>       Delete the site and stop its release

yaac volume                     A project's volumes, one running workspace at a
                                time (cluster servers only; workspace-volumes.md)
  create <project> <name>
    --size <size>               Like 10Gi (the default) or 500Mi
  list <project>                Volumes and the workspace each is attached to
  resize <project> <name> <size>
                                Grow a volume; it never shrinks
  delete <project> <name>       Delete it and its data; refused while attached
    -y, --yes                   Without the confirmation prompt

yaac group                      Named sidebar groups of workspaces
  create <project> <name>
  list [project]
  move <workspace-id> [group]   Omit the group to ungroup
    --project <project>         Required for a stopped workspace
  set-limit <project> <group> <limit>
                                Most workspaces running at once, or none
                                (docs/workspace-groups.md)
  delete <project> <group>      Its workspaces return to the default list

yaac forward [workspace-id]     Bind a workspace's forwarded ports here (all
                                running workspaces if omitted), and route their
                                *.localhost names for a remote server
                                (docs/workspace-hostnames.md); runs until stopped
  -p, --port <container[:host]> Forward this port instead (repeatable)
  -b, --bind <address>          Address to bind (default 127.0.0.1)

yaac feedback <message>         Send feedback to the yaac maintainers through
                                the server, as the webapp's form does
                                (docs/feedback.md)
  --image <file>                Attach a screenshot (repeatable)

yaac config
  edit <project>                Edit the project's yaac-config.json in $EDITOR
  edit-dockerfile <project>     Edit the project's Dockerfile.yaac
  edit-user-dockerfile          Edit your Dockerfile.user
  git-identity                  Show the git identity workspaces commit as
    --name <name> --email <email>  Set it
  workspace-auto-delete <project> [days|off]
                                Show or set after how many days the project's
                                stopped workspaces are deleted (setting it asks
                                for confirmation, so it needs a terminal)
  scratch-dirs <project> [dirs...]
                                Show or replace the dirs each workspace keeps
                                off its checkout, each `path` or `path:GiB`
                                (docs/project-config.md)
    --none                      Keep every dir in the checkout
  init-steps <project>          Print the steps every workspace runs at start,
                                as JSON (docs/workspace-steps.md)
    --file <path>               Replace them with a JSON file's
    --none                      Remove them

yaac auth
  list                          List credentials (masked; git credentials by name)
  update                        Add a git credential or sign in an agent tool
  clear                         Remove stored tool credentials
  fake <kinds...>               Seed placeholder credentials for yaac-in-yaac:
                                claude-oauth, opencode-openrouter, pi-openrouter, github

yaac remote                     Which server this machine's clients use
  list                          Show the saved servers, the selected one marked *
  add <url>                     Save and select a server (checks it identifies this device)
  connect <url>                 Select a saved server (checks it the same way)
  disconnect                    Deselect the server without forgetting it
  remove <url>                  Forget a saved server other than the selected one
```

In a workspace's tmux session: `Ctrl-B D` detaches, `Ctrl-B C` opens a new
shell, `Ctrl-B N` / `Ctrl-B P` switch windows, and `Ctrl-B k` stops the
workspace after a confirmation.
