# Uid-agnostic images

Every image yaac ships works when run as any uid. Pods still run as the
install host's uid (a hostPath requirement, explained in
docs/server-in-cluster.md "The uid everything runs as"), but no image
depends on it. So one image set, under one content-hash tag, serves a macOS
host at uid 501 and a Linux host at 1000. That is what lets images be
shared, cached across machines and shipped prebuilt, and why `yaac cluster
install` on a second machine can find its images already in the registry.

OpenShift requires the same pattern of every image it runs.

## The image half

`dockerfiles/Dockerfile.default` (and `Dockerfile.server`, which has the
same shape) creates the user like this:

```dockerfile
RUN userdel -r ubuntu 2>/dev/null; groupadd -o -g 0 yaac && \
    useradd -m -u 1000 -g 0 -s /bin/zsh yaac && \
    echo 'yaac ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers && \
    chmod -R g=u /home/yaac && \
    chgrp 0 /etc/passwd && chmod g=u /etc/passwd
```

What makes this work, so that an ordinary Dockerfile built on the image is
correct with nothing written:

- **Primary group 0.** The user's primary group, not just the home
  directory's, is 0. So every file a later layer creates while running as
  `yaac` is already group 0. Group 0 is also named `yaac`, so
  `chown yaac:yaac` and `COPY --chown=yaac:yaac` give a file the ids a pod
  needs.
- **`umask 002` from the base image.** Group ownership is not enough; the
  group also needs write permission. `Dockerfile.default` sets `SHELL` to a
  wrapper (`/usr/local/bin/yaac-run`) that applies `umask 002` and runs the
  step, and BuildKit carries a parent's `SHELL` into the images built on
  it, so every shell-form `RUN` in the trusted chain, a project's image and
  a user's gets it. The trusted chain is built with BuildKit for this
  reason: an image podman pushes has an OCI config, which has no `SHELL`
  (docs/image-builds.md "The trusted chain").
- **A group-writable `/etc/passwd`**, for the runtime half below.
- **The normalize step.** After a Dockerfile's last instruction the builder
  runs one more step (`NORMALIZE_STEP`), as root through the `sudo` the base
  image grants `yaac`: everything under `/home/yaac` goes to `yaac`, group
  0, with the owner's bits for the group, and so does any file `yaac` owns
  elsewhere, so a `COPY --chown=yaac … /app` is writable at any uid. It
  covers what the umask cannot: an installer that picks its own modes, an
  exec-form `RUN`, a Dockerfile with its own `SHELL`, and a `COPY` into the
  home directory with no `--chown`, which Docker writes as root whatever
  `USER` says. It touches only the paths that need it and prints them with
  their size. A standalone image with no `sudo` gets the step as its own
  user, which fixes what that user owns and reports the rest.

Fixing a file in a later layer copies it, so the normalize step costs the
size of what it fixes, and the printed size is how a large one gets
noticed: `--chown` on the `COPY`, or fixing modes in the step that wrote
the files, avoids the copy. The shipped Dockerfiles do the latter, and the
trusted chain's builds end with the normalize step too, so a shipped step
that leaves files without group write shows in the install log rather than
in every project's image. Scratch their steps leave in `/tmp` (Node's
compile cache, mktemp dirs) is deleted at the end instead of fixed.
`chgrp -R`/`chmod -R` in a separate step copies
every file it touches; for the Playwright browser tree alone that is about
1 GB, which is why that tree's permissions are set inside its install step.

### Group write is not ownership

`chmod()` requires owning the file; group permissions do not help. So a
file shipped in the image can never be chmod-ed by the pod, and a tool that
chmods its own config on every write cannot be fixed by any mode baked into
the image. npm is one: it chmods `~/.npmrc` whenever it rewrites it, so a
shipped `~/.npmrc` makes `npm config set` and `npm login` fail with EPERM
at any uid other than the image's.

The fix is to not ship the file. npm's global prefix is set with `ENV
NPM_CONFIG_PREFIX` instead of a baked `~/.npmrc`, so the first pod that
writes config creates a file it owns. Prefer an environment variable, or
let the tool create the file on first use. Everything else in the image is
rewritten by replacing or truncating the file, which group write allows.

Setting a file's times to chosen values needs ownership too. omp sets them
on the dir it unpacks its native add-on into before unpacking, so a pod
cannot add a file to the image's copy of that dir: it must already hold
every add-on a pod may load, which is why `dockerfiles/agent-patches/omp-homes.js`
unpacks both x64 CPU variants at build.

## The runtime half

`installSecurityContext` (`#drivers/k8s/substrate`) gives every yaac pod
`runAsUser`/`runAsGroup` set to the install uid (the host's on kind, a fixed
1000 on byo) and **`supplementalGroups: [0]`**. Group 0 is what picks up the
image's group permissions; without it, a pod at a uid other than 1000
cannot write anything in its own home. It is a supplementary group rather
than `runAsGroup: 0` so that files the pod creates on a claim get the
install's own group.

That leaves one gap the group cannot fill: **`getpwuid()` has no entry for
the running uid.** The image's entry is `yaac:x:1000:0`, so a pod at 501 has
a uid with no name and no home. Several tools break:

| caller | behavior with no passwd entry |
|---|---|
| `ssh` | exits 255, "No user exists for uid", which breaks git over ssh |
| `sudo` | the image's NOPASSWD line names the user, so it no longer matches |
| `zsh`, `git`, node's `os.userInfo()` | show a bare number |

So at pod start the `yaac` entry is rewritten to the running uid and gid:
by `workspace-bin/yaac-workspace-init` in workspace pods (run from their
postStart hook), and by `dockerfiles/server-entrypoint.sh` in the server,
whose Deployment has no hook. Both must keep two properties:

- **Replace the line; never add a second one.** `getpwnam("yaac")` and
  `getpwuid(<running uid>)` must resolve to each other. With two entries,
  name lookups return the first one, so anything that resolves `yaac` by
  name (`chown yaac`, `sudo -u yaac`) acts as uid 1000.
- **Truncate the file in place; never use `sed -i`.** `sed -i` renames a
  temp file over `/etc/passwd`, which needs write permission on `/etc`. The
  pod can write the file but not the directory.

If the write fails, the script warns and carries on: most of a workspace
works without the entry, and a pod that will not start is worse. On a
uid-1000 host the rewrite changes nothing.

`/etc/group` is left alone. Its `yaac` entry is a second name for gid 0,
which does not move with the running uid, and the host gid simply shows as
whichever image group has that number.

## Verifying a change

Unit tests cover the Dockerfile text and the pod manifest.
`test/e2e/arbitrary-uid.test.ts` runs a real workspace pod at a uid no user
has, which is the only automated check that this works on a uid-1000
developer host. Neither can prove the hostPath half. That needs a `yaac
cluster install` on a macOS host, a workspace that starts and writes its
checkout, and a check that the tags it resolves are the ones a Linux host
already pushed.
