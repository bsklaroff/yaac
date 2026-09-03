# Uid-agnostic images

Every yaac-shipped image runs correctly as **any** uid. The uid a pod runs
as is still the install host's — that is a hostPath fact, and
docs/server-in-cluster.md is where it is explained — but no image knows it,
so one image set serves a macOS host at 501 and a Linux host at 1000 under
the same content-hash tag. That is what makes the chain shareable, cacheable
across machines, and shippable prebuilt, and it is why `yaac cluster
install` on a second machine can find its images already in the registry.

This is the pattern OpenShift requires of every image it runs.

## The image half

`dockerfiles/Dockerfile.default` (and `Dockerfile.server`, the same shape)
creates the user as:

```dockerfile
RUN userdel -r ubuntu 2>/dev/null; useradd -m -u 1000 -g 0 -s /bin/zsh yaac && \
    echo 'yaac ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers && \
    chmod -R g=u /home/yaac && \
    chgrp 0 /etc/passwd && chmod g=u /etc/passwd
```

Four things are load-bearing.

**Primary group 0.** Not just the home directory's group — the *user's*, so
that every file any later layer creates while running as `yaac` is already
group 0, with no fix-up step anywhere. That covers `Dockerfile.tools`, the
nestable layer, a project's `Dockerfile.yaac` and a user's
`Dockerfile.user` alike.

**`umask 002` on every `RUN` that runs as `yaac`.** Group ownership alone is
not enough; the mode has to grant the group write. The umask cannot be set
once for the whole build — a `SHELL` directive is silently ignored for
OCI-format builds, which is what podman produces — so each step states it,
and `dockerfiles.test.ts` walks every shipped Dockerfile and fails on a
`yaac` step that does not. That tripwire is the whole defence: a step that forgets
builds fine and works on a uid-1000 Linux host.

**A group-writable `/etc/passwd`.** See the runtime half below.

**Whatever an installer decided for itself.** The umask only reaches what
the shell creates; a tool that picks its own modes is not covered by it, and
the Claude installer's `~/.claude/sessions` (0700) is the case that bites —
a directory nothing but uid 1000 can write, holding state the agent rewrites
every session. So the step that runs such an installer normalizes what it
wrote, with a `find` rather than a path list so a changed layout fails the
build instead of silently going unwritable.

The one rule for anything added later: fix permissions *in the step that
creates the files*, never in a step of its own. `chgrp -R`/`chmod -R` in a
new layer copies up every file it touches — measured at ~1GB for the
Playwright browser tree alone, which is why that tree's grant lives inside
its install step.

### Group-writable is not the same as owned

`chmod()` requires **ownership**. No group grant substitutes for it, so a
file the image ships is a file the pod can never chmod — and a tool that
chmods its own config on every write cannot be fixed by any mode we bake.
npm is one: it chmods `~/.npmrc` whenever it rewrites it, so a shipped
`~/.npmrc` makes `npm config set` and `npm login` EPERM at any uid but the
image's own.

The fix for that shape is to **not ship the file**: npm's global prefix is
`ENV NPM_CONFIG_PREFIX` instead of a baked `~/.npmrc`, so the first pod to
write config creates a file it owns. Prefer an env var, or let the tool
create the file on first use, over shipping one and hoping nothing chmods
it. Everything else in the image is rewritten by replacement or by
truncation, both of which group write covers.

## The runtime half

`hostUidSecurityContext` (`#drivers/k8s/substrate`) stamps every yaac pod
with `runAsUser`/`runAsGroup` from the host and **`supplementalGroups: [0]`**.
The group is what picks up the image's grant; without it a pod on a host
whose uid is not 1000 can write nothing in its own home. It is a
supplementary group rather than `runAsGroup: 0` so that files the pod
creates on a hostPath land in the host user's own group.

That leaves one thing the group cannot fix: **`getpwuid()` has no answer for
the running uid.** The image's entry is `yaac:x:1000:0`, and a pod at 501 is
a uid with no name and no home. The consumers do not degrade gracefully:

| caller | behavior with no passwd entry |
|---|---|
| `ssh` | exits 255, "No user exists for uid" — takes out git over ssh |
| `sudo` | the image's NOPASSWD line names the *user*, so it stops matching |
| `zsh`, `git`, node's `os.userInfo()` | report a bare number |

So the entry is re-pointed at the running uid at pod start, by
`worktree-bin/yaac-worktree-init` for worktree pods (the postStart hook they
already run) and by `dockerfiles/server-entrypoint.sh` for the server, whose
Deployment has no hook to carry it. Both do the same thing and must keep the
same two properties:

- **Replace the line, never append a second one.** `getpwnam("yaac")` and
  `getpwuid(<running uid>)` have to resolve to each other. With two entries,
  name lookups keep returning the first — and the nested engine's `chown
  yaac /run/podman/podman.sock` would hand the socket to uid 1000.
- **Truncate in place, never `sed -i`.** `sed -i` renames a temp file over
  `/etc/passwd`, which needs write permission on `/etc`. The file is ours;
  the directory is not.

A failure to write it warns rather than exits: most of a worktree works
without the entry, and a pod that will not start is worse. On a uid-1000
host the whole thing is a no-op.

`/etc/group` is left alone. With primary group 0 there is no `yaac` group to
re-point, and the host gid simply prints as whatever group owns that number
in the image.

## What this does not change

The uid a pod runs as, and why. That is still the install host's, still
discovered by the install, and still a ceiling on a strict-virtiofs host —
docs/server-in-cluster.md, "The uid everything runs as".

## Verifying a change to it

Unit tests cover the Dockerfile text and the manifest, and `test/e2e/
arbitrary-uid.test.ts` runs a real worktree pod at a uid that is nobody's,
which is the only automated check that the machinery does anything on a
uid-1000 developer host. What neither can prove is the hostPath half: that
needs a `yaac cluster install` on a macOS host, a worktree that starts and
writes its checkout, and the observation that the tags it resolves are the
tags a Linux host already pushed.
