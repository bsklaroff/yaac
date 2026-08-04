# Built-in skills

Skills yaac ships in its own package and injects into **every** session, for
every agent tool (Claude Code, Codex, OpenCode, pi).

Each skill is a `<name>/SKILL.md` directory here (same format as any personal
skill). At session create they are staged fresh from the install and mounted
read-only into each tool's personal skills root — never written into the
per-project config dirs, so they track the installed yaac version and never go
stale. Discovery surfaces them as the `system` / `yaac` tier.

See `packages/server/src/features/skills/builtin.ts` (staging + mounts) and
`packages/server/src/features/skills/discover.ts` (discovery).

Add a skill by dropping a `<name>/SKILL.md` dir in here. Keep names distinct
from what users are likely to name their own personal skills (the two share a
directory in-pod).

Shipped skills:

- **`yaac-autoconfig`** — generate a `yaac-config.json` template for the current
  repo (install/build/start the project + forward its ports) for the user to
  apply to their project config.
- **`yaac-spawn`** — start a sibling session in this project with an initial
  prompt, via the in-session `yaac-spawn` command.
- **`yaac-watch-prs`** — watch the project's GitHub repo for PR updates (opened
  / comment / commit), one event line per update, via `yaac-watch-prs`.
- **`push-pr`** — commit the current branch, open a PR, then watch it for
  reviewer comments and address them.
- **`spawn-pr-reviewers`** — watch for newly opened PRs and spawn a sibling
  session to review each one, post its findings to the PR, and re-review as it
  changes.
