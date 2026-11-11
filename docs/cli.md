# CLI reference

`yaac <command> --help` shows every option. A `<workspace-id>` can be a unique
prefix of the id. A `<project>` can be the project's name, its id, or a unique
prefix of the id; `yaac project list` shows both. Names need not be unique
(adding a remote twice makes two projects), so a shared name is refused with
the candidates' ids.

A project links zero or more git repos (docs/project-repos.md). In it a repo
is named by its folder (`yaac project repo list`), or its id. A command
about one repo of a project takes `--repo <dir>`, which a project with one
repo does not need. `yaac repo` names a repo on its own: by id or unique id
prefix, by remote URL, or as `<project>/<folder>`.

## Whose projects

On an install with several users (docs/multi-user.md), a project's name or
id prefix means one of your own projects, and `project list`, `workspace
list` and `group list` show only yours. The global `--user <user>` (a login,
display name or user id, before or after the command) points all of that at
a teammate's projects instead: `yaac workspace list --user ada@example.com`.
A full project id names anyone's project either way. The CLI resolves the
project itself and sends the server its id, so two users each holding a
project of the same name never collide. Workspace ids are unaffected.

```
yaac --user <user> <command>    Mean this user's projects rather than your own

yaac server                     The yaac server the CLI and web app talk to
  start | stop | restart        Under k8s these scale or roll the in-cluster server
    --tailnet <host>            (start, restart) Serve tailnet users through
                                `tailscale serve` at this MagicDNS name
    --admin <login>             (start, restart; repeatable) With --tailnet: make
                                exactly these logins the admins (multi-user.md
                                "Roles"); asks before revoking anyone else's
    -y, --yes                   Revoke without asking
  run [-p <port>]               Run in the foreground (what `start` runs)
  logs [-f] [-n <lines>]        Print the server log

yaac cluster                    The Kubernetes cluster (k8s driver only)
  check                         Verify prerequisites and wiring
  install                       Create or converge the cluster, images and server.
                                Safe to re-run; never destructive. CF_TUNNEL_TOKEN
                                gives public sites a Cloudflare tunnel
                                (public-sites.md)
    --nodes <count>             kind nodes to create (default 1, max 5;
                                ignored if the cluster exists)
    --tailnet                   Publish the server on your tailnet via the
                                Tailscale Kubernetes operator
    --admin <login>             With --tailnet or --byo (repeatable): make
                                exactly these logins the admins; asks before
                                revoking anyone else's
    -y, --yes                   Revoke without asking
    --byo                       Install into the cluster your kubeconfig points
                                at instead of creating one (published on the tailnet)
    --rwx-storage-class <name>  With --byo (required): NFS-family class for the
                                shared claim
    --rwo-storage-class <name>  With --byo: class for the server's own claim
                                (default: the cluster's default class)
  delete [-y]                   Delete the kind cluster and its registry; keeps
                                workspaces' checkouts. Refused on a --byo install

yaac host check                 Verify this machine can run containerless workspaces

yaac user                       The install's users (multi-user.md "Roles")
  list                          Users and their roles
  role <user> <admin|member>    Set a user's role (admins only; never the last
                                admin's)

yaac project
  list                          Your projects (or --user's), each with its repos
  add <remote-url> <credential> Add a project around one git remote (https://,
                                ssh:// or git@host:path), cloned with the named
                                git credential (see `yaac auth list`); a remote
                                you already have a repo for reuses it
  create <name>                 Create a project with one empty repo whose git
                                remote yaac hosts (docs/hosted-projects.md)
  clone <project> [dir]         Clone a project's hosted repo to this machine
    --repo <dir>                Which repo, in a project with several
  move <project> <remote-url> <credential>
                                Move a hosted repo to an empty remote elsewhere,
                                stopping every workspace holding a checkout of
                                it; asks first, on a terminal
    --repo <dir>                Which repo, in a project with several
  repo list <project>           The repos a project links: folder, credential,
                                remote, and under k8s its two flags
  repo add <project> [remote-url] [credential]
                                Link a repo: a remote and the credential to
                                clone it with (reusing a repo you already have
                                for it), or one of:
    --repo-id <id>              A repo of yours, or one shared with you
    --hosted                    A new, empty repo yaac hosts
    --dir <name>                Its folder in a workspace with several repos
                                (default: the repo's name)
  repo remove <project> <repo>  Unlink it; the repo and every workspace's
                                checkout of it stay
  repo rename <project> <repo> <dir>
                                The folder its checkout takes from now on
  repo read-only <project> <repo> [on|off]
                                Show or set whether the project's workspaces
                                may only read it (k8s only; project-repos.md)
  repo gh-token <project> <repo> [on|off]
                                Show or set whether its token may be the
                                workspaces' GH_TOKEN (k8s only)

yaac repo                       Your git repos, whatever projects link them
  list                          Yours (or --user's) and those shared with you;
                                unlinked ones first, deleted ones still held
                                by workspaces last
  share <repo> <user>           Share a repo yaac hosts with another user, who
                                can link it into their projects
  unshare <repo> <user>         End the share, stopping their running
                                workspaces that hold a checkout of it
  delete <repo>                 Unlink it from every project, end its shares
                                and delete a hosted repository; no workspace
                                is deleted, and its clone stays on the server
                                while any holds a checkout (it lists them)
    -y, --yes                   Without the confirmation prompt

yaac workspace
  create [project]              Create a workspace and attach to its session
    -w, --workspace <id>        Open the session in this running workspace
                                instead (no project, and none of the workspace
                                options: --repo, --branch, --group, --timeout,
                                --start-*); --cwd names one of its checkouts
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
    --workflow <name>           Start with this named workflow; non-interactive,
                                it gets its run secrets, and this launch
                                approves its commit (workflows.md)
    -t, --tool <tool>           claude, codex, opencode, pi or omp (default: the
                                project's last, else claude)
    --repo <dir>[@<branch>]     A repo the workspace starts with, at this
                                branch, or at a full commit given in its
                                place; repeatable (default: the repos the
                                project's last create included, each at its
                                default branch; project-repos.md)
    --no-repos                  Start with no repos: an empty workspace dir
    --nested | --no-nested      Put a lone repo in a folder named for it, or
                                at the workspace root (default: the project's
                                last choice); several always sit in folders
    --cwd <dir>                 Where the agent starts: a selected repo's
                                folder, or . for the workspace root
    -b, --branch <branch>       Base branch of a workspace that starts with
                                one repo (default: the remote's default)
    --commit <sha>              Start that one repo at this full commit
                                instead; no base branch then (not with --branch)
    -p, --prompt <text>         Initial prompt for the agent
    -m, --model <model>         Model id or alias (provider/model for opencode, pi, omp)
    -e, --effort <level>        Effort level the model offers (effort-levels.md)
    --agent-option <name=on|off>
                                Turn an agent option on or off; repeatable
                                (idle-compaction, idle-cache-warming;
                                sessions.md)
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
    --workflow <name>           Add a named workflow's steps instead
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
                                --non-interactive with --workflow) required
    --name <name>               Heads each run's title; names its default group
    --cron <expr>               5-field cron or a nickname like @daily
    -p, --prompt <text>         Each run's prompt; - reads it from stdin
    --prompt-file <path>        Read the prompt from this file instead
    --tz <zone>                 Zone the cron is read in (default: yours)
    --timeout <duration|next>   Stop each run this long after it starts;
                                next (the default) stops it at the next tick
    -t/-m/-e/-b, --agent-option, --mode, --permission-mode,
    --repo, --no-repos, --nested, --no-nested, --cwd,
    --commit, --non-interactive As for workspace create
    --workflow <name>           The named workflow each run starts with;
                                saving approves the commit or branch it runs
                                on for its run secrets (workflows.md)
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
                                only; public-sites.md). Only an admin creates,
                                edits, deploys or starts one
  create <project> <name>       --hostname, --port and --workflow required;
                                prints what to add to the Cloudflare tunnel
    --hostname <host>           Public hostname the tunnel routes
    --port <n>                  Port its releases serve on
    --workflow <name>           The named workflow each release runs; a deploy
                                approves its commit, following a branch the
                                branch (workflows.md)
    --admin-port <n>            Port of each release only its owner reaches,
                                by `yaac forward` or a preview
    --volume <name>             Volume each release mounts (see `yaac volume`)
    --follow <branch>           Deploy each new tip of the branch while the
                                site serves, so whoever can push it, agents
                                included, publishes; a tip that fails is not
                                retried, and the last good release keeps
                                serving
    --repo <dir>                (create) The repo its releases are built
                                from, in a project with several
  edit <project> <name>         The same options; the next deploy uses them,
                                but the hostname and admin port move at once
    --no-admin-port             Offer no admin port
    --no-volume                 Mount no volume
    --no-follow                 Follow no branch; allowed mid-deploy, to
                                whoever may stop the site
  list <project>                Sites with their live release and last deploy
  show <project> <name>         A site and its recent releases
  deploy <project> <name>       Start a release; once ready the hostname moves
                                to it and the old one stops
    --ref <branch|sha>          What to deploy (default: the followed branch,
                                else the default branch)
    --timeout <duration>        Fail unless ready this long after it starts
                                (default 15m)
    --wait                      Wait for it, exiting non-zero unless it succeeded
  stop <project> <name>         Stop the live release; the hostname answers 503
  start <project> <name>        Start a replacement of the last release
  delete <project> <name>       Delete the site and stop its release

yaac workflow                   A project's named workflows, which routines,
                                sites, creates and queued workspaces run, and
                                the run secrets each gets (workflows.md)
  create <project> <name>       A workflow from --file
    --file <path>               JSON file of its steps
    --secret <name>             A run secret its runs get (repeatable)
  edit <project> <name>         New steps or secrets; workspaces started keep
                                what they started with
    --file <path>               Its new steps; needed to give it run secrets
    --secret <name>             Run secrets it gets, replacing its own
    --no-secrets                Give it none
  list <project>                Workflows with their steps and run secrets
  show <project> <name>         Steps, run secrets and approvals
  delete <project> <name>       Refused while anything follows it

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

yaac config                     Each setting prints given no value, and is
                                replaced given one (docs/project-config.md)
  show <project>                Print every setting of the project, each under
                                the command that changes it
  port-forwards <project> [ports...]
                                Show or replace the ports forwarded from every
                                workspace, each `port` or `port:hostStart`
    --none                      Forward none
  cache-volumes <project> [name=/path...]
                                Show or replace the dirs kept across workspaces
                                (k8s only)
    --none                      Keep none
  nested-containers <project> [on|off]
                                Show or set whether workspaces run a container
                                engine of their own (k8s only)
  npm-cache <project> [on|off]  Show or set whether workspaces use the
                                install's npm cache (k8s only)
  dockerfile <project>          Print the project's Dockerfile.yaac (k8s only)
    --file <path>               Replace it with a file's, `-` for stdin
    --none                      Remove it
  user-dockerfile               Print your Dockerfile.user (k8s only)
    --file <path>               Replace it with a file's, `-` for stdin
    --none                      Remove it
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
    --workflow <name>           Follow a named workflow instead
    --none                      Remove them
  env <project> [NAME=value...] List the project's variables and secrets
                                (secrets masked, with their proxy rule), or
                                set plain variables
    --secret                    Set the secret NAME instead, its value read
                                from stdin (never argv)
    --host <host>               A host it is injected on (repeatable; required)
    --path <glob>               Only on matching paths (default /*)
    --header <name>             Into this header (default authorization)
    --prefix <prefix>           Before the value (default "Bearer " with the
                                default header)
    --body-param <name>         Into this form/JSON body field instead
    --run-secret                Set the run secret NAME instead, its value
                                read from stdin: a real value only the
                                workflows naming it get (project-config.md)
    --unset <name>              Remove a variable, secret or run secret
  egress-allowlist <project> [hosts...]
                                Show or replace the hosts workspaces may reach
                                besides the defaults (k8s servers only)
    --none                      None besides the defaults
    --defaults <on|off>         Whether the default hosts are allowed too
  kept-ignored-paths <project> [paths...]
                                Show or replace the gitignored paths a stop
                                keeps
    --none                      Keep none
  default-branch <project> [branch]
                                Show a repo's default branch, or set a hosted
                                repo's (docs/hosted-projects.md)
  default-branch-guard <project> [on|off]
                                Show or set whether a hosted repo refuses
                                pushes that delete or rewind it
  git-credential <project> [credential]
                                Show or assign a repo's git credential, by its
                                `yaac auth list` name; every project linking
                                the repo uses it
    --repo <dir>                (all three) Which repo, in a project with
                                several
  time-zone [zone]              Show the time zone workspaces launch in, or
                                pin it to an IANA zone
    --follow-device             Unpin it, following the last device to connect

yaac auth
  list                          List credentials (masked; git credentials by name)
  update                        Add a git credential or sign in an agent tool
  clear                         Remove stored tool credentials
  endpoint                      Custom endpoints (docs/custom-endpoints.md)
    add <name> <url>            Add one, its models from its /models
      --key-stdin               Read its api key from stdin
      --models-file <path>      Its models as JSON instead (- for stdin)
    edit <name>                 Edit its models in $VISUAL/$EDITOR
      --models-file <path>      Replace its models instead (- for stdin)
      --rename <name>           Rename it
      --url <url>               Change its base URL
      --key-stdin | --clear-key Replace or remove its api key
    models <name>               Print its models as JSON
    refresh <name>              Show how its /models differs from its saved list
      --apply <parts>           Apply all, or any of new,changed,gone
      --edit                    Review the result in the editor before saving
    remove <name>               Delete it, signing out the tools using it
  fake <kinds...>               Seed placeholder credentials for yaac-in-yaac:
                                claude-oauth, opencode-openrouter, pi-openrouter,
                                omp-openrouter, github

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
