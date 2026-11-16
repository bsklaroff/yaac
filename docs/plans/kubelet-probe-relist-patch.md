# A patched kubelet on kind nodes

A proposal, not built. It removes the wait between the tree container's
startup probe passing and kubelet starting the workspace container
(docs/node-local-workspaces.md "Start"): up to a second, half on average, on
every cold start and on every restart whose restore takes under a second.

The patch has not been built or run. Step 1 below does that on a test rig
and decides whether the rest is worth doing.

## The wait

Kubelet's pod worker, before each sync of a pod, waits for a listing of the
pod's containers newer than the end of its previous sync
(`podCache.GetNewerThan` in `pkg/kubelet/pod_workers.go`). Since v1.36
kubelet lists one pod on demand right after a sync that took an action
(`PLEGOnDemandRelist`), so the next sync starts at once. A sync that took no
action asks for nothing, and whatever follows it waits for the listing of
every pod, which runs once a second.

The sync that follows the tree container's start takes no action. So the
sync the startup probe asks for waits for the global listing. Measured on a
kind node (kubelet v1.37.0, 14 cold starts): 8 to 992 ms, mean 476 ms, and
every sync began 2 to 6 ms after a global listing started. After an 8 s
restore the wait was 0 to 1 ms.

No kubelet setting changes this. The period is a constant, and the
`EventedPLEG` gate lists a pod early only when one of its containers stops;
with it on, eleven cold starts waited 64 to 992 ms.

## The patch

One call, in `handleProbeSync` in `pkg/kubelet/kubelet.go`:

```go
 	logger.V(1).Info("SyncLoop (probe)", "probe", probe, "status", status, "pod", klog.KObj(pod))
 	handler.HandlePodSyncs(ctx, []*v1.Pod{pod})
+	// A probe result changes nothing in the runtime, so no PLEG event follows it:
+	// relist the pod so its worker is not left waiting for the next global relist.
+	kl.RequestPodRelist(logger, pod.UID)
 }
```

`RequestPodRelist` queues a listing of that one pod. The listing stamps the
pod's cache entry with the time it began (`SetObservedTime`), which is later
than the worker's last sync, so a worker blocked in `GetNewerThan` proceeds.
Kubelet already pairs the same two calls in `syncPodNow`, for an in-place
resize. The cost is one filtered container listing each time a probe's
result changes, not each time a probe runs.

The patch is kept as one file, `k8s/kubelet/probe-relist.patch`, applied to
the upstream tag the kind node image is built from.

## Where it applies

- **kind installs**, which is what this plan covers. `k8s/kind-config.yaml`
  pins the node image by digest, so there is one Kubernetes version to
  build for.
- **Not k3s** (`infra/hetzner-k3s`). k3s has no kubelet binary: kubelet is
  compiled into `k3s` from k3s's own fork of Kubernetes. The same line
  applies there, but shipping it means forking that fork, building all of
  k3s (so the patched binary is also the apiserver and scheduler), and
  hosting it where the control node and every autoscaled worker fetch it at
  boot. That is a second build and a second delivery path, and is left to
  the upstream fix.
- **Not a cluster yaac did not provision.** Its nodes are not yaac's to
  change.

## Steps

### 1. Prove it on a rig

Before any install code, build the patched kubelet once by hand and measure.

1. Build `cmd/kubelet` at the pinned tag with the patch, in a container (Go
   1.26.6, the tag's `.go-version`), for the rig's architecture.
2. On one test rig's node, with the dispatcher's agreement: copy the stock
   `/usr/bin/kubelet` aside, put the patched one in, restart kubelet.
3. Run ten cold starts (`workspace create --no-steps --no-session`, one at a
   time) and three restarts, with kubelet at log verbosity 5, and read each
   pod's "Processing pod event" to "SyncPod enter" gap, as the measurements
   above were taken.
4. Run the k8s e2e tiers once on the patched node.
5. Put the stock binary back.

Go on only if the wait falls to a few milliseconds on every run and the
tiers pass. Record the build's wall time, image size and peak disk; they
decide between the two build options in step 2.

### 2. Build

The build is a container build, like every other image `yaac cluster
install` makes, cached under a content-hash tag so it runs once per pinned
version:

- A `k8s/kubelet/Containerfile` with two stages: a digest-pinned `golang`
  image that fetches the Kubernetes source at the pinned commit, applies the
  patch and builds `cmd/kubelet`; and a `scratch` stage holding only the
  binary.
- The tag is `contextHash()` of `k8s/kubelet/`, so a new patch or a new
  pinned commit rebuilds and nothing else does.
- The version string carries a suffix (`v1.37.0+yaac.1`, through the
  build's `KUBE_GIT_VERSION`), so `kubectl get nodes` and `cluster check`
  can tell a patched node from a stock one. Whether kubeadm or kind object
  to a suffixed version is checked in step 1.

If step 1 shows the build is too slow or too large for a user's first
install (it needs the Go image and about 1.5 GB of source), the alternative
is to build it at release time and publish the image, which `install` then
pulls by digest. That makes yaac a distributor of kubelet builds, for two
architectures, and adds a step to every release that moves the pin.

### 3. Install

A new step in the kind half of `runClusterInstall`
(`#drivers/k8s/install`), run for each node beside `applyKindNodeFixups`, so
it covers both a new cluster and an existing one being converged:

1. Read the node's kubelet version. If it is not the pinned version (a
   cluster made under an older pin keeps its node image), skip the node and
   say so. There is no build matrix.
2. If the node's `/usr/bin/kubelet` already has the patched build's
   checksum, do nothing.
3. Otherwise copy the stock binary to `/usr/bin/kubelet.stock` (once), copy
   the patched binary in with `podman cp`, and restart kubelet with
   `podman exec … systemctl restart kubelet`.
4. Wait for the node to report Ready on the patched version. If it does not
   within a bound, put the stock binary back, restart kubelet, and log a
   note. The install goes on: the patch is an optimization, and a cluster
   on the stock kubelet is a working cluster.

A kubelet restart leaves running pods alone, so this is safe on a cluster
with workspaces in it.

### 4. Check

`yaac cluster check` gains one line for kind installs: each node at the
pinned version runs the patched build, by its version suffix. A stock node
is a note, not a failure.

### 5. Tests

- `install.test.ts`: the step's decisions, with podman faked at the process
  boundary as the other install tests do: skip on a version mismatch, no-op
  on a matching checksum, swap and restart otherwise, restore on a node
  that does not come back.
- `check.test.ts`: the new line.
- The k8s e2e tiers run on rigs whose nodes `cluster install` has patched,
  so they cover the patched kubelet without changes. `test/global-setup.ts`
  builds nothing new: the kubelet image is an install artifact, not a pod
  image.
- A start-up measurement before and after on a rig, ten cold starts each,
  every run reported.

### 6. Upstream, and removing this

Report the wait on kubernetes/kubernetes#124704, which tracks pod workers
blocked in `GetNewerThan`, with the trace and numbers above, and offer the
one line or the wider form (the pod worker asking for a listing whenever it
is about to block). v1.38 is already in beta, so a fix lands in v1.39 at the
earliest.

This plan is deleted, with `k8s/kubelet/` and the install step, when the
pinned node image carries an upstream fix. Until then every bump of the pin
means re-applying the patch to the new tag, rebuilding, and re-running step
1's measurement. The code around the patch is being reworked upstream, so
expect the patch to need redoing at each minor.

## What it costs

- **A kubelet build to own.** A bad build breaks every pod on the node, not
  only workspaces. The restore in step 3 bounds that to a node that fails
  to come back; a kubelet that runs but misbehaves is found by the e2e
  tiers or not at all.
- **Security patch releases.** A stock kind node gets a kubelet fix by
  moving the node image pin. A patched one also needs the rebuild, so the
  pin and the patch move together or the node falls behind.
- **Install time and disk**, once per pinned version, sized by step 1.
- **Divergence between substrates.** kind starts workspaces up to a second
  sooner than k3s and byo clusters, so a start-up number measured on kind
  no longer speaks for them.

## What it does not change

- The claim of a prewarmed spare: that pod's workspace container is already
  running.
- The time kubelet spends binding the workspace container's `subPath`
  mounts, which is docs/plans/fewer-subpath-mounts.md.

## Open questions

- Does a version suffix upset kind or kubeadm, which compare component
  versions?
- Does the build fit a first install, or does it have to be published?
- macOS: the node runs inside the podman machine. `podman cp` and
  `podman exec` reach it through the remote client, and the build must be
  for the machine's architecture. Not tried.
- Is the one line enough, or do other syncs (an API update of the pod, a
  retry after an error) wait the same way often enough to want the wider
  form? The traces so far show only the probe.
