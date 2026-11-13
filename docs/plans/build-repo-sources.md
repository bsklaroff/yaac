# Repos as build sources

A follow-up to docs/plans/buildkit-image-builds.md, which it assumes has
shipped: BuildKit builders, named images with revisions, one cache ref per
image. This is an outline. It names the shape and the questions, not the
design.

## What it is for

An image today is built from a Dockerfile and a few support files. This
lets a build also take files from the project's repos, at a commit a person
names or at the tip of a branch it follows. The case that matters most is a
release cycle: an image that carries the project's own code or tooling as
it stands on a release branch, rebuilt as that branch moves.

## Shape

- **An image lists repo inputs.** Each names one of the project's linked
  repos, optionally a directory in it, and either a commit or a branch to
  follow. The list is part of a revision, so changing it is versioned like
  a Dockerfile edit.
- **A Dockerfile reads an input as a named build context**, which is
  standard BuildKit: `COPY --from=<input name> . /src`.
- **The server supplies the files.** It exports the commit from the repo's
  main clone and streams it to the builder beside the build context. The
  builder gets no git credential and makes no fetch.
- **What an input resolves to goes into the image's tag**, so new content
  means a new build, and unchanged content means none.
- **A build records the commit each input was at**, with the rest of what
  it consumed.

## Following a branch without the noise

A followed branch can move many times a day. The pieces that would keep
that quiet, to be chosen between:

- **Hash the files, not the commit.** An input's contribution to the tag
  is the git tree of the directory it names, so a commit that does not
  touch that directory starts no build.
- **A branch moving is a build, not a revision.** The revision says
  "follow `release`"; the build list shows which commit each build took.
  History stays a record of what people changed.
- **Coalesce.** Only the newest tip is built; a push that arrives during a
  build replaces the one waiting behind it.
- **Report changes of state, not every build.** A notification when a
  followed image starts failing or recovers.
- **Or follow by hand.** A pinned input with an "update to the branch tip"
  action, for projects that want to choose the moment.

Creates already take the last built image
(docs/plans/buildkit-image-builds.md "Revision behavior"), so however often
a followed image rebuilds, nothing waits on it.

## Trust

With repo inputs, what a `RUN` step executes can come from a commit an
agent wrote, where today it comes only from a Dockerfile a person saved.
Two consequences.

**Approved and unapproved builds.** A build is approved when every input is
at a commit a person approved, or on a branch a person approved for this
use. The workflow approvals (docs/workflows.md) and a site's follow
approvals (docs/public-sites.md) are the precedents, and one of them should
probably be reused rather than a third list made. What may launch an
unapproved image is the question that follows: an agent's own workspace,
plausibly; a site release or a workspace holding run secrets, no.

**Cache refs split by trust.** A build of unapproved code must not be able
to plant a cache entry that an approved build later uses. So the two kinds
of build write separate caches, and an approved build reads only the
approved one. An unapproved build may read both, since reading the approved
cache only saves it work. This is the rule CI systems apply to pull-request
caches. Two things it needs from the registry:

- a grant can scope a repo, not a tag, so the unapproved cache is a repo of
  its own rather than another tag in `yaac-buildcache-<project id>`;
- a grant that reads a repo without being able to write it, which the gate
  does not have today.

## Open questions

- Which of the quieting pieces above, and whether following is the default
  or opt-in per input.
- Where approvals live, and who may make an image follow a branch.
- What an unapproved image may be used for.
- Size: a large repo as build input on every build. Directory inputs help;
  whether the 512 MB context cap covers inputs too.
- Submodules and LFS files in an input.
- Whether a failed build of a followed image should stop a site that
  deploys from the same branch, or the two stay independent.
