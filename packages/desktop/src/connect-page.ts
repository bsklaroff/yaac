/**
 * The page the window shows when it has no server: the failure, and the
 * picker to fix it.
 *
 * Shell-owned rather than part of the SPA, because the SPA is served BY a
 * server — with none reachable there is no app to render a settings pane,
 * and an error dialog over a blank window leaves the user with nothing to
 * click. So this is the whole window until a connection succeeds.
 *
 * Built as an HTML string loaded from a `data:` URL, exactly like the boot
 * splash (`#messages`): no renderer bundle, no build step, nothing to keep
 * in sync with the frontend. The preload runs for this page like any
 * other, so the buttons drive the same `window.yaacServer` bridge the
 * SPA's Server settings section uses, and the same main-process handlers
 * re-validate every payload.
 *
 * Pure — main.ts feeds the result to loadURL.
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
      /* The native title bar is hidden and the SPA's own controls are not
         here, so the window needs a drag strip and a way to close. */
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
      input.token { flex: 0 0 140px; }
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
        A yaac server origin (<code>https://host.ts.net</code>, or
        <code>http://127.0.0.1:8787</code> for one on this machine) and an access
        token minted there with <code>yaac auth token create &lt;name&gt;</code>.
      </p>
      <form id="add">
        <input name="url" placeholder="https://host.ts.net" />
        <input name="token" class="token" type="password" placeholder="token" />
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
        // A successful connect tears this page down (the shell relands the
        // window on the server), so "Connecting…" is the last thing it shows.
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
        // The way out of the empty picker: the page cannot see that a
        // server was started from a terminal after it loaded, so this asks
        // the shell to resolve again.
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
          var token = e.target.elements.token.value.trim()
          if (!url || !token) {
            setStatus('Enter both an origin and a token.', 'error')
            return
          }
          handle(bridge.addRemote(url, token))
        })
      })()
    </script>
  </body>
</html>`
}

/**
 * The page as a `data:` URL. Same delivery as the boot splash: the shell
 * ships no renderer assets, so there is no file to load from.
 */
export function connectPageUrl(state: ConnectPageState): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(connectPageHtml(state))}`
}
