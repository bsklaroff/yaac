/**
 * The Servers page: the shell's one page for choosing which server the app
 * uses. One list holds this Mac's two installs, named "Local containerless
 * server" and "Local kubernetes cluster" with their origins and a Start or
 * Stop, and every other saved server, marked "(stopped)" when it does not
 * answer or "(refused)" when it will not identify this device. A row other
 * than the selected one connects, unless it is a stopped install, which
 * Start selects. The selected row comes first, checked while the window is
 * connected to it. It disconnects, and connects again only while it cannot
 * be reached; any other saved server can be removed. Below
 * the list are the setups of the installs this Mac lacks (local-setup.ts)
 * and a form that adds a server by origin. While Tailscale seems down, a
 * banner says so, since the tailnet is the only way to a server on another
 * machine (server-switch.ts).
 *
 * The window shows it when no server is reachable, with the failure on top;
 * on a Mac with nothing set up it leads with the setups instead. The SPA's
 * Servers button and server badge, and the tray, open it over a connected
 * server, with a button back to it that names it. It lives in the shell
 * because the SPA is served by the server, so without one there is no SPA.
 *
 * Like the boot splash (messages.ts), it is an HTML string loaded from a
 * `data:` URL, and its buttons use the preload's `window.yaacServer`
 * bridge, which the main process answers for this page alone. On success an
 * action either moves the window to a server or has the shell render this
 * page again, so the script only ever shows failures. A setup's progress
 * lives in the main process, so the page polls for it and picks it up again
 * after a reload. The servers' health is asked for once the page has loaded,
 * so a server that does not answer never holds the page up.
 */
import { SETUP_COPY, trustSentence } from '@yaac/shared/setup-copy'
import { isLoopbackOrigin } from '@yaac/shared/server-api'
import type { DesktopInstallState, DesktopLocalState, DesktopServerTargets } from '@yaac/shared/types'
import type { LaunchError } from '#messages'
import type { ServerScope } from '#server-control'

export interface ServersPageState {
  /** Why the window has no server; absent when the page is opened over one. */
  error?: LaunchError
  targets: DesktopServerTargets
  /** This Mac's installs, as last read. */
  local: DesktopLocalState
  /** A setup to show opened, as the tray's "Set up…" asks. */
  setup?: ServerScope
  /** Whether this Mac is on its tailnet (`onTailnet`). */
  tailnet: boolean
}

const STATE_TEXT: Record<DesktopInstallState, string> = {
  missing: 'Not set up',
  stopped: 'Stopped',
  running: 'Running',
  outdated: 'Running an older build',
  elsewhere: 'Runs on its cluster',
  unavailable: 'Status unavailable',
}

const BUSY_TEXT = { setup: 'Setting up…', start: 'Starting…', stop: 'Stopping…', restart: 'Restarting…' }

/**
 * Whether the page leads with setup: there is no `yaac` CLI, or there is
 * one but no install and no server selected.
 */
function showsOnboarding({ local, targets }: ServersPageState): boolean {
  return !local.cli || (local.installs.server === 'missing' && local.installs.cluster === 'missing' && targets.current === null)
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** A missing install's setup: what it means, its commands, and a button that runs them. */
function choiceHtml(local: DesktopLocalState, scope: ServerScope, open: boolean): string {
  const { commands, blocked, trusts } = local.choices[scope]
  const { summary, reach } = SETUP_COPY[scope]
  const why = blocked === 'unsupported'
    ? '<p class="note blocked">This Mac cannot run it: it needs macOS on Apple silicon.</p>'
    : blocked === 'no-brew'
      ? `<p class="note blocked">Homebrew is not installed. Install it from
        <a href="https://brew.sh" target="_blank">brew.sh</a>, then come back.</p>`
      : ''
  return `
        <details class="choice" id="choice-${scope}"${open ? ' open' : ''}>
          <summary>Set up…</summary>
          <p class="note">${escapeHtml(summary)}</p>
          ${reach ? `<p class="note">An agent can reach everything your account can:</p>
          <ul class="note">${reach.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : ''}
          <p class="note">${escapeHtml(trustSentence(trusts))}</p>
          <pre class="commands" id="commands-${scope}">${commands.map(escapeHtml).join('\n')}</pre>
          <p class="actions">
            <button class="copy" data-scope="${scope}">Copy commands</button>
            <button class="setup" data-scope="${scope}"${blocked ? ' disabled data-blocked' : ''}>Run them for me</button>
          </p>
          ${why}
        </details>`
}

/**
 * A row's connection buttons. The selected row disconnects; while it cannot
 * be reached it also connects, which is the retry.
 */
function connectButtons(url: string, selected: boolean, unreachable: boolean): string {
  const attr = `data-url="${escapeHtml(url)}"`
  return [
    !selected || unreachable ? `<button class="connect" ${attr}>Connect</button>` : '',
    selected ? '<button class="disconnect">Disconnect</button>' : '',
  ].join('')
}

/** An install's name, with its origin once it has one: "Local containerless server (http://…)". */
function installLabel(view: DesktopLocalState, scope: ServerScope): string {
  const origin = view.origins[scope]
  return origin ? `${SETUP_COPY[scope].title} (${origin})` : SETUP_COPY[scope].title
}

/** The check on the row of the server the window is connected to. */
function checkHtml(state: ServersPageState, selected: boolean): string {
  return selected && !state.error ? '<span class="check" title="Connected">✓</span>' : ''
}

/** One of this Mac's installs in the server list, with its state and a Start or Stop. */
function installRowHtml(state: ServersPageState, scope: ServerScope): string {
  const { local, targets } = state
  const install = local.installs[scope]!
  const origin = local.origins[scope]
  const selected = origin !== null && origin === targets.current
  const busy = local.busy?.scope === scope ? BUSY_TEXT[local.busy.action] : null
  /*
   * A stopped server is connected to by starting it, which selects it. One
   * whose origin is no longer saved (after `yaac remote remove`) is added
   * again, which probes, saves and selects it.
   */
  const connect = origin === null
    ? ''
    : install === 'stopped'
      ? selected ? '<button class="disconnect">Disconnect</button>' : ''
      : targets.saved.includes(origin)
        ? connectButtons(origin, selected, state.error !== undefined)
        : `<button class="connect" data-url="${escapeHtml(origin)}" data-add>Connect</button>`
  const control = install === 'stopped'
    ? `<button class="start" data-scope="${scope}">Start</button>`
    : install === 'running' || install === 'outdated'
      ? `<button class="stop" data-scope="${scope}">Stop</button>`
      : ''
  return `
        <li class="row" id="install-${scope}">
          ${checkHtml(state, selected)}
          <span class="name">${escapeHtml(installLabel(local, scope))}</span>
          <span class="tag">${busy ?? STATE_TEXT[install]}</span>
          ${connect}${control}
        </li>`
}

/** Any other saved server. */
function remoteRowHtml(state: ServersPageState, url: string): string {
  const selected = url === state.targets.current
  const attr = `data-url="${escapeHtml(url)}"`
  return `
        <li class="row">
          ${checkHtml(state, selected)}
          <span class="origin">${escapeHtml(url)}</span>
          <span class="tag health" ${attr} hidden></span>
          ${connectButtons(url, selected, state.error !== undefined)}
          ${selected ? '' : `<button class="remove" ${attr} title="Remove">✕</button>`}
        </li>`
}

/** A missing install: its name and its setup. */
function setupHtml(state: ServersPageState, scope: ServerScope, open: boolean): string {
  return `
      <section class="install" id="install-${scope}">
        <div class="row">
          <span class="name">${escapeHtml(SETUP_COPY[scope].title)}</span>
          <span class="tag">${STATE_TEXT.missing}</span>
        </div>
        ${choiceHtml(state.local, scope, open)}
      </section>`
}

export function serversPageHtml(state: ServersPageState): string {
  const { error, targets, local } = state
  const onboarding = showsOnboarding(state)
  // A Mac with nothing set up and no saved server gets a welcome, not an error.
  const fresh = onboarding && targets.saved.length === 0
  const heading = fresh ? { title: 'Set up yaac' } : error ?? { title: 'Servers' }

  const scopes = (['server', 'cluster'] as const).filter((s) => local.installs[s] !== null)
  const installed = scopes.filter((s) => local.installs[s] !== 'missing')
  const missing = scopes.filter((s) => local.installs[s] === 'missing')
  const localOrigins = installed.map((s) => local.origins[s])
  const rows = [
    ...installed.map((s) => ({ url: local.origins[s], html: installRowHtml(state, s) })),
    ...targets.saved.filter((url) => !localOrigins.includes(url)).map((url) => ({ url, html: remoteRowHtml(state, url) })),
  ]
  const first = (row: { url: string | null }): number => Number(row.url !== null && row.url === targets.current)
  const ordered = rows.sort((a, b) => first(b) - first(a)).map((r) => r.html)
  // Back names the server it returns to: an install by name, any other by origin.
  const current = installed.find((s) => local.origins[s] === targets.current)
  const back = `← Back to ${current ? SETUP_COPY[current].title : targets.current ?? 'the server'}`
  // Shown only to a Mac with a remote server saved, since one without needs no tailnet.
  const banner = !state.tailnet && targets.saved.some((url) => !isLoopbackOrigin(url)) ? `
      <p class="banner">Tailscale does not seem to be running on this Mac. Remote servers are
        reached over your tailnet, so connecting to one will likely fail until you start it.</p>` : ''
  const servers = fresh ? '' : `
      <h2>Servers</h2>${banner}
      ${ordered.length > 0 ? `<ul class="rows">${ordered.join('')}</ul>` : '<p class="empty">No servers configured yet.</p>'}
      ${installed.length > 0 ? '<p class="note">Local servers keep running when the app quits.</p>' : ''}`

  const setups = missing.length === 0 ? '' : `
      ${fresh ? '' : '<h2>Set up on this Mac</h2>'}
      ${onboarding ? '<p class="note">Pick where workspaces run. You can add the other later, from this page or the menu-bar icon.</p>' : ''}
      ${missing.map((s) => setupHtml(state, s, onboarding || state.setup === s)).join('')}`

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>yaac</title>
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0; min-height: 100vh;
        font-family: system-ui, sans-serif;
        background: light-dark(#fafafa, #111);
        color: light-dark(#222, #ddd);
        font-size: 13px;
      }
      /* The native title bar is hidden, so provide a drag strip and close. */
      .titlebar {
        height: 38px; -webkit-app-region: drag;
        display: flex; align-items: center; justify-content: flex-end;
        padding: 0 10px;
      }
      .titlebar button {
        -webkit-app-region: no-drag;
        border: 0; background: transparent; cursor: pointer; font-size: 15px;
        color: light-dark(#888, #888); padding: 2px 6px; border-radius: 5px;
      }
      .titlebar button:hover { background: light-dark(#e6e6e6, #262626); }
      main { max-width: 560px; margin: 0 auto; padding: 6px 24px 40px; }
      h1 { font-size: 15px; margin: 0 0 6px; }
      h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em;
           color: light-dark(#777, #888); margin: 28px 0 8px; font-weight: 600; }
      .detail, .hint { margin: 0 0 6px; line-height: 1.5;
                       color: light-dark(#555, #aaa); }
      .detail { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                font-size: 12px; white-space: pre-wrap; word-break: break-word; }
      .rows { list-style: none; margin: 0; padding: 0; }
      .row { display: flex; align-items: center; gap: 8px; }
      .rows .row, .install { background: light-dark(#fff, #1a1a1a); border-radius: 7px;
                             padding: 8px 10px; margin-bottom: 6px; }
      .origin, .name { flex: 1; min-width: 0; }
      .origin { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      /* An install's name wraps rather than hide its origin. */
      .name { overflow-wrap: anywhere; }
      .check { color: light-dark(#1e8e3e, #5cc97b); font-weight: 700; }
      .tag { font-size: 11px; color: light-dark(#888, #888); white-space: nowrap; }
      .row button { flex-shrink: 0; }
      button {
        border: 0; border-radius: 6px; cursor: pointer; font-size: 12px;
        font-weight: 500; padding: 5px 11px;
        background: light-dark(#e4e4e4, #303030); color: inherit;
      }
      button:hover { background: light-dark(#d6d6d6, #3c3c3c); }
      button.remove { background: transparent; color: light-dark(#888, #888); padding: 5px 7px; }
      button.remove:hover { color: light-dark(#b3261e, #f2a49d); }
      summary { cursor: pointer; margin-top: 6px; color: light-dark(#555, #aaa); }
      details[open] summary { margin-bottom: 4px; }
      ul.note { margin: 2px 0 4px; padding-left: 18px; }
      .actions { display: flex; gap: 6px; margin: 8px 0 0; }
      .blocked { margin-top: 6px; color: light-dark(#b3261e, #f2a49d); }
      .banner { margin: 0 0 8px; padding: 8px 10px; border-radius: 7px; line-height: 1.5;
                background: light-dark(#fdf3d7, #3a2f12); color: light-dark(#6b4e00, #f0d58a); }
      pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
            background: light-dark(#f2f2f2, #111); border-radius: 5px; padding: 7px 9px;
            margin: 8px 0 0; white-space: pre-wrap; word-break: break-all; user-select: text; }
      #run { margin-top: 10px; border-top: 1px solid light-dark(#eee, #262626); padding-top: 8px; }
      #run h3 { font-size: 13px; margin: 0 0 4px; }
      #run ol { list-style: none; margin: 0; padding: 0; line-height: 1.7; }
      #run .skipped, #run .pending { color: light-dark(#888, #777); }
      #run .failed, #run .cancelled { color: light-dark(#b3261e, #f2a49d); }
      .log { max-height: 220px; overflow: auto; }
      button:disabled { opacity: .5; cursor: default; }
      .empty { color: light-dark(#777, #888); margin: 0; }
      form { display: flex; gap: 6px; margin-top: 8px; }
      input {
        flex: 1; min-width: 0; padding: 7px 9px; font-size: 12px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        border-radius: 6px; border: 1px solid light-dark(#d4d4d4, #333);
        background: light-dark(#fff, #171717); color: inherit;
      }
      input:focus { outline: none; border-color: light-dark(#999, #555); }
      .note { color: light-dark(#777, #888); margin: 0 0 8px; line-height: 1.5; }
      .status { margin-top: 14px; min-height: 17px; }
      .status.error { color: light-dark(#b3261e, #f2a49d); }
      .status.busy { color: light-dark(#666, #999); }
      #retry { margin-top: 4px; }
    </style>
  </head>
  <body>
    <div class="titlebar"><button id="close" title="Close">✕</button></div>
    <main>
      <h1>${escapeHtml(heading.title)}</h1>
      ${heading.detail ? `<p class="detail">${escapeHtml(heading.detail)}</p>` : ''}
      ${heading.hint ? `<p class="hint">${escapeHtml(heading.hint)}</p>` : ''}
      <p><button id="retry">${error ? 'Try again' : escapeHtml(back)}</button></p>
      ${servers}

      ${setups}

      <div id="run" hidden>
        <h3 id="run-title"></h3>
        <ol id="run-steps"></ol>
        <pre class="log" id="run-log"></pre>
        <p class="note" id="run-error"></p>
        <p><button id="run-cancel">Cancel</button></p>
      </div>

      <h2>Add a server</h2>
      <p class="note">
        A yaac server origin: <code>https://host.ts.net</code> for one served on
        your tailnet, or <code>http://127.0.0.1:8787</code> for one on this machine.
      </p>
      <form id="add">
        <input name="url" placeholder="https://host.ts.net" />
        <button type="submit" class="add">Connect</button>
      </form>

      <p class="status" id="status"></p>
    </main>
    <script>
      (function () {
        var bridge = window.yaacServer
        var statusEl = document.getElementById('status')
        var buttons = Array.prototype.slice.call(document.querySelectorAll('button'))
        function setStatus(text, kind) {
          statusEl.textContent = text
          statusEl.className = 'status' + (kind ? ' ' + kind : '')
        }
        function busy(on) {
          buttons.forEach(function (b) { if (b.id !== 'close') b.disabled = on || b.hasAttribute('data-blocked') })
        }
        // On success the shell replaces this page, so only failures update it.
        function handle(promise, busyText) {
          busy(true)
          setStatus(busyText || 'Connecting…', 'busy')
          promise.then(function (outcome) {
            if (outcome && outcome.ok) return
            busy(false)
            setStatus((outcome && outcome.error) || 'could not connect', 'error')
          }, function (err) {
            busy(false)
            setStatus(String((err && err.message) || err), 'error')
          })
        }
        function each(selector, onClick) {
          document.querySelectorAll(selector).forEach(function (btn) {
            btn.addEventListener('click', function () { onClick(btn) })
          })
        }
        document.getElementById('close').addEventListener('click', function () {
          if (window.yaacWindow) window.yaacWindow.close()
        })
        if (!bridge) {
          setStatus('This page is unavailable in this window.', 'error')
          busy(true)
          return
        }
        // Back to the server, or a retry that picks up one started from a terminal.
        document.getElementById('retry').addEventListener('click', function () {
          handle(bridge.retry())
        })
        // A setup's state lives in the main process; poll it while one runs.
        var runEl = document.getElementById('run')
        var GLYPH = { pending: '○', running: '…', done: '✓', skipped: '–', failed: '✗', cancelled: '✗' }
        var TITLE = { running: 'Setting up…', succeeded: 'Set up', failed: 'Setup failed', cancelled: 'Setup cancelled' }
        var polling = null
        function renderRun(state) {
          var run = state && state.setup
          var running = !!(state && state.busy)
          document.querySelectorAll('button.setup, button.start, button.stop').forEach(function (b) {
            b.disabled = running || b.hasAttribute('data-blocked')
          })
          // A finished run shows beside its own setup only.
          var card = run && document.getElementById('choice-' + run.scope)
          var show = !!run && (run.phase === 'running' || !!card)
          // Shown inside its setup's card, where the button was clicked.
          if (card && runEl.parentNode !== card) {
            card.open = true
            card.appendChild(runEl)
          }
          runEl.hidden = !show
          if (show) {
            document.getElementById('run-title').textContent = TITLE[run.phase] || ''
            var list = document.getElementById('run-steps')
            list.textContent = ''
            run.steps.forEach(function (step) {
              var li = document.createElement('li')
              li.className = step.state
              li.textContent = GLYPH[step.state] + ' ' + step.label + (step.note ? ' (' + step.note + ')' : '')
              list.appendChild(li)
            })
            var log = document.getElementById('run-log')
            log.textContent = run.log.slice(-40).join('\\n')
            log.hidden = run.log.length === 0
            log.scrollTop = log.scrollHeight
            document.getElementById('run-error').textContent = [run.error, run.hostCheckFailures].filter(Boolean).join('\\n')
            document.getElementById('run-cancel').hidden = run.phase !== 'running'
          }
          if (running && !polling) polling = setInterval(poll, 1000)
          if (!running && polling) {
            clearInterval(polling)
            polling = null
          }
        }
        function poll() {
          bridge.localState().then(renderRun, function () {})
        }
        each('button.setup', function (btn) {
          setStatus('', '')
          bridge.setupLocal(btn.getAttribute('data-scope')).then(function (outcome) {
            if (outcome && outcome.ok) {
              poll()
              setTimeout(function () { if (runEl.scrollIntoView) runEl.scrollIntoView({ block: 'nearest' }) }, 100)
            }
            else setStatus((outcome && outcome.error) || 'could not start the setup', 'error')
          }, function (err) { setStatus(String((err && err.message) || err), 'error') })
        })
        document.getElementById('run-cancel').addEventListener('click', function () {
          bridge.cancelSetup().then(poll)
        })
        each('button.copy', function (btn) {
          var pre = document.getElementById('commands-' + btn.getAttribute('data-scope'))
          var text = pre.textContent
          var copied = navigator.clipboard && navigator.clipboard.writeText
            ? navigator.clipboard.writeText(text)
            : Promise.reject(new Error('no clipboard'))
          copied.catch(function () {
            // A data: page may not be a secure context; copy the selection instead.
            var range = document.createRange()
            range.selectNodeContents(pre)
            var sel = window.getSelection()
            sel.removeAllRanges()
            sel.addRange(range)
            document.execCommand('copy')
            sel.removeAllRanges()
          }).then(function () { setStatus('Copied.', 'busy') })
        })
        poll()
        bridge.serverHealth().then(function (health) {
          document.querySelectorAll('.tag.health').forEach(function (tag) {
            var h = health[tag.getAttribute('data-url')]
            tag.hidden = !h
            if (!h) return
            tag.textContent = '(' + h.kind + ')'
            if (h.reason) tag.title = h.reason
          })
        }, function () {})
        each('button.start', function (btn) {
          handle(bridge.startLocal(btn.getAttribute('data-scope')), 'Starting the server…')
        })
        each('button.stop', function (btn) {
          handle(bridge.stopLocal(btn.getAttribute('data-scope')), 'Stopping the server…')
        })
        each('button.connect', function (btn) {
          var url = btn.getAttribute('data-url')
          handle(btn.hasAttribute('data-add') ? bridge.addRemote(url) : bridge.switchTo({ url: url }))
        })
        each('button.disconnect', function () {
          handle(bridge.disconnect(), 'Disconnecting…')
        })
        // The shell confirms a removal in a native dialog.
        each('button.remove', function (btn) {
          handle(bridge.remove({ url: btn.getAttribute('data-url') }), 'Removing…')
        })
        document.getElementById('add').addEventListener('submit', function (e) {
          e.preventDefault()
          var url = e.target.elements.url.value.trim()
          if (!url) {
            setStatus('Enter a server origin.', 'error')
            return
          }
          handle(bridge.addRemote(url))
        })
      })()
    </script>
  </body>
</html>`
}

/** The page as a `data:` URL; the shell ships no renderer assets. */
export function serversPageUrl(state: ServersPageState): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(serversPageHtml(state))}`
}
