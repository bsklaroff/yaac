# Built-in skills

Skills that ship inside the yaac package and are given to every workspace,
for every agent tool (Claude Code, Codex, OpenCode, pi). Each is a
`<name>/SKILL.md` directory, in the same format as a personal skill.

Delivery depends on the driver:

- **k8s.** Each workspace create copies the skills fresh from the install and
  mounts them read-only into every tool's personal skills root.
- **containerless.** There is no mount namespace, so each skill is symlinked
  once per project into the project's shared skills roots, pointing at the
  install.

Either way the skills track the installed yaac version and never go stale in a
config dir. The webapp's skill list shows them as `system` / `yaac`. The code
is `packages/server/src/domain/skills/builtin.ts` (delivery) and
`discover.ts` (listing).

## Writing one

A built-in skill runs under both drivers, so its commands may only assume what
a containerless workspace has: the user's own machine, without the tools the
session image adds. `jq` is the usual trap. Filter GitHub JSON with gh's own
`--jq` flag (gh embeds a jq engine), never a `| jq` pipe. For any other tool
the image provides, name a fallback or don't depend on it.

Pick a name users are unlikely to give their own skills. Both live in the same
directory; on a containerless host a user's skill of the same name wins and the
built-in one is not delivered.

## Shipped skills

- **`yaac-autoconfig`**: generate a `yaac-config.json` template for the repo
  (install, build and start the project, and forward its ports) for the user
  to apply.
- **`yaac-mama`**: ask the yaac server running this workspace to list the
  project's workspaces, start or queue a sibling, edit a queued one, retitle,
  stop, or group workspaces, through the in-workspace `yaac-mama` command.
- **`yaac-watch-prs`**: watch the project's GitHub repo for PR updates (opened,
  comment, commit), printing one line per event.
- **`push-pr`**: commit the branch, open a PR, then watch it for review
  comments and address them.
- **`review-pr`**: act as one PR's reviewer: post findings, watch for changes,
  re-review, approve once every finding is settled, then stop the workspace.
- **`spawn-pr-reviewers`**: watch for new PRs and start a sibling workspace to
  review each one with `review-pr`.
