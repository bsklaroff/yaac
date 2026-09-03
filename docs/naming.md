# One meaning for "session"

**A session is a conversation with an agent.** Nothing else.

Four distinct things once shared the word, and the most common one was the
wrong one: the durable checkout a user names and the pod it runs in were both
called a session, alongside the agent's own conversation, the webapp's auth
cookie, and tmux's. The vocabulary below is what each is called now, and
getting it wrong is how a rename turns into a second rename.

| word | means | where it is the right word |
|---|---|---|
| **session** | one conversation with an agent | the tool's own id, transcripts, first prompts, `mode`, the webapp's auth cookie, tmux's own |
| **worktree** | the durable thing: a checkout, its history, its record | storage, the CLI, the database, the webapp, anything a user names |
| **workspace** | the same thing seen by the runtime layer, substrate-neutrally | the driver contract vocabulary (`#drivers/contract`) — deliberately free of git and Kubernetes nouns (docs/layered-server.md) |
| **pod** | the Kubernetes object a worktree currently runs in | `#drivers/k8s/substrate` and nothing above it |

The pod tier is the one that reads as a distinction without a difference until
it bites. `PodInfo`, `PodMount` and `podExec` describe the pod, not
the worktree — naming them `Worktree*` would put the old conflation back under
a new spelling. The calls that enumerate an install's pods do say what they
enumerate (`listWorktreePods`, `worktreePodSelector`), because that is what
distinguishes them from any other pod in the namespace.

## What still says "session", and why

Some names are not the repo's to choose. They are already written to a user's
disk, or they belong to someone else's protocol, so they keep their spelling and
the code around them explains why.

**Not the cluster objects.** The PriorityClass, the NetworkPolicies, the pod's
container and the pod and Job label keys are all worktree-named.

**The on-disk layout.** A worktree's state tree lives under
`projects/<slug>/sessions/<id>`. The helpers naming it moved
(`worktreeStateDir`, `worktreeStateRoots`); the path segment did not, because it
names data that already exists on every user's disk.

**Protocol field names.** `legacy_session_id` in a TLS ClientHello (RFC 8446)
and `session-bind@openssh.com` in the ssh-agent protocol are other people's
wire formats, parsed by the proxy.

**Agent-facing names.** `--session-id`, the `SessionStart` hook and its
session-starts log, pi's and opencode's session logs, and the ACP protocol's
`sessionId` are all the tools' vocabulary, where a session genuinely is a
conversation. `#runtime/agents/acp-client.ts` and `acp-protocol.ts` are the two
modules where a bare `sessionId` is an agent's session and not a worktree.
