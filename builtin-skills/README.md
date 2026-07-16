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

No skills ship yet — drop a `<name>/SKILL.md` dir in here to add one. Keep
names distinct from what users are likely to name their own personal skills
(the two share a directory in-pod).
