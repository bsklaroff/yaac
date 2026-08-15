---
name: yaac-mama
description: Ask the yaac server running this session to list the project's sessions, start a sibling session with a prompt, retitle a session, stop a session (a sibling, or this one), or file sessions into named groups — via the in-session `yaac-mama` command. Use when the user asks to spawn, fork, or kick off another yaac session, farm a task out to a parallel one, see what else is running, rename/retitle a session, stop/shut down/wind down a session or this one when its work is done, or organize sessions into groups.
---

You are running **inside a yaac session**. The `yaac-mama` command (already on
PATH) asks the host yaac server to do a small, fixed set of things in **this
same project**. Use it directly — this skill is just the manual.

## Usage

```
yaac-mama list                                    # sessions + groups here
yaac-mama create [--tool T] [--model M] [--group G] "<prompt>"
yaac-mama rename [<session>] "<title>"            # omit the session to rename yourself
yaac-mama stop [<session>]                        # omit the session to stop yourself
yaac-mama group create "<name>"
yaac-mama group move <session> ["<group>"]        # omit the group to ungroup
yaac-mama models                                  # tools/models available
yaac-mama --help
```

That list is the whole surface. `yaac-mama` is a **strict subset** of the
`yaac` CLI, enforced by the server: it observes, labels, makes one new thing,
and stops one. Stopping is in reach precisely because it is reversible — a
stopped session keeps its checkout and its conversation, and the user can
restart it. There is no delete, no restart, no config. If a task needs one of
those, ask the user rather than looking for a way around it.

Everything is scoped to **this session's project**, which is not a flag you
pass — the server resolves who is calling and answers for that project only.

## The commands

- **`list`** — every running session in this project, with the group each is
  filed under and the prompt it started from; your own row is marked
  `(you)`. Then a line naming the project's groups. This is how you find a
  session id to pass to `group move`; ids print as their first 8 characters,
  and that prefix is what the other commands accept.

- **`create "<prompt>"`** — start a **new sibling session** in this project
  and deliver the prompt to its agent. Prints the new session's id on stdout
  and exits 0, so `id=$(yaac-mama create "…")` works.
  - **`--tool`**: `claude`, `codex`, `opencode`, or `pi`. Omitted, it
    defaults to this session's own tool, then the project default, then
    `claude`. **Run `yaac-mama models` before choosing** — a tool with no
    host credentials still spawns, and its agent then fails to authenticate.
  - **`--model`**: any model id the chosen tool accepts — an id or alias for
    claude/codex (e.g. `opus`), `provider/model` for opencode and pi (e.g.
    `anthropic/claude-opus-5`), where the provider must be the one that tool
    is authed for. There is no fixed list yaac enforces, only a shape check,
    so a typo'd id spawns and fails at the vendor.
  - **`--group`**: file the new session under this group, creating the group
    if it does not exist. Good for a fan-out you want kept together.

- **`rename [<session>] "<title>"`** — set the label the sidebar shows in
  place of a session's id. **Omit the session to rename yourself**, which is
  the common use: once you know what this session is actually doing, say so,
  and the user can see it without opening the session. Titles are trimmed,
  whitespace-collapsed and capped at 120 characters; the reply tells you what
  was stored. Renaming a sibling works the same way.

- **`stop [<session>]`** — end a session's running container (or tmux
  server): its agent stops, and its checkout, title, group and conversation
  all stay, so the user can restart it from the webapp. This is a stop, not a
  delete — but it is still a visible interruption, and the session's
  uncommitted work becomes reachable only by restarting it. **Omit the
  session to stop yourself**, which is the common use: a session spawned to
  do one job can wind itself down when the job is done. A session that exists
  but is not running is reported as such rather than as unknown.
  - **Stopping yourself is the last thing you do.** It tears down the very
    channel this command's reply comes back over, so the confirmation may
    never print — *the session ending is the confirmation*, and a missing
    reply is not an error and not something to retry. Commit and push
    anything worth keeping, and say whatever you need to say to the user,
    **before** you run it; nothing after it happens.

- **`group create "<name>"`** — make an empty group. Idempotent: naming one
  that already exists just resolves to it, so you never need to check first.

- **`group move <session> ["<group>"]`** — file a session under a group,
  creating the group if needed. `<session>` is an id or its 8-character
  prefix, from `yaac-mama list`. Omit the group entirely to return a session
  to the ungrouped list. Groups are how the user's sidebar is organized, so
  moving sessions is a real, visible edit — do it when it helps them, not to
  tidy up unasked.

- **`models`** — which agent tools have host credentials (with kind and
  provider) and each one's accepted model ids. The session cannot see host
  credentials itself, so this is the only way to know what is usable.

## What actually happens on `create`

- **Fire-and-forget.** The id comes back *before* provisioning finishes; the
  create runs detached and takes tens of seconds. You cannot watch progress
  from here — the user follows it in the yaac webapp.
- **The sibling shares nothing with this session.** It gets a fresh worktree
  branched from the project's reference branch — it does not see this
  session's uncommitted changes, env, or conversation. Write the prompt
  self-contained; if the new session must build on work from here, commit and
  push a branch first and tell the prompt to fetch and check it out.

## Limits and errors

- Prompt: non-empty, ≤ 10,000 characters.
- At most 8 requests queued per session (and 32 in total), and at most 8
  spawn-started sessions provisioning at once per caller — over that is an
  **HTTP 429**; wait and retry.
- **HTTP 422** is a server-side refusal with the reason in the text: an
  unknown command or option, a malformed `--model`, a session id that names
  nothing in this project, a group name that matches two groups. Read the
  message — it says what to pass instead.
- **HTTP 504** (containerized sessions) means the request timed out waiting
  for the server, and the message says which of two things happened. *"did
  not pick this up"* means nothing ran — safe to retry. *"took this request
  but never answered"* means the server had it and then died or lost the
  reply, so the command **may already have run**. `create` is not idempotent
  (every one mints a new session), so on that message run `yaac-mama list`
  and look for the session before retrying, or you will get a duplicate. The
  others are safe to repeat — a second `stop` just answers that the session
  is not running. A `stop` on yourself is the exception to all of this: no
  reply at all is the expected outcome, not a timeout to interpret.
- "cannot reach the yaac proxy" / "cannot reach the yaac server" means the
  path itself is broken — report it to the user rather than retrying.

## Guidance

- Don't spawn in a loop or fan out sessions unless the user asked for that
  scale — each session is a whole agent working in its own checkout.
- After spawning, report the printed session id(s) and note that the session
  is provisioning in the background (visible in the yaac webapp).
- Prefer `yaac-mama list` over guessing what else is running; it is cheap and
  it is the only view you have of your siblings.
- Stop a sibling when the user asked or when work you started there is
  finished — not to tidy up unasked. It interrupts a whole agent mid-turn,
  and any work it had not committed is only reachable by restarting it.
- Stop yourself only when the user asked, or when the prompt that spawned
  this session said to wind down when done. Finish first: commit, push,
  report. Never stop yourself just because you ran out of things to do —
  a session sitting idle costs the user nothing, and they may have a
  follow-up.
