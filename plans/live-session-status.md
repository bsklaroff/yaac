# Push-fed session status — live watchers instead of probe polling

## Context

Session-state freshness is pull-based end to end today: the daemon's 5s
background tick publishes a snapshot after each reconcile pass
(`src/daemon/cli.ts:324`), the webapp polls `/session/list` every ~5s, and
every rebuild fans out per-session `kubectl exec` probes behind 2s-TTL
caches. External changes (agent finishes a turn, pod dies) surface only on
the next tick/poll — up to ~5s late, and the daemon burns O(N) execs every
few seconds at steady state.

Two recent changes make a push design cleaner than when first discussed:

- **Status sources moved to in-pod tmux state.** claude (`95e35b4`) and
  codex (`dcbd345`) statuses are now the agent pane's **OSC title** — a
  leading Braille spinner glyph means `running`
  (`classifyClaudeTitle`, `src/lib/session/claude-status.ts:33`;
  `classifyCodexTitle`, `codex-status.ts:42`). opencode remains a
  `capture-pane -pJ` scrape (`classifyOpencodePane`,
  `opencode-status.ts:92`). All three probe via one-shot `kubectl exec`.
- **The reaper is already probe-independent and hardened** (`21ee386`):
  tri-state `probeTmuxLiveness` (`src/lib/session/cleanup.ts:167`), never
  reaps on an inconclusive probe.

**Verified live (tmux 3.4, the version in `Dockerfile.default`'s
ubuntu:24.04 base and on the host):** a control-mode client
(`tmux -C attach`) that runs `refresh-client -B 'status:%<pane>:#{pane_title}'`
receives `%subscription-changed … : <title>` immediately at subscribe time
(current value — solves initial classification for free) and again on every
title change. `%output` events arrive on the same stream, and the stream
doubles as a command channel (`%begin`/`%end`-wrapped replies).

Decisions locked in discussion:

1. **Keep the 5s background loop byte-for-byte** (all six steps in
   `src/daemon/background-loop.ts:52-75`). It is convergence work and the
   watchers' resync backstop, not a display path.
2. **No fallback status probe.** Watcher-fed state is the sole status
   source. Safe because status never leaves the daemon process (CLI reads
   it over RPC — `src/commands/session-list.ts:1`; the stream-picker is a
   daemon route — `src/daemon/routes/session.ts:21`) and nothing
   safety-critical consumes it (the reaper uses its own liveness probes).
3. **Display = push-fed memory; safety = pull probes.** The reaper never
   consumes watcher state: streams die for benign reasons, so stream death
   triggers a refresh, never a teardown.

## Architecture

```
kubectl get pods --watch ──▶ pod-watch cache ──▶ watcher lifecycle
                                   │                   │ one control-mode
                                   │                   │ exec per session
                                   ▼                   ▼
                            listActiveSessions ◀── status store ◀── %subscription-changed /
                                   │        (in-memory, sticky)     %output + capture-pane
                                   ▼
                 notifySessionListChanged ──▶ EventHub.publishSnapshot (dedup)

5s background loop: unchanged (reap / prewarm / ssh-keys / vcluster steps,
own listSessionPods + tri-state probes) + onTick publishSnapshot kept as a
free backstop (hub dedups; rebuilds are now pure memory reads).
```

Failure mode degrades to today's behavior or better: if a watcher is down,
its session shows sticky last-known status (absent → `waiting`, matching
today's boot-time answer) and the 5s loop still converges pods/reaping.

## Components

### 1. Pod watch — `src/lib/k8s/pod-watch.ts` (new)

A long-lived `kubectl get pods -n <ns> -l <selector> --watch -o json`
child (same selector as `listSessionPods`, `src/lib/k8s/pods.ts:117-121`),
preceded by a full list to seed an in-memory `Map<podName, SessionPod>`.
Parses watch objects with the existing `sessionPodListSchema` item shape.
Emits `added`/`changed`/`removed` to two consumers: the watcher-lifecycle
manager and `notifySessionListChanged()`. Auto-restarts with backoff and
re-lists on every (re)connect — the standard informer pattern; the 5s
loop's own listing is the second safety net. Fires within milliseconds of
pod phase changes instead of at the next tick.

### 2. Status watchers — `src/daemon/status-watcher.ts` (new)

One control-mode tmux client per running, non-prewarmed session pod,
spawned via `stdinExecArgs` (`src/lib/k8s/exec.ts:43` — `-i`, **no TTY**;
control mode must not run under a PTY):

```
kubectl exec -n <ns> -i job/<job> -- \
  tmux -S <CONTAINER_TMUX_SOCK> -C attach-session -t yaac -f read-only,ignore-size
```

`ignore-size` keeps the control client out of window-size negotiation so
the opencode scrape geometry is unaffected.

On connect, over the same stream:
- resolve the agent pane id: `display-message -p -t yaac:<tool>.0 '#{pane_id}'`
  (window name = tool, e.g. `yaac:claude.0`);
- subscribe: `refresh-client -B 'status:%<id>:#{pane_title}'`.

Per tool:
- **claude / codex:** classify each `%subscription-changed` payload with
  the existing `classifyClaudeTitle` / `classifyCodexTitle`. The subscribe
  itself pushes the current title, so there is no unclassified window —
  critical because an idle pane emits no output events, ever.
- **opencode:** `%output` for the agent pane is a dirty bit → debounce
  ~300ms → run `capture-pane -pJ -t yaac:opencode.0` over the stream →
  `classifyOpencodePane`. One capture at connect for the initial value.

**Heartbeat (replaces the fallback probe as the wedge detector):** every
~20s send a no-op command (`display-message -p ok`) and expect its
`%begin`/`%end` reply within a timeout; any inbound traffic also resets
the timer. No reply → kill and respawn with backoff. This is the only
periodic activity left and it rides the open connection — zero new execs —
while verifying the exact path status depends on (apiserver → pod → tmux).

**Lifecycle:** driven by pod-watch events. Pod running (and not prewarmed,
`isPrewarmed`) → ensure watcher (exec may fail while tmux is still
booting — retry with backoff; store stays absent → `waiting`, parity with
today's boot answer). Pod removed/terminating → stop watcher, evict store
entry. `%exit`/EOF → respawn; status stays sticky meanwhile.

### 3. Status store — `src/lib/session/status-store.ts` (new)

`Map<'slug/sessionId', { status, streamHealthy, updatedAtMs }>` plus a
change listener. Semantics: watcher writes win; sticky across respawns;
absent → `waiting`. A status flip fires `notifySessionListChanged()`.

### 4. Status getters become store reads

`getSessionClaudeStatus` / `getSessionCodexStatus` /
`getSessionOpencodeStatus` read the store. Delete the three TTL caches,
their in-flight coalescing, and the probe helpers (`readClaudePaneTitle`
etc.); keep the classifiers (still unit-tested, now fed by watchers) and
all first-message readers. `evictClaudeStatusCache`-style eviction moves
to the store, still called from `cleanupSession`. Migrate call sites in
the same PR — no compat shims.

### 5. Display path — `src/lib/session/list.ts`

`listActiveSessions` stops listing pods and probing tmux:
- pod set comes from the pod-watch cache;
- display liveness comes from watcher health, mapped conservatively to
  `alive` (stream healthy) or `unknown` (connecting/respawning) — **never
  `dead`**, so display can never drop a session on stream state. Post-
  `21ee386`, `classifySessionPods` already keeps `unknown` pods visible;
  genuinely dead sessions leave the list via pod-watch (pod gone) or the
  reaper's own conclusive probes.

`reconcileStaleSessions` is untouched: it keeps its own `listSessionPods`
+ `listSessionJobs` + tri-state `probeTmuxLiveness` at 5s
(`list.ts:196-231` equivalent). The `listActiveInflight` single-flight map
can go — rebuilds are memory reads.

### 6. Daemon wiring — `src/daemon/cli.ts`

Start pod-watch and the watcher manager alongside the background loop;
stop them (kill exec children) on shutdown. Add a small trailing debounce
(~150ms) in the `onSessionListChanged` → `publishSnapshot` wiring
(`cli.ts:148`) so an event burst (pod watch churn at startup) coalesces
into one rebuild. Keep `onTick: publishSnapshot` (`cli.ts:324`) — dedup
makes it free and it papers over any missed notify.

## Tests (per CLAUDE.md)

- **Unit (`test/unit/`):** control-mode line parser
  (`%subscription-changed` payload extraction — split on first ` : `,
  titles containing colons; `%begin`/`%end`/`%error` command framing;
  `%output`; `%exit`); watcher state machine against a fake stream
  (connect → subscribe → classify; heartbeat timeout → respawn; sticky
  status across respawn; opencode dirty-bit debounce); status store
  semantics; pod-watch event parsing and cache maintenance;
  `listActiveSessions` fed by an injected watch cache + store. Every new
  exported function gets a test.
- **E2e (`test/e2e/`):** no new CLI arguments, so coverage targets daemon
  behavior: create a session, flip the agent pane title in-pod
  (`tmux select-pane -T '⠋ …'` / `'✳ …'`), assert `/session/list` (and an
  `/events` snapshot) reflects it within ~2s — no tick wait; kill the
  watcher's exec child, assert status stays sticky and the watcher
  respawns (heartbeat); steady-state assertion that no periodic
  `kubectl exec` probes occur. Respect `YAAC_K8S_NAMESPACE` isolation and
  gate anything nested-incapable on `IS_NESTED_YAAC`.
- `pnpm lint` clean.

## Verification

1. Run the daemon with one claude session; watch `/events`: title flip →
   snapshot push in well under a second.
2. `ps`/`pgrep` steady state: exactly one `kubectl … --watch` plus one
   `kubectl exec … tmux -C` per session; no recurring one-shot execs.
3. Kill a watcher child; confirm respawn + sticky status; `daemon.log`
   shows the respawn, no reap.
4. Delete the pod out-of-band; confirm the row disappears on the watch
   event (not the tick) and the reaper still cleans the Job.

## Out of scope

- Frontend: the webapp keeps its ~5s `/session/list` poll (now cheap);
  leaning on `/events` alone is an independent follow-up.
- The herdr plan (`plans/herdr-integration.md`) is unaffected — it needs
  none of this; it just sees fresher `session list --json` output.
- Remote daemon topology (`plans/remote-daemon-hosting.md`).
- First-message/title capture paths (host-file reads and the opencode
  HTTP probe) stay as they are.

## Risks / open questions

- **`%subscription-changed` payload framing:** verified on tmux 3.4 for
  simple titles; the parser must handle arbitrary title text (split on
  first ` : `, tolerate empty). Pin behavior with unit fixtures from a
  live capture.
- **Control client side effects:** `-f read-only,ignore-size` should keep
  it invisible (sizing verified relevant only for opencode's scrape);
  confirm `destroy-unattached`-style options on the `yaac` session are
  not set (they aren't — that's only the grouped `view-$$` sessions,
  `src/daemon/pty-bridge.ts:64`).
- **kubectl watch lifecycle:** the apiserver closes watches periodically;
  restart+relist must be airtight or the pod cache goes stale — covered
  by the 5s loop as backstop, but log reconnects for observability.
- **Scale:** one open exec per session is fine for a local single-node
  cluster; revisit if the remote-hosting plan lands (connection fan-out
  moves to the remote daemon's node).
- **Prewarm claim transition:** claiming a spare relabels/renames — make
  sure the pod-watch `changed` event starts the watcher for the claimed
  session id (watch emits the full object; keying watchers by session id
  handles it).
