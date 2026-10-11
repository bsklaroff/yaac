/**
 * The page the window shows when no server is reachable: the failure, plus a
 * server picker. It lives in the shell because the SPA is served by the
 * server, so without one there is no SPA.
 *
 * On a Mac with nothing set up it is also the onboarding: the two kinds
 * of install, what each means, the commands that make one, and a button
 * that runs them (local-setup.ts). The tray opens it on a single setup.
 *
 * Like the boot splash (messages.ts), it is an HTML string loaded from a
 * `data:` URL. The preload still runs, so its buttons use the same
 * `window.yaacServer` bridge as the SPA's Server settings. A setup's
 * progress lives in the main process, so the page polls for it and
 * picks it up again after a reload.
 */
import { SETUP_COPY, trustSentence } from '@yaac/shared/setup-copy'
import type { DesktopLocalState, DesktopServerTargets } from '@yaac/shared/types'
import type { LaunchError } from '#messages'
import type { ServerScope } from '#server-control'

export interface ConnectPageState {
  error: LaunchError
  targets: DesktopServerTargets
  /** This machine's installs, as last read. */
  local: DesktopLocalState
  /** Show this setup alone, as the tray's "Set up…" does. */
  setup?: ServerScope
}

/**
 * Whether the page leads with setup: there is no `yaac` CLI, or there is
 * one but no install and no server selected.
 */
function showsOnboarding(state: ConnectPageState): boolean {
  const { local, targets } = state
  if (state.setup) return true
  return !local.cli || (local.installs.server === 'missing' && local.installs.cluster === 'missing' && targets.current === null)
}

function choiceHtml(local: DesktopLocalState, scope: ServerScope): string {
  const { commands, blocked, trusts } = local.choices[scope]
  const { title, summary, reach } = SETUP_COPY[scope]
  const why = blocked === 'unsupported'
    ? '<p class="note blocked">This Mac cannot run it: it needs macOS on Apple silicon.</p>'
    : blocked === 'no-brew'
      ? `<p class="note blocked">Homebrew is not installed. Install it from
        <a href="https://brew.sh" target="_blank">brew.sh</a>, then come back.</p>`
      : ''
  return `
      <section class="choice" id="choice-${scope}">
        <h3>${escapeHtml(title)}</h3>
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
      </section>`
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function connectPageHtml(state: ConnectPageState): string {
  const { error, targets, local, setup } = state
  const rows = targets.saved.map((url) => {
    const selected = url === targets.current
    return `
        <li class="row">
          <span class="origin">${escapeHtml(url)}</span>
          ${selected ? '<span class="tag">selected</span>' : ''}
          <button class="connect" data-url="${escapeHtml(url)}">Connect</button>
        </li>`
  }).join('')

  const list = targets.saved.length > 0
    ? `<ul class="rows">${rows}</ul>`
    : '<p class="empty">No servers configured yet.</p>'

  // Setup for a Mac without an install; otherwise a start for each stopped one.
  const onboarding = showsOnboarding(state)
  // A Mac with nothing set up and no saved server gets a welcome, not an error.
  const fresh = onboarding && !setup && targets.saved.length === 0
  const heading = fresh ? { title: 'Set up yaac' } : error
  const choices = setup ? [setup] : (['server', 'cluster'] as const).filter((s) => local.installs[s] === 'missing')
  const starts = [
    local.installs.server === 'stopped'
      ? `<p class="note">Run workspaces here, each in its own checkout. The server keeps running when the app quits.</p>
      <p><button class="start" data-scope="server">Start a server on this Mac</button></p>`
      : '',
    local.installs.cluster === 'stopped'
      ? `<p class="note">Run workspaces in this Mac's kind cluster.</p>
      <p><button class="start" data-scope="cluster">Start this Mac's cluster server</button></p>`
      : '',
  ].join('')
  const thisMac = onboarding
    ? `${setup ? '' : `${fresh ? '' : '<h2>Set up yaac on this Mac</h2>'}
      <p class="note">Pick where workspaces run. You can add the other later, from the menu-bar icon or Settings → Server.</p>`}
      ${choices.map((s) => choiceHtml(local, s)).join('')}`
    : starts !== '' ? `<h2>This Mac</h2>${starts}` : ''
  const servers = setup || fresh ? '' : `
      <h2>Servers</h2>
      ${list}`
  const add = setup ? '' : `
      <h2>Add a server</h2>
      <p class="note">
        A yaac server origin: <code>https://host.ts.net</code> for one served on
        your tailnet, or <code>http://127.0.0.1:8787</code> for one on this machine.
      </p>
      <form id="add">
        <input name="url" placeholder="https://host.ts.net" />
        <button type="submit" class="add">Connect</button>
      </form>`

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
      .row { display: flex; align-items: center; gap: 8px;
             background: light-dark(#fff, #1a1a1a); border-radius: 7px;
             padding: 8px 10px; margin-bottom: 6px; }
      .origin { flex: 1; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tag { font-size: 11px; color: light-dark(#888, #888); }
      button.connect, button.add, button.start, button.copy, button.setup, #retry, #run-cancel {
        border: 0; border-radius: 6px; cursor: pointer; font-size: 12px;
        font-weight: 500; padding: 5px 11px;
        background: light-dark(#e4e4e4, #303030); color: inherit;
      }
      button.connect:hover, button.add:hover, button.start:hover, button.copy:hover, button.setup:hover,
      #retry:hover, #run-cancel:hover { background: light-dark(#d6d6d6, #3c3c3c); }
      h3 { font-size: 13px; margin: 0 0 4px; }
      .choice { background: light-dark(#fff, #1a1a1a); border-radius: 7px; padding: 10px 12px; margin-bottom: 8px; }
      ul.note { margin: 2px 0 4px; padding-left: 18px; }
      .actions { display: flex; gap: 6px; margin: 8px 0 0; }
      .blocked { margin-top: 6px; color: light-dark(#b3261e, #f2a49d); }
      pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
            background: light-dark(#f2f2f2, #111); border-radius: 5px; padding: 7px 9px;
            margin: 8px 0 0; white-space: pre-wrap; word-break: break-all; user-select: text; }
      #run { margin-top: 10px; border-top: 1px solid light-dark(#eee, #262626); padding-top: 8px; }
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
      .note { color: light-dark(#777, #888); margin: 0; line-height: 1.5; }
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
      <p><button id="retry">${setup ? 'Back' : 'Try again'}</button></p>
      ${servers}

      ${thisMac}

      <div id="run" hidden>
        <h3 id="run-title"></h3>
        <ol id="run-steps"></ol>
        <pre class="log" id="run-log"></pre>
        <p class="note" id="run-error"></p>
        <p><button id="run-cancel">Cancel</button></p>
      </div>
      ${add}

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
        document.getElementById('close').addEventListener('click', function () {
          if (window.yaacWindow) window.yaacWindow.close()
        })
        // Picks up a server started from a terminal after this page loaded.
        document.getElementById('retry').addEventListener('click', function () {
          if (bridge && bridge.retry) handle(bridge.retry())
        })
        if (!bridge) {
          setStatus('The server picker is unavailable in this window.', 'error')
          busy(true)
          return
        }
        // A setup's state lives in the main process; poll it while one runs.
        var runEl = document.getElementById('run')
        var GLYPH = { pending: '○', running: '…', done: '✓', skipped: '–', failed: '✗', cancelled: '✗' }
        var TITLE = { running: 'Setting up…', succeeded: 'Set up', failed: 'Setup failed', cancelled: 'Setup cancelled' }
        var polling = null
        function renderRun(state) {
          var run = state && state.setup
          var running = !!(state && state.busy)
          document.querySelectorAll('button.setup, button.start').forEach(function (b) {
            b.disabled = running || b.hasAttribute('data-blocked')
          })
          // A finished run shows beside its own setup only.
          var card = run && document.getElementById('choice-' + run.scope)
          var show = !!run && (run.phase === 'running' || !!card)
          // Shown inside its setup's card, where the button was clicked.
          if (card && runEl.parentNode !== card) card.appendChild(runEl)
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
          if (bridge.localState) bridge.localState().then(renderRun, function () {})
        }
        document.querySelectorAll('button.setup').forEach(function (btn) {
          btn.addEventListener('click', function () {
            setStatus('', '')
            bridge.setupLocal(btn.getAttribute('data-scope')).then(function (outcome) {
              if (outcome && outcome.ok) {
                poll()
                setTimeout(function () { if (runEl.scrollIntoView) runEl.scrollIntoView({ block: 'nearest' }) }, 100)
              }
              else setStatus((outcome && outcome.error) || 'could not start the setup', 'error')
            }, function (err) { setStatus(String((err && err.message) || err), 'error') })
          })
        })
        document.getElementById('run-cancel').addEventListener('click', function () {
          bridge.cancelSetup().then(poll)
        })
        document.querySelectorAll('button.copy').forEach(function (btn) {
          btn.addEventListener('click', function () {
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
        })
        poll()
        document.querySelectorAll('button.start').forEach(function (btn) {
          btn.addEventListener('click', function () {
            handle(bridge.startLocal(btn.getAttribute('data-scope')), 'Starting the server…')
          })
        })
        document.querySelectorAll('button.connect').forEach(function (btn) {
          btn.addEventListener('click', function () {
            handle(bridge.switchTo({ url: btn.getAttribute('data-url') }))
          })
        })
        var addForm = document.getElementById('add')
        if (addForm) addForm.addEventListener('submit', function (e) {
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
export function connectPageUrl(state: ConnectPageState): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(connectPageHtml(state))}`
}
