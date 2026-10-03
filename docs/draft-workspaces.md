# Draft workspaces

A **draft workspace** is the contents of the create dialog, kept when the user
closed it without creating or queueing. Like a sidebar group, it is only a
record of intent: a row in `draft_workspaces`, with no checkout and no
runtime. Nothing runs from a draft on its own.

## When the dialog asks

Closing the create dialog (the ×, Escape, or a click outside) with a non-blank
prompt asks whether to **save** a draft, **discard**, or **keep editing**. With
no prompt it closes silently, since the settings are already remembered as the
project's create defaults. Editing a queued workspace never asks; it has its
own Save.

A dialog reopened on a draft asks only if something changed, and then offers
to save the changes or leave the draft as it was. If the draft was deleted
meanwhile (created from or discarded in another tab), the save makes a new
draft instead.

Other exits keep the prompt too:

- **Save draft**, beside Create, saves without asking and closes. It is
  enabled once there is a prompt (and, on a reopened draft, a change), and is
  absent when editing a queued workspace.
- Create with a missing git or agent credential sends the user to Settings,
  and saves the typed prompt as a draft first without asking.
- While a prompt is unsaved, a page reload or tab close triggers the browser's
  leave-page prompt.

## What a draft holds

Every field as the dialog showed it: prompt, title, agent, model, UI mode,
permission mode, reference branch, group, and **Start**. Reopening the draft
restores the screen.

- Model and branch are empty if the dialog had not loaded them yet; reopening
  then uses the default, as a fresh dialog does.
- Start is the id of the workspace or queued entry the create would wait on.
  If that parent is gone when the draft reopens, Start falls back to now.
- Deleting the draft's group clears the field. A name typed into the "+ New
  group" box is not saved, because that group does not exist until a create
  or queue makes it; the draft keeps the group picked before the box opened.

Creating or queueing from a draft deletes it. The request names the draft
(`draftId`), which claims it (`claimDraft`): a second request naming a draft
already claimed is refused with `CONFLICT`, and one naming a draft that is
gone with `NOT_FOUND`, so two tabs or a retry cannot make two workspaces from
one draft. While the request runs the snapshot leaves the draft out, and the
server deletes it only after the workspace or queue entry exists, so a failed
create shows the draft again. The claim is held in memory, so a server
restart mid-create shows the draft again too.

## Titles

A title typed in the dialog's heading is the draft's `title`, and whatever is
created from the draft keeps it. The new workspace's provisioning row is
headed by that title, or by the generated one below.

Without one, the title sweep (`reconcileGeneratedTitles`) handles drafts as it
does live workspaces. A prompt long enough to need summarizing gets one model
attempt, stored as the draft's `generatedTitle`. A workspace created from the
draft uses it as its title; a queue entry stores it as its own
`generatedTitle`. This is skipped if the user set a title or changed the
prompt before creating.

Changing the prompt clears the generated title. Attempts are keyed on the
draft and the prompt, so a new prompt gets its own attempt, and the write only
lands if the draft still holds the prompt it was generated from. The sweep
runs on the reconciler's resync (every minute), so a new draft is titled
within about a minute. Until then the sidebar shows the prompt's first line.
The create dialog, reopened on an untitled draft or queued entry, is headed by
its generated title until the prompt is changed.

## Surfaces

- **Routes.** `/workspace/draft/save` inserts when given no `id`. With an `id`
  it replaces that draft's fields; a draft that is gone or belongs to another
  project answers `NOT_FOUND` instead of being re-created.
  `/workspace/draft/discard` deletes one. `/workspace/create` and
  `/workspace/queue/create` take `draftId`.
- **Snapshot.** `draftWorkspaces`, for every project, oldest first.
- **Webapp.** A collapsible **Drafts** section at the top of the sidebar,
  newest first, hidden when the project has none. Clicking a draft reopens
  the dialog on it. Its `…` menu can **Run now**, which creates from the draft
  straight away with its saved settings (ignoring Start), or discard it.
- Removing a project deletes its drafts.
