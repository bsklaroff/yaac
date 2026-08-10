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
| **workspace** | the same thing seen by the runtime layer, substrate-neutrally | the runtime observation vocabulary (`#runtime/contract`) — deliberately free of git and Kubernetes nouns (docs/layered-server.md) |
| **pod** | the Kubernetes object a worktree currently runs in | `#platform/k8s` and nothing above it |

The pod tier is the one that reads as a distinction without a difference until
it bites. `PodInfo`, `PodMount`, `podExec` and `podUid` describe the pod, not
the worktree — naming them `Worktree*` would put the old conflation back under
a new spelling. The calls that enumerate an install's pods do say what they
enumerate (`listWorktreePods`, `worktreePodSelector`), because that is what
distinguishes them from any other pod in the namespace.

## What still says "session", and why

Some names are not the repo's to choose. They are already written to a user's
disk, or they belong to someone else's protocol, so they keep their spelling and
the code around them explains why.

**Not the cluster objects — those moved.** The PriorityClass, the three
NetworkPolicies and the pod's container are all worktree-named now. Each needed
its own argument for why that was safe: a PriorityClass resolves into `pod.spec.priority`
at admission and is never consulted again, so renaming it cannot disturb a
running pod; the container name is read by nobody (readers go through
`containerStatuses[0]`); and the NetworkPolicies are applied under their new
names *before* the old ones are deleted, because policies union — an overlap is
harmless where a gap would leave worktree egress unpoliced. Those sweeps run
where the policies are applied — the next proxy ensure and the next vcluster
ensure, i.e. the first worktree create, not server boot; until then the old
names linger as duplicate rules.

The `yaac-session` PriorityClass is deliberately *not* swept. PriorityClasses
are cluster-scoped and shared by coexisting installs, so deleting it would
break an install still running old code — its pods name that class, and the
apiserver rejects a pod whose class is missing (the Job applies, no pod ever
appears). A leftover class costs nothing.

The **three NetworkPolicy sweeps** are the one piece of this rename still owed a
cleanup, and they are not a compatibility window — nothing reads the old
objects, they are only being deleted. `ensureProxyResources` deletes
`yaac-session-egress` and `yaac-session-ingress-lock` in the install namespace,
and `ensureWorktreeVcluster` deletes `yaac-inner-session-ingress-lock` in each
vcluster namespace; all three run on every ensure, forever. **Delete them once
every cluster in use has been through one worktree create on a build carrying
them** — the ensures, not server boot, are what run them. After that they are
three API calls per ensure against objects that cannot exist, and a leftover
policy is a duplicate rule rather than a hole, so removing them a little early
costs nothing.

The PriorityClass is *not* on that list and must not be added to it: as the
paragraph above says, `yaac-session` is deliberately left in place because the
class is cluster-scoped and a coexisting old install's pods still name it.

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

## Compatibility windows still open

Three renames could not be atomic, because the far side upgrades separately.
Two fail *silently* if the old name is dropped early — a stale selector finds no
pods, an unread state file reads as no state; neither errors. The third, the
server↔proxy wire, fails loudly but install-wide. Each closes only when its far
side is guaranteed to have caught up. A cosmetic name is not worth a window: the pod's
`YAAC_WORKTREE_ID` and the webapp's `?worktree=` link both changed outright,
because the worst case is a shell prompt or a stale bookmark.

**`yaac.worktree-id` vs `yaac.session-id`.** Every worktree Job and Pod is
stamped with both. A Kubernetes label selector cannot express "either key", so
every selector — the list queries, the informers, the cluster-side NetworkPolicy
podSelectors, and netd's and the proxy's own copies of the constant — still
matches on the legacy key, the one key every live pod carries. Code-level
readers go through `labelWorktreeId`, which accepts either. Dropping the legacy
stamp strands every worktree that was already running at upgrade time.

**The proxy's registrations file.** `/data` is a hostPath that outlives the
proxy pod on purpose — it is how a replaced proxy comes back knowing every
worktree's allowlist. `worktrees.json` is what gets written; `sessions.json` is
still read when only it exists, because a boot that finds neither starts empty,
fails closed, and takes egress from every running worktree without erroring.
`k8s/proxy/state-files.ts` owns that, and is tested for it.

**Everything the server says to the proxy.** The proxy is a separate image, and
the check that redeploys it on an image-hash mismatch runs only inside
`ProxyClient.ensureRunning` — which is reached from worktree create, not from
server start. Boot attaches to whatever is deployed, the `attachIfRunning`
callers (allow-host, worktree stop, the spawn drain) never check, and relay
dials do not go through `ProxyClient` at all. So a server restarted onto new
code talks to the OLD proxy until the first create, and every one of those
paths needs both spellings:

- the relay auth line sends `worktreeId` and `sessionId`;
- `/worktrees/:id` falls back to `/sessions/:id` on a 404, and the new proxy
  serves both;
- drained spawn requests carry both names, and results answer under both.

Closing this window means making the currency check run at boot too; until it
does, the bridges are what keep an in-place upgrade working.
