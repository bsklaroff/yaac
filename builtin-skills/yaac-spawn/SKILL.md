---
name: yaac-spawn
description: Start a sibling yaac session in this project with an initial prompt, via the in-session `yaac-spawn` command. Use when the user asks to spawn, fork, or kick off another yaac session, or to farm a task out to a parallel session.
---

You are running **inside a yaac session**. The `yaac-spawn` command (already on
PATH) asks the host yaac server to start a **new sibling session in this same
project** and deliver a prompt to its agent. Use it directly — this skill is
just the manual.

## Usage

```
yaac-spawn [--tool claude|codex|opencode|pi] "<prompt>"
```

- **`<prompt>`** (required, exactly one argument — quote it): the initial
  prompt for the new session's agent. Plain text, max 10,000 characters. It is
  typed into the agent's terminal pane once the session is up.
- **`--tool`** (optional): which agent tool the new session runs. Omitted, it
  defaults to this session's own tool, then the configured project default,
  then `claude`.

On success it prints the **new session's id** on stdout and exits 0. On failure
it prints an error to stderr and exits non-zero.

## What actually happens

- The command POSTs the prompt to the yaac egress proxy (`yaac.internal`);
  the request is attributed to this session by pod IP — no token or config
  needed. The host server picks it up from its background loop and starts the
  session the same way a scheduled session fires: headless, in this project.
- **Fire-and-forget.** The id you get back is minted *before* provisioning
  finishes; the create runs detached and takes tens of seconds. You cannot
  watch progress from here — the user follows it in the yaac webapp. If the
  create fails after the id was returned, that only shows in the server log.
- **The sibling shares nothing with this session.** It gets a fresh worktree
  branched from the project's reference branch — it does not see this
  session's uncommitted changes, env, or conversation. Write the prompt
  self-contained; if the new session must build on work from here, commit and
  push a branch first and tell the prompt to fetch and check it out.

## Limits and errors

- Prompt: non-empty, ≤ 10,000 characters.
- Rate caps: at most 4 requests queued per session (and 32 total) at the
  proxy, and at most 3 spawn-initiated sessions provisioning at once per
  caller — exceeding these is an HTTP 429; wait and retry.
- **HTTP 504** after ~60s means the yaac server never picked the request up
  (likely not running on the host). Nothing was started; safe to retry.
- **HTTP 422** is a server-side rejection (e.g. unknown `--tool` value) with
  the reason in the body.
- "cannot reach the yaac proxy" means the egress path itself is broken —
  report it to the user rather than retrying.

## Guidance

- Don't spawn in a loop or fan out sessions unless the user asked for that
  scale — each session is a full container with its own agent.
- After spawning, report the printed session id(s) to the user and note the
  session is provisioning in the background (visible in the yaac webapp).
