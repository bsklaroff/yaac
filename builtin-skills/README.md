# Built-in skills

Skills yaac ships in its own package and injects into **every** session, for
every agent tool (Claude Code, Codex, OpenCode, pi).

Each skill is a `<name>/SKILL.md` directory here (same format as any personal
skill). At session create they are staged fresh from the install and mounted
read-only into each tool's personal skills root — never written into the
per-project config dirs, so they track the installed yaac version and never go
stale. Discovery surfaces them as the `system` / `yaac` tier.

See `packages/server/src/lib/skills/builtin.ts` (staging + mounts) and
`packages/server/src/lib/skills/discover.ts` (discovery).

Add a skill by dropping a `<name>/SKILL.md` dir in here. Keep names distinct
from what users are likely to name their own personal skills (the two share a
directory in-pod).

Shipped skills:

- **`yaac-autoconfig`** — generate a `yaac-config.json` template for the current
  repo (install/build/start the project + forward its ports) for the user to
  apply to their project config.
