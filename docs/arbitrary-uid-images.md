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
RUN userdel -r ubuntu 2>/dev/null; useradd -m -u 1000 -g 0 -s /bin/zsh yaac && \
    echo 'yaac ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers && \
    chmod -R g=u /home/yaac && \
    chgrp 0 /etc/passwd && chmod g=u /etc/passwd
```

Four things make this work:

- **Primary group 0.** The user's primary group, not just the home
  directory's, is 0. So every file a later layer creates while running as
  `yaac` is already group 0, with no fix-up step. That covers
  `Dockerfile.tools`, the nestable layer, a project's `Dockerfile.yaac` and
  a user's `Dockerfile.user`.
- **`umask 002` on every `RUN` that runs as `yaac`.** Group ownership is not
  enough; the group also needs write permission. The umask cannot be set
  once for the whole build, because podman builds OCI-format images, which
  ignore the `SHELL` directive. So each step sets it. `dockerfiles.test.ts`
  checks every shipped Dockerfile and fails on a `yaac` step without it.
  That test is the only safeguard: a step that forgets still builds, and
  still works on a uid-1000 Linux host.
- **A group-writable `/etc/passwd`**, for the runtime half below.
- **Fixing modes an installer chose itself.** The umask only covers files
  the shell creates. A tool that sets its own modes is not covered: the
  Claude installer creates `~/.claude/sessions` as 0700, which only uid
  1000 can write, and the agent rewrites it every session. So the step that
  runs such an installer fixes what it wrote, using `find` rather than a
  list of paths, so a changed layout fails the build instead of silently
  becoming unwritable.

When adding anything later, fix permissions **in the step that creates the
files**, never in a separate step. `chgrp -R`/`chmod -R` in a new layer
copies every file it touches into that layer. For the Playwright browser
tree alone that is about 1 GB, which is why that tree's permissions are set
inside its install step.

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
  name lookups return the first one, and the nested engine's `chown yaac
  /run/podman/podman.sock` would give the socket to uid 1000.
- **Truncate the file in place; never use `sed -i`.** `sed -i` renames a
  temp file over `/etc/passwd`, which needs write permission on `/etc`. The
  pod can write the file but not the directory.

If the write fails, the script warns and carries on: most of a workspace
works without the entry, and a pod that will not start is worse. On a
uid-1000 host the rewrite changes nothing.

`/etc/group` is left alone. With primary group 0 there is no `yaac` group
to update, and the host gid simply shows as whichever image group has that
number.

## Verifying a change

Unit tests cover the Dockerfile text and the pod manifest.
`test/e2e/arbitrary-uid.test.ts` runs a real workspace pod at a uid no user
has, which is the only automated check that this works on a uid-1000
developer host. Neither can prove the hostPath half. That needs a `yaac
cluster install` on a macOS host, a workspace that starts and writes its
checkout, and a check that the tags it resolves are the ones a Linux host
already pushed.
