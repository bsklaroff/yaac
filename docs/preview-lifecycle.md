# Preview lifecycle

A desktop app preview pane (`WorkspacePreview`) embeds a workspace's dev
server in a `<webview>`, whose page runs on the user's machine. The pane
stays mounted while hidden, whether behind another tab or in a workspace
that is not selected, so switching back shows the page as it was left,
without a reload. A hidden page keeps its memory and some CPU, so the pane
puts it through the same lifecycle Chrome uses for a background tab. The
numbers come from Chromium's `performance_manager` policies.

## Hidden: throttled

Hiding the pane hides the guest page as far as Chromium is concerned:
animation frames stop and timers run at most once a second, as in a
background tab. This needs nothing from yaac.

## Hidden 5 minutes: frozen

After five minutes hidden, the pane asks the desktop app's main process
(`packages/desktop/src/preview-lifecycle.ts`) to freeze the page with the
DevTools protocol's `Page.setWebLifecycleState`. That is the frozen state
Chrome's freezing policy uses: no task runs, and the page gets `freeze`
and `resume` events. Five minutes is Chrome's protection time for a tab
that was recently visible or audible. Showing the pane thaws the page. Work
that arrived while it was frozen, such as a dev server's hot-reload
message, runs then.

A page playing audio or open in DevTools is not frozen. Chrome freezes only
pages that use a lot of CPU, and only in Energy Saver mode. A preview is
frozen whatever its CPU use, because the cost of freezing is low for a dev
server page.

## Hidden 4 hours: discarded

After four hours hidden, the pane drops its `<webview>`, which ends the
page's process and frees its memory, and keeps only the URL it was on.
Showing the pane again creates a new webview at that URL. These are the
rules Chrome's Memory Saver uses in its default, balanced mode:

- The timer starts when the pane is hidden and is cancelled when it is
  shown.
- A pane revisited more than 15 times is never discarded, since the user
  keeps returning to it.
- A page that is playing audio, has DevTools open, or has been typed into
  since it last loaded is not discarded, because a reload would lose that
  work. Chrome checks form input and other user edits. The desktop app
  treats any keystroke in the page as an edit.
- The check is made when the timer fires. A page protected at that moment
  stays until the pane is next hidden.

Chrome restores a discarded tab's back/forward history, but a preview's
history is lost. Electron can only restore history into a webContents that
has never loaded a page, and a `<webview>` loads one to attach.

## Critical memory pressure: discarded sooner

While any preview is hidden, the desktop app checks for critical memory
pressure every five seconds (`packages/desktop/src/memory-pressure.ts`).
Electron reports no pressure events, so it polls. On macOS it reads the
system's own pressure level (`kern.memorystatus_vm_pressure_level`), the
signal Chrome follows there. Elsewhere, critical means less than 400 MiB of
available memory, Chrome's Windows threshold. On Linux "available" is the
kernel's `MemAvailable`, since free memory there leaves out reclaimable
cache. Chrome itself watches no pressure on desktop Linux.

Each check that finds critical pressure discards one preview, chosen the way
Chrome's urgent discarding chooses a tab: the one hidden longest, among
those hidden at least ten minutes. The same protections apply as for the
four-hour discard, and if the longest-hidden preview is protected, the next
one goes instead. The revisit limit does not apply. Chrome discards one tab
each time the system reports critical pressure. Here, each check that still
finds it discards another, so a machine that stays under pressure loses
another hidden preview every five seconds until none is left to discard.
