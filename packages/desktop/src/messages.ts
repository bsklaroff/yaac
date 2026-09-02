/**
 * User-facing text for the desktop shell: the boot splash (a data: URL, so
 * no bundled assets or renderer build exist at all), and the shape a
 * failure takes on its way to the picker (`#connect-page`). Pure — main.ts
 * feeds the splash into loadURL.
 */

export interface LaunchError {
  title: string
  /** Verbatim machine output (e.g. `yaac server start` stderr). */
  detail?: string
  /** Recovery instructions. */
  hint?: string
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function splashHtml(status: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>yaac</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0; min-height: 100vh;
        display: flex; align-items: center; justify-content: center;
        font-family: system-ui, sans-serif;
        background: light-dark(#fafafa, #111);
        color: light-dark(#222, #ddd);
      }
      .status { font-size: 1.05rem; opacity: 0.85; }
    </style>
  </head>
  <body><div class="status">${escapeHtml(status)}</div></body>
</html>`
}

export function splashUrl(status: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(splashHtml(status))}`
}
