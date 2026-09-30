# One meaning for "session"

**A session is a conversation with an agent.** Nothing else.

| word | means | where it is the right word |
|---|---|---|
| **session** | one conversation with an agent | the tool's own id, transcripts, first prompts, `mode`, tmux's own sessions |
| **workspace** | the durable thing a user names: a checkout, its history, its record, and the runtime it runs in | storage, the CLI, the database, the webapp, and the driver contract (`#drivers/contract`), which keeps git and Kubernetes nouns out of it (docs/layered-server.md) |
| **pod** | the Kubernetes object a workspace currently runs in | `#drivers/k8s/substrate` and nothing above it |

Keep the pod names separate even though a workspace has one pod at a time.
`PodInfo`, `PodMount` and `podExec` describe the pod, not the workspace, and
renaming them `Workspace*` would merge two things that differ. Calls that
enumerate an install's pods say so (`listWorkspacePods`,
`workspacePodSelector`), because that is what sets them apart from other pods
in the namespace.

"Worktree" is not used: a workspace is a git clone, not a git worktree. It
survives only in legacy-compat shims for workspaces an older install
launched (`YAAC_WORKTREE_ID`, the `/worktree` route, the `yaac.worktree-id`
label, checkouts under `worktrees/`), each listed in
docs/legacy-compat-shims.md.

## What still says "session", and why

Some names are not the repo's to choose, so they keep their spelling:

- **The on-disk layout.** A workspace's state tree lives under
  `projects/<slug>/sessions/<id>`. The helper is `workspaceStateDir`, but the
  path segment stays because it names data already on users' disks.
- **Protocol fields.** `legacy_session_id` in a TLS ClientHello (RFC 8446) and
  `session-bind@openssh.com` in the ssh-agent protocol are other people's wire
  formats, parsed by the proxy.
- **Agent-facing names.** `--session-id`, the `SessionStart` hook and the
  `@yaac-session` pane option it sets, pi's and opencode's session logs, and
  the ACP protocol's `sessionId` are the tools' vocabulary, where a session
  really is a conversation. In `#runtime/agents`, `acp-client.ts` and
  `acp-protocol.ts` are the modules where a bare `sessionId` means an agent's
  session.
