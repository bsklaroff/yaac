# Fewer subPath mounts on the workspace container

A proposal, not built. It cuts the workspace container's `subPath` mounts
from 60 to 21, which should take about 0.2 s off every k8s workspace start:
cold starts, restarts and prewarmed spares alike, on every cluster.

## What the mounts cost

Before kubelet asks the runtime for a container it prepares each of the
container's `subPath` mounts in turn: it opens the path one component at a
time and runs `mount` twice. On a kind node that is about 6 ms a mount.
Everything a workspace mounts from the global claim is a `subPath` of it
(`mount-sources.ts`), so the workspace container has sixty.

Measured over 16 starts (kubelet v1.37.0 at log verbosity 5, from "Creating
container in pod" to containerd's `CreateContainer`): 271 to 459 ms in all.

| Mounts | Count | Time |
|---|---|---|
| Built-in skills, one per skill per tool (6 × 5) | 30 | 119–221 ms, about 165 |
| Helper commands, one per file under `/usr/local/bin` | 11 | 46–82 ms, about 60 |
| Tool state (`.claude`, `.codex`, history, sessions, …) | 19 | 100–178 ms, about 115 |

The first two rows are the same few directories mounted many times. This
plan mounts each once.

## Part 1: helper commands, 11 mounts to 1

Each `workspace-bin/` script is staged per workspace and mounted read-only
at `/usr/local/bin/<name>` (`workspaceBinMounts`). Mount the staged
directory once, and let the names under `/usr/local/bin` be links the image
already holds.

- **One mount.** `workspaceBinMounts` returns a single read-only mount of
  the staging dir at a fixed in-pod directory, `/opt/yaac/bin`.
  `stageWorkspaceBin` no longer needs to return names if nothing else reads
  them.
- **Links in the base image.** `dockerfiles/Dockerfile.default` creates
  `/usr/local/bin/<name>` → `/opt/yaac/bin/<name>` for each script, the
  names written out in the Dockerfile. Every image layered on the base has
  the links, so every existing reference keeps working: the pod's
  `postStart` and `preStop` commands, hooks that call `yaac-agent-report`
  by bare name, `which yaac-mama`.
- **A standalone image has no links.** A project's `Dockerfile.yaac` may
  replace the base image outright (docs/project-config.md). A workspace on
  such an image keeps today's one mount per file, so `workspaceBinMounts`
  takes whether the image is built on the base. The image layer already
  knows (`build-coordinator.ts` skips the layered steps for a standalone
  Dockerfile); the workspace create has to be told. The alternative,
  requiring a standalone image to make the links itself, would fail the
  `postStart` hook of every such image that predates the rule.
- **A test keeps the list honest.** `dockerfiles.test.ts` asserts the
  Dockerfile's names equal the files in `workspace-bin/`. Adding a script
  without its link fails the test, and adding the link changes the
  Dockerfile, whose hash is the base image's tag, so the image chain
  rebuilds.
- **The tree container** runs the base image and mounts `yaac-tree` by
  itself at `/usr/local/bin/yaac-tree` (`tree-mounts.ts`), which is now a
  link in that image. Mount the file at `/opt/yaac/bin/yaac-tree` instead,
  so the link resolves and nothing is mounted over a link.
- **Containerless** reads this mount list to build `PATH`: `pathPrefix` and
  the mount loop in `launch.ts` look for mount paths under
  `/usr/local/bin/`. They match the one directory mount instead and take
  its source as the directory.

Nothing needs migrating. A server resolves the base image's tag from its
own Dockerfile, so a pod spec with the one mount always runs an image with
the links, and pods and spares from before keep the spec and image they
have. The cost is one rebuild of the image chain on upgrade, as any change
to `Dockerfile.default` brings.

Setting `PATH` instead of baking links is not an option: a project's or a
user's Dockerfile can replace `PATH`, and the hook commands name
`/usr/local/bin` outright.

## Part 2: built-in skills, 30 mounts to 1

Each built-in skill is staged per workspace and mounted read-only at
`<root>/<name>` in each of the five tools' personal skills roots
(`builtinSkillMounts`), over an empty directory the server makes first
(`reconcileSharedSkillRoots` with `'mountpoint'`). Mount the staged
directory once and make each `<root>/<name>` a link into it, which is how
containerless already delivers them.

- **One mount.** `builtinSkillMounts` returns a single read-only mount of
  the staging dir at `/opt/yaac/builtin-skills`. The last component has to
  be `builtin-skills`: `isBuiltinSkillLink` recognizes yaac's links by the
  name of the directory they point into, and the prune and re-aim logic
  rests on it.
- **Links in the shared roots.** `reconcileSharedSkillRoots` plants
  `<root>/<name>` → `/opt/yaac/builtin-skills/<name>` for a sandboxed
  workspace, where containerless plants a link into the install dir. It
  takes the link's target directory in place of the `SkillDelivery` mode;
  `'mountpoint'`, `makeMountpoint` and the type go.
- **Each workspace still gets its own version.** The roots are shared by a
  project's workspaces, but each pod mounts its own staged copy at that one
  path, so the same link leads each pod to the copy made when it was
  created.
- **Discovery is unchanged.** `discover.ts` lists the built-ins from the
  install dir and already leaves yaac's links out of the personal tier. In
  the server pod the link happens to resolve, to the server's own copy
  under `/opt/yaac`, which is the copy discovery reads anyway.

### Two things this changes

**A built-in skill stops being tamper-proof within a project.** Today
`<root>/<name>` is a read-only mount: an agent can neither change the skill
nor remove the name. As a link in a root the agent can write, the name can
be deleted or pointed elsewhere, for every workspace of the project, and
the reconcile then takes a re-pointed link for the user's own and leaves
it. The skill's files stay read-only. How much this gives away is small:
the same agent can already add any skill to that root and edit the tool
settings beside it, both shared with the project's other workspaces. It is
still a decision to make, not a detail.

**Projects from before hold empty mountpoint directories** under the
built-in skills' names, and `linkSkill` reads a real directory there as the
user's own skill and leaves it. So a legacy step: an empty directory named
after a shipped skill is a retired mountpoint, removed with `rmdir` (which
refuses a directory with anything in it, so a real skill is never touched)
and replaced by the link. It gets its entry in
`docs/legacy-compat-shims.md`: it reads those directories; removed too
early, a project not yet converted shows new workspaces an empty directory
where each built-in skill should be; it is safe to remove once every
project has had a workspace created since.

A workspace running since before the change still has its mounts over those
directories. What it sees when the directory under a mount is replaced by a
link is not known, and under gVisor it may differ between a kind node's
hostPath and an NFS claim. The first step of the work is to try it on a
rig. The two ways to handle it:

- **Accept the break** (recommended): such a workspace may lose the
  built-in skills until it is restarted. They are skills an agent invokes
  by name (`push-pr`, `yaac-mama`), so the loss is visible and a restart
  fixes it.
- **Hold the conversion** for a project while any workspace created before
  the change is running. That needs a way to tell those pods apart and
  keeps the old delivery alive beside the new one until they are gone.

## What stays

The 19 tool-state mounts. Each lands at a different path inside a tool's
home, so merging them means links inside those homes, which each tool would
have to be shown to tolerate. Not proposed.

The staged `bin` and `builtin-skills` directories could share one parent
and one mount at `/opt/yaac`, saving one more. It ties `#domain/skills` to
`#domain/workspaces` for 6 ms and is not worth it.

## Order

Part 1 first: it has no migration, and its one decision (what a standalone
image gets) has a safe default. Part 2 after its two decisions are made and
the rig trial is done. They are separate changes and either can ship alone.

## Tests

- `pod-job.test.ts`, `start.test.ts`, `launch.test.ts`: the mount lists.
- `builtin.test.ts`, `builtin-skills.test.ts`: links for a sandboxed
  project; the legacy step converts an empty directory and leaves one with
  a `SKILL.md` in it; a user's own link is kept.
- `dockerfiles.test.ts`: the link list equals `workspace-bin/`.
- A workspace on a standalone image still starts and finds the helper
  commands. No e2e case builds a standalone image today, so this is a new
  one, or a unit test of the mount list plus a manual check.
- `test/e2e-cli/workspace-create-suite.test.ts`: "mounts each builtin skill
  over a mountpoint the SERVER made" becomes a check that each of the five
  roots lists every skill, that `SKILL.md` reads, and that the files are
  read-only.
- `test/e2e-cli/workspace-mama-suite.test.ts`: `which yaac-mama` still
  answers `/usr/local/bin/yaac-mama`, and writing to it still fails.
- `test/e2e-containerless/workspace-suite.test.ts`: the helper commands are
  still on `PATH`.
- One model turn per tool that invokes a built-in skill, or the manual
  equivalent, since a link is only as good as each tool's willingness to
  follow it. Containerless already depends on all five following links.

## Measuring

Ten starts before and after on a kind rig, every run reported: the time
from kubelet's "Creating container in pod" for `workspace` to containerd's
`CreateContainer`, with kubelet at log verbosity 4, and the count of "Bound
SubPath" lines between them. Expected: 60 mounts and about 350 ms before;
50 and about 290 ms after part 1; 21 and about 125 ms after both.

## Docs to update when it ships

`docs/node-local-workspaces.md` "Start" (the mount count and its cost),
`builtin-skills/README.md` and the header comments of `builtin.ts` and
`workspace-bin.ts` (how each is delivered), `docs/containerless-driver.md`
(how it finds the helper commands), and `docs/legacy-compat-shims.md`.
