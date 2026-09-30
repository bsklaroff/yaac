/**
 * The page the window shows when no server is reachable: the failure, plus a
 * server picker. It lives in the shell because the SPA is served by the
 * server, so without one there is no SPA.
 *
 * Like the boot splash (messages.ts), it is an HTML string loaded from a
 * `data:` URL. The preload still runs, so its buttons use the same
 * `window.yaacServer` bridge as the SPA's Server settings.
 */
import type { DesktopServerTargets } from '@yaac/shared/types'
import type { LaunchError } from '#messages'

export interface ConnectPageState {
  error: LaunchError
  targets: DesktopServerTargets
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function connectPageHtml(state: ConnectPageState): string {
  const { error, targets } = state
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
      button.connect, button.add, #retry {
        border: 0; border-radius: 6px; cursor: pointer; font-size: 12px;
        font-weight: 500; padding: 5px 11px;
        background: light-dark(#e4e4e4, #303030); color: inherit;
      }
      button.connect:hover, button.add:hover, #retry:hover { background: light-dark(#d6d6d6, #3c3c3c); }
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
      <h1>${escapeHtml(error.title)}</h1>
      ${error.detail ? `<p class="detail">${escapeHtml(error.detail)}</p>` : ''}
      ${error.hint ? `<p class="hint">${escapeHtml(error.hint)}</p>` : ''}
      <p><button id="retry">Try again</button></p>

      <h2>Servers</h2>
      ${list}

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
          buttons.forEach(function (b) { if (b.id !== 'close') b.disabled = on })
        }
        // On success the shell replaces this page, so only failures update it.
        function handle(promise) {
          busy(true)
          setStatus('Connecting…', 'busy')
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
        document.querySelectorAll('button.connect').forEach(function (btn) {
          btn.addEventListener('click', function () {
            handle(bridge.switchTo({ url: btn.getAttribute('data-url') }))
          })
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
export function connectPageUrl(state: ConnectPageState): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(connectPageHtml(state))}`
}
