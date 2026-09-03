# Cloud k8s, step 2: node tuning into the DaemonSet

Implementation plan for step 2 of docs/plans/cloud-k8s.md, and nothing
else. The decision it implements, from that doc: the sysctls and
`DefaultTasksMax` are real-node concerns as much as kind-node ones, the
`yaac-gvisor-install` DaemonSet already runs privileged with `nsenter` on
every node and reapplies on every new node, so it becomes the one
node-tuning mechanism. What stays in install's `podman exec` loop is what
only a node *container* has: the pids ceiling on the container and the
kubelet housekeeping flag. This plan is deleted when the step ships;
docs/cluster-setup.md carries the current-state description from then on.

## What moves where

| Setting | Today | After this step | Backend |
|---|---|---|---|
| `vm.min_free_kbytes=262144` | `podman exec <node>` in `applyNodeFixups` | installer DaemonSet pass, raise-only | every |
| `vm.compaction_proactiveness=40` | `podman exec` | installer pass, set when different | every |
| `fs.inotify.max_user_instances=1024` | `podman exec` | installer pass, raise-only | every |
| `fs.inotify.max_user_watches=524288` | `podman exec` | installer pass, raise-only | every |
| `DefaultTasksMax=infinity` drop-in + `systemctl daemon-reexec` | `podman exec` | installer pass, written through a hostPath mount, reexec only on change | every |
| `--housekeeping-interval=300s` in `kubeadm-flags.env` + kubelet restart | `podman exec` | unchanged, `applyKindNodeFixups` | kind only |
| `podman update --pids-limit 32768 <node>` | `podman update` | unchanged, `applyKindNodeFixups` | kind only |

The values do not change. What changes is who applies them, when, and
what verifies them.

Two properties fall out. A node that restarts (a podman machine restart,
a host reboot, a recycled cloud node) gets its sysctls back from the
installer pod kubelet restarts on it, with no `yaac cluster install`
re-run. And the tuning reaches nodes yaac has no shell on, which is the
whole point of step 6's `--byo` mode; nothing in this step needs that
flag to exist.

## Modules

### `packages/server/src/drivers/k8s/substrate/node-tuning.ts` (new)

The vocabulary for the node tuning and the shell fragment that applies
it. Lives in the substrate because the install script (`gvisor.ts`, also
substrate) composes it, and the substrate imports nothing above itself.

- `NODE_TASKSMAX_CONF`, `NODE_MIN_FREE_KBYTES`, `NODE_INOTIFY_MAX_USER_INSTANCES`,
  `NODE_INOTIFY_MAX_USER_WATCHES` move here from `install/check.ts`,
  values unchanged, doc comments with them (the inotify comment about the
  one root-uid pool on kind stays true and gains the byo reading: on a
  real node the pool is the node's own).
- `NODE_SYSTEMD_CONF_DIR = '/etc/systemd/system.conf.d'`, the fourth node
  directory the installer mounts.
- `NODE_TUNING_SYSCTLS`: the four sysctls as `{ path, value, mode:
  'raise' | 'set' }` rows, so the script, the check and the tests read one
  table. `raise` writes only when the live value is lower; `set` writes
  when different. Raise-only matters on a node somebody else tuned higher:
  yaac must never lower a ceiling an operator raised.
- `nodeTuningScript()`: the POSIX fragment defining `tune_pass`. For each
  sysctl: read `/proc/sys/<path>`, compare, write. The tasksmax drop-in
  goes through the existing `write_if_changed` helper against
  `/host/etc/systemd/system.conf.d/10-yaac-tasksmax.conf`, and
  `nsenter -t 1 -m -- systemctl daemon-reexec` runs only when that write
  changed the file. Writes go to the pod's own `/proc/sys`: none of the
  four is namespaced, and a privileged container mounts `/proc/sys`
  read-write, so the pod's view is the kernel's. Every line logs with the
  `yaac-gvisor:` prefix the rest of the script uses, so `kubectl logs`
  shows what a pass changed.

Its exports are consumed only through `gvisor.ts` and `check.ts`, so per
the sealed-folder rule it gets no test file of its own: the script is
covered through `gvisorInstallScript`, and the constants are setup values.

### `packages/server/src/drivers/k8s/substrate/gvisor.ts`

- `gvisorInstallerHostMounts()` adds `['node-systemd', NODE_SYSTEMD_CONF_DIR]`
  to its directory list, `DirectoryOrCreate` like the others. The module
  comment's "three narrow directories" becomes four, with the same audit
  reading: what yaac writes on a node is the runtime, the containerd
  config, its cache, and one systemd drop-in.
- `gvisorInstallScript()` splices `nodeTuningScript()` in before
  `install_pass` and calls it from the loop: `take_lock; tune_pass;
  install_pass; drop_lock; : > "$ready"`. Tuning runs under the same lock
  (two installs sharing a node write the same file and the same values,
  but a `daemon-reexec` racing a `systemctl restart containerd` is not
  worth having), and before the runtime install so a node that cannot be
  tuned fails before it downloads anything.
- `write_if_changed` stops setting `changed=1` itself and reports through
  its exit status; the two runtime callers set `changed=1` on success and
  the tuning caller sets its own `reexec=1`. Without this split a missing
  drop-in would restart containerd on every node it is first written to.
- Failure semantics: `set -eu` already makes a failed sysctl write end the
  pass, which drops the ready marker, lets kubelet restart the container
  with backoff, and fails install's rollout gate loudly. Keep that. A node
  whose `/proc/sys` cannot be written or whose PID 1 has no `systemctl` is
  a node that could not have had its containerd restarted either, and a
  node yaac cannot tune is a node yaac should not label for worktrees.

### `packages/server/src/drivers/k8s/substrate/index.ts`

Exports `NODE_TASKSMAX_CONF`, `NODE_TUNING_SYSCTLS` and `NODE_SYSTEMD_CONF_DIR`
for the check. `nodeTuningScript` stays internal.

### `packages/server/src/drivers/k8s/install/gvisor-installer.ts`

No structural change: the new volume flows through
`gvisorInstallerHostMounts()`. The module comment's "node recycling is
handled for free" paragraph gains the sentence that the same pass is now
what re-applies the node's sysctls after a restart, which is why install
no longer does.

### `packages/server/src/drivers/k8s/install/check.ts`

- The four moved constants are imported from `#drivers/k8s/substrate`;
  `NODE_PIDS_LIMIT`, `NODE_KUBELET_HOUSEKEEPING_INTERVAL` and
  `NODE_KUBELET_FLAGS_ENV` stay here, still shared with `install.ts`.
- `runNodeFixupsCheck` narrows to the kind pair: the one `podman exec`
  greps the housekeeping flag, `podman inspect` reads the pids ceiling. It
  keeps its name, its warn level, and its self-skip on a node that is not
  a podman container. Pass detail becomes `kubelet housekeeping and
  pids-limit in place`; `NODE_FIXUPS_FIX` says these are settings of the
  kind node container that `yaac cluster install` re-applies.
- New gate `node-tuning`, warn-level, right after `gvisor` in
  `PROBE_GATES` (it needs the installer pods the gvisor gate proves exist)
  and before the pod probes. It lists the installer pods
  (`-l app=yaac-gvisor-install`, the way `probeWorkloadVeths` lists netd's)
  and execs each Running one for `cat` of the four sysctls plus `test -f`
  on the drop-in under `/host`. This is the replacement for the sysctl
  half of the old check and it works on every backend, since it goes
  through the apiserver rather than podman. Per node: a value below a
  `raise` target or different from a `set` target, or a missing drop-in,
  is named in the warn detail; a node with no Running installer pod is
  reported as unverified, not passed. A `kubectl exec` failure is
  unverified too. Fix text points at the installer's logs
  (`kubectl -n <ns> logs -l app=yaac-gvisor-install`) and at
  `yaac cluster install`, which re-applies the DaemonSet.
  Reading sysctls from the installer pod is sound for the same reason the
  writes are: non-namespaced values, no user namespace on the pod.
- The header enumeration (6b) and `KIND_SETUP_FIX` are reworded to match.

### `packages/server/src/drivers/k8s/install/install.ts`

- `applyNodeFixups` becomes `applyKindNodeFixups`: the housekeeping-flag
  edit and `podman update --pids-limit`, nothing else. Its doc comment
  says why these two cannot move: the pids ceiling is a property of the
  podman container, and the kubelet flags file is kubeadm's, which a
  managed pool does not expose.
- The three call sites are unchanged in shape. Under `--adopt-cni` the
  loop still runs where the adopted cluster's nodes are podman containers
  and logs the existing note where they are not; the note's wording drops
  "sysctls, TasksMax" and says the two settings by name. See the open
  question on `--byo` below for why the podman-container detection, not a
  flag, stays the switch.
- The module header's "Two kinds of state need re-applying" paragraph is
  rewritten: what install re-applies per node is the kind-container pair;
  the sysctls and TasksMax are in-cluster state now, re-applied by the
  DaemonSet on every node it lands on and on a timer. The comment on the
  converge branch ("Re-applied every run because they live in node/VM
  state a restart drops") narrows the same way.
- Ordering note: today the sysctls land before the registry and image
  builds; after this step they land when the installer DaemonSet rolls,
  which is after both. Nothing between the two needs them: image builds
  run on host podman, and netd (the inotify consumer) deploys after the
  installer. The kubelet restart in the kind pair keeps its early slot.

### CLI and docs text

- `packages/cli/src/cli.ts` (the `cluster install` description),
  `packages/cli/src/commands/cluster-install.ts` (its doc comment) and
  README.md's command table say "the kind node fixups" rather than "the
  node fixups". No flag is added, removed or renamed.
- docs/cluster-setup.md: item 3 of "What it wires up" becomes the kind
  pair and corrects the stale `60s` to the `300s` the code sets; item 4
  (the gVisor runtime) gains the tuning: what the pass sets, raise-only,
  the drop-in, the reexec, and that the same pass re-applies it after a
  node restart. "Node fixups vanish on restart" is rewritten to say which
  state still needs an install re-run (the pids ceiling on the node
  container, after a cluster recreate only, since podman keeps it across a
  container restart) and which heals itself. The "Multi-node" paragraph
  on host-side loops versus DaemonSets moves the sysctls to the DaemonSet
  column. "Verifying" lists `node-tuning`.
- docs/plans/cloud-k8s.md: step 2 leaves "The work, in order", and
  "Where things stand" gains one bullet stating that node tuning is the
  installer DaemonSet's and install's exec loop holds only the kind pair.
  The "Node tuning moves into the gVisor installer DaemonSet" decision
  stays as the rationale.

## Manifests, env vars, flags

- Manifest: the `yaac-gvisor-install` DaemonSet template gains one
  hostPath volume (`/etc/systemd/system.conf.d`, `DirectoryOrCreate`) and
  its mount at `/host/etc/systemd/system.conf.d`; its command string
  changes because the script does. Re-applying it on `yaac cluster
  install` rolls the installer pods one node at a time
  (`maxUnavailable: 1`). No containerd restart follows: the runtime files
  are unchanged and the per-version marker is present, so `changed` stays
  0.
- RBAC, ServiceAccount, RuntimeClasses: unchanged.
- Env vars: none added. `YAAC_*` reads none.
- CLI flags: none. `--byo` does not exist until step 6; this step's
  "skipped under `--byo`" is realized by the existing rule that the kind
  pair runs only where `kind get nodes` names podman containers.

## Legacy compat

No shim, and no docs/legacy-compat-shims.md entry, because nothing this
step reads or writes changes shape:

- The drop-in is the same path with the same content; `write_if_changed`
  sees an already-converged node and does nothing. An install that ran the
  old `podman exec` loop and never re-runs `yaac cluster install` keeps the
  old DaemonSet, the node keeps its exec-applied state, and nothing
  degrades until the next restart, exactly as before.
- The sysctls are idempotent and raise-only, so the DaemonSet and a stale
  install applying both is harmless. The e2e tiers deploy no installer of
  their own (they use the rig's cluster-scoped runtime), so the only
  coexisting installers are two real installs sharing a node, which the
  lock already serializes.
- `node-fixups` still passes on an old node: the kind pair is untouched.

## Tests

### Unit (`pnpm vitest run --project unit:server`)

`packages/server/test/drivers/k8s/substrate/gvisor.test.ts`

- `gvisorInstallScript`: a new case "tunes the node before installing the
  runtime, and never restarts containerd for it". Asserts `sh -n` still
  parses; the loop is `take_lock / tune_pass / install_pass / drop_lock /
  ready` in that order; for each `NODE_TUNING_SYSCTLS` row the script
  reads and writes `/proc/sys/<path>` with the row's value, and `raise`
  rows compare with `-lt` while `set` rows compare with `!=`;
  `write_if_changed '/host/etc/systemd/system.conf.d/10-yaac-tasksmax.conf'`
  carries `[Manager]\nDefaultTasksMax=infinity\n`; `nsenter -t 1 -m --
  systemctl daemon-reexec` appears exactly once, guarded by the tuning
  flag and not by `changed`; the containerd restart guard is unchanged.
- The existing "restarts containerd only on change" case extends to assert
  `write_if_changed` no longer assigns `changed=1` and that both runtime
  call sites do.
- `gvisorInstallerHostMounts`: the expected path list gains
  `/etc/systemd/system.conf.d`; the auto-derived "every `/host` literal
  in the script sits under a mount" invariant is what actually guards the
  new path.

`packages/server/test/drivers/k8s/install/gvisor-installer.test.ts`

- The volume-path assertion in `ensureGvisorRuntime`'s first case gains
  the systemd dir; the command assertion adds the daemon-reexec line.

`packages/server/test/drivers/k8s/install/install.test.ts`

- "creates the cluster ..." (the exec-command block): asserts NO `podman
  exec` command contains `DefaultTasksMax`, `min_free_kbytes` or
  `inotify`; keeps the housekeeping-flag and `podman update ... 32768`
  assertions. Its comment says the sysctls are the installer's now.
- "applies the container-side node fixups to every node of a multi-node
  cluster": `fixupWrites` filters on the housekeeping flag instead of
  `DefaultTasksMax`; the expected node list is unchanged.
- "converges an existing cluster in place": the comment on what install
  still owns per node is rewritten; the `podman exec` expectation stays
  (the flag grep).
- "--adopt-cni installs the in-cluster layers": unchanged assertion, the
  comment names the pair. Add a case for the no-kind-nodes branch
  asserting the note names the pids ceiling and the kubelet flag and does
  not mention sysctls.

`packages/server/test/drivers/k8s/install/check.test.ts`

- `happyResponses` answers the new exec: `kubectl get pods -l
  app=yaac-gvisor-install` lists one Running pod per entry of
  `clusterNodes`, and `kubectl exec ... -c install` returns the four
  values at target plus `tasksmax=ok`. The `podman exec` stub shrinks to
  `hk=ok`.
- "passes every check on a healthy single-node cluster": the ordered
  list gains `['node-tuning', 'pass']` after `gvisor`.
- "warns on node-fixups when a fixup went missing": rewritten to stub only
  `hk=missing` and a `2048` pids ceiling, asserting the detail names both
  and names neither `DefaultTasksMax` nor any sysctl.
- New "warns on node-tuning, naming the node and the value, when the
  installer has not re-applied a sysctl": stub one node's exec at the
  stock defaults (`67584`, `128`, `8192`, `tasksmax=missing`) on a
  two-node fixture; asserts warn, the node name, each named setting, the
  installer-logs fix, and `ok === true`.
- New "leaves node-tuning unverified when a node has no Running installer
  pod": a node absent from the pod list, and an exec that rejects;
  asserts warn with "unverified", never pass.
- "skips node-fixups when the node is not a podman container": unchanged,
  and extended to assert `node-tuning` still passes there, since that is
  the byo shape.
- "skips the end-to-end probe when an earlier check failed": `node-tuning`
  is in the skipped set.

### API matrix

No route changes. Nothing to add to `test/api/route-matrix.ts`.

### e2e-containerless

Nothing: the containerless driver has no nodes, no installer and no
cluster check. Say so in the PR rather than leaving it implied.

### e2e-cli (`test/e2e-cli/cluster-cli.test.ts`)

No new argument or option, so no new case is owed. The existing `install`
and `check` guard-rail cases keep running; the file's header comment does
not name the fixups and needs no change.

### k8s e2e (host-only, on the rig)

The gate from the plan doc is the whole e2e suite green on kind at one
node and three (`pnpm vitest run --project e2e` and `--project api-k8s`
against the rig's cluster, after a `yaac cluster install` from this
branch). No new e2e file: the tuning has no route, no CLI surface and no
worktree-visible behavior beyond "subagent fan-out does not die", which
the existing suites already exercise. What the e2e run proves here is
that the changed DaemonSet still converges and that worktrees still
start, build and reach the world on a node the installer tuned.

## Verification: the gate as a procedure

The plan doc's gate is `cluster check` green after a podman-machine
restart with no install re-run for the sysctls. The rig is Linux
(memory: `/home/ben/yaac-test`), where there is no podman machine and a
kind node's sysctl writes land on the host kernel, so the procedure has a
Linux form and a macOS form. Both start from a converged install.

1. Build and install from this branch:
   `source /home/ben/yaac-test/env.sh && pnpm build && HOME=/home/ben yt cluster install`.
   The finishing check must show `node-fixups` and `node-tuning` both
   pass, and `kubectl -n yaac logs -l app=yaac-gvisor-install` must show
   the tuning lines and NOT "restarting containerd" on the re-apply.
2. Undo the volatile state by hand, the way a restart would. Linux:
   ```sh
   sudo sysctl -w vm.min_free_kbytes=67584 vm.compaction_proactiveness=20 \
     fs.inotify.max_user_instances=128 fs.inotify.max_user_watches=8192
   podman exec yaac-test-control-plane rm -f /etc/systemd/system.conf.d/10-yaac-tasksmax.conf
   podman restart yaac-test-control-plane
   ```
   macOS: `podman machine stop && podman machine start`. Either way wait
   for `kubectl get nodes` to report Ready.
3. `yt cluster check` with NO install re-run. `node-tuning` passes,
   `sysctl vm.min_free_kbytes` on the host (or inside the machine) reads
   `262144`, the drop-in is back, and the installer log shows the pass
   that restored them.
4. The timer path, without a restart: repeat the `sysctl -w` line, then
   either wait ten minutes or `kubectl -n yaac delete pod -l
   app=yaac-gvisor-install`; the check passes again.
5. Three nodes: a throwaway rig per the memory's recipe, `--nodes 3`,
   steps 2 to 3 against a worker (`yaac-test-<tag>-worker`), plus the
   `runsc-nodes` / `volume-nodes` sweep still passing.
6. The e2e tiers at both topologies, as above.

Step 2 lowers the DEV HOST's sysctls, and the production `yaac` cluster's
installer raises them back within its own interval. That is the intended
behavior and worth knowing before running it on a host with live
worktrees: the window is at most ten minutes.

## Open questions and risks

- **Fatal or best-effort tuning.** Recommended above: a failed tuning
  write ends the pass and the node never gets the runtime label. The
  alternative (log and continue) keeps worktrees schedulable on a node
  that will lose them under fan-out. Fail loud is the codebase's rule for
  silent-degradation shapes and is what this plan specifies; flag it in
  the PR so the choice is explicit.
- **`--byo` semantics for the kind pair.** The plan doc says both are
  skipped under `--byo`. The byo-on-kind tier (step 6) installs with
  `--byo` onto a kind cluster whose worktrees still hit podman's 2048-pid
  ceiling without `podman update`. Recommendation: keep "are the nodes
  podman containers on this host" as the switch, which is correct on both
  backends, and let step 6 decide whether `--byo` should additionally
  refuse to touch a node container. This step changes nothing about the
  switch.
- **`min_free_kbytes` on small cloud nodes.** 256 MiB is a virtiofs
  number; on a 2 GiB node it is a large reservation. Raise-only protects
  an operator who set more, not one who wants less. Step 7 measures this
  on real targets; this step keeps the value.
- **`/proc/sys` writability from the pod.** Privileged containers get it
  read-write under containerd; if a CRI configuration ever mounts it
  read-only, the fallback is `nsenter -t 1 -m -- sh -c 'echo ... >
  /proc/sys/...'`, a one-line change in `nodeTuningScript`. The
  verification procedure catches this on kind; step 7 catches it on real
  nodes.
- **`daemon-reexec` and running units.** `DefaultTasksMax` applies to
  units started after the reexec, which is the behavior today and enough,
  since worktree pods start after the installer is Ready on their node.
  Not changed here; a `daemon-reload` would likely suffice and is not
  worth the churn.
- **The housekeeping flag stays kind-only.** On a byo pool it is the
  provider's kubelet config (`--kubelet-arg=housekeeping-interval=300s`
  on k3s, the launch template on EKS). Step 7 documents it per target in
  docs/cloud-hosting.md; this step only stops claiming install applies it
  everywhere.
- **Immutable `/etc` nodes.** A `DirectoryOrCreate` hostPath into
  `/etc/systemd/system.conf.d` fails to mount on a read-only root, leaving
  the installer pod Pending and the node unlabelled. Those nodes are
  already outside the plan's envelope (Bottlerocket, Autopilot), and the
  failure is visible in `runsc-nodes`.
- **Rolling the installer on upgrade.** Re-applying the DaemonSet restarts
  its pods, which drop their ready marker for the length of one pass.
  Nothing schedules on the marker (the RuntimeClasses select on the node
  label, which persists), so no worktree is affected. Confirm in step 1 of
  the procedure that the log shows no containerd restart.

## Commits, in order

Each lands green under `pnpm lint` and `unit:server`; the k8s e2e tiers
run once on the branch before merge.

1. **Substrate: the installer tunes the node.** `node-tuning.ts`, the
   `gvisor.ts` script and mounts, the barrel exports, `gvisor.test.ts` and
   `gvisor-installer.test.ts`. Install still applies the same values via
   `podman exec`, so this commit double-applies idempotently and every
   existing install test stays green.
2. **Install and check narrow to the kind pair.** `applyKindNodeFixups`,
   the constants moved out of `check.ts`, the narrowed `node-fixups`, the
   new `node-tuning` gate, `install.test.ts` and `check.test.ts`.
3. **Docs and command text.** docs/cluster-setup.md, README.md, the CLI
   description and command doc comment, the module headers in
   `install.ts` and `check.ts`, the step removed from docs/plans/cloud-k8s.md,
   and this plan deleted.
