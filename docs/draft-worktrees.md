# Draft worktrees

A **draft worktree** is what the create dialog held when the user closed it
without creating or queueing, and chose to keep it. It is pure intent, like a
sidebar group: a row in `draft_worktrees` and nothing else — no worktree, no
checkout, no runtime, and nothing ever runs from it on its own.

## When the dialog asks

Dismissing the create dialog — the ×, Escape, a click outside — with a
non-blank prompt asks whether to **save** it as a draft, **discard** it, or
**keep editing**. A dialog with no prompt closes silently: settings alone are
already the project's create memory, so there is nothing to lose. Editing a
queued worktree never asks; it has its own Save.

A dialog reopened on a draft asks only if something changed since it was
saved, and then offers to save the changes or leave the draft as it was. A
save naming a draft that has gone meanwhile (created from or discarded in
another tab) saves the text as a new draft instead, so it always lands.

Two other ways out of the dialog lose nothing either. Create with a missing
git or agent credential sends the user to Settings; the user asked to create,
so a typed prompt is saved as a draft on the way without asking. And while a
prompt is unsaved, the page holds a reload or tab close with the browser's
leave-page prompt.

## What a draft holds

Every field as the dialog showed it — prompt, title, agent, model, UI mode,
permission mode, reference branch, group, and the **Start** field — so
reopening it puts back what was on screen. Model and branch are absent when the dialog had
not resolved them yet (catalog or branch list still loading); reopening then
takes the default, as a fresh open does. Start is the id of the worktree or
queued entry the create would have waited on, not a live reference: a parent
that is gone by the time the draft reopens leaves it starting now. Deleting
the draft's group clears it. A group only being named in the dialog's "+ New
group" box is not kept — it does not exist until a create or queue makes
it, and a draft holds groups by id — so the draft keeps the group picked
before the box was opened.

Creating or queueing from a reopened draft discards it. The create and queue
requests name the draft (`draftId`), and the server deletes it once the
worktree or queue entry exists — so a create that fails keeps the draft and
its prompt.

## Titles

A title set on the dialog's heading is the draft's `title`, and the worktree or
entry created from it carries it. Without one, the title sweep
(`reconcileGeneratedTitles`) titles drafts as it does live worktrees: a
prompt long enough to need summarizing gets one model attempt, written to
the draft's `generatedTitle`, which is shown but never carried into what is
created — that worktree is titled from its own prompt. Changing the prompt
clears the generated title, and the attempt is keyed on the prompt as well
as the draft, so the new prompt gets its own. The write is conditional on
the draft still holding the prompt it was generated from. The sweep runs on
the reconciler's resync, so a newly saved draft is titled within about a
minute; until then the sidebar shows the prompt's first line.

## Surfaces

- **Routes.** `/worktree/draft/save` (no `id` inserts; an `id` replaces that
  draft's fields wholesale, and a draft that is gone, or belongs to another
  project, answers `NOT_FOUND` rather than being re-created) and
  `/worktree/draft/discard`; `draftId` on `/worktree/create` and
  `/worktree/queue/create`.
- **Snapshot.** `draftWorktrees`, every project's, oldest first.
- **Webapp.** A collapsible **Drafts** section at the top of the sidebar,
  absent when the project has none, newest first. Clicking a draft reopens
  the create dialog on it; its `…` menu can also discard it.
- Removing a project deletes its drafts.
