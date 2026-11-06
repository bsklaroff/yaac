import { useEffect, useState, type JSX } from 'react'
import { InlineBudget, imageDataUrl, linkedCheckoutPath, readWorkspaceFile } from '#lib/files'

/**
 * The file pane's static HTML preview (docs/file-editor.md, "Previews"): a
 * checkout HTML file shown as a page that runs no script and loads nothing.
 * Its own stylesheets and images are inlined from the checkout before it is
 * shown, and a policy at the top of its head forbids every other load, so
 * an untrusted file cannot reach the network or the API.
 */

const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"

/** How many stylesheets and images one preview inlines, stylesheets first
 *  and each in document order; the rest stay unloaded, so a page cannot fan
 *  out into a flood of reads. */
const MAX_INLINED = 100

/**
 * The file's text made into the document the iframe shows. Its stylesheets
 * and images are inlined first, each path read once and all of them within
 * one `InlineBudget`. Each further use of a path is charged again, since
 * every `<img>` or `<style>` holds its own copy in the page; one past the
 * budget stays unloaded. A stylesheet has `</style` escaped
 * so its text stays whole. Everything else runs on a reparse of that
 * result, since inlined
 * text can parse as markup where it lands (a stylesheet linked inside
 * `<svg>`), and the reparse is what the iframe will see: scripts, `<base>`
 * and `http-equiv` metas (a refresh, a looser policy) are dropped, the
 * policy meta goes first, a link to a heading is rewritten to stay within
 * the iframe's document, one elsewhere opens a new tab with no opener, and
 * one to a checkout file is left inert.
 */
async function staticDocument(workspaceId: string, from: string, html: string): Promise<string> {
  const source = new DOMParser().parseFromString(html, 'text/html')
  const local = (url: string | null): string | null => (url === null ? null : linkedCheckoutPath(from, url))
  const budget = new InlineBudget()
  const reads = new Map<string, Promise<string | null>>()
  const once = (key: string, read: () => Promise<string | null>): Promise<string | null> => {
    if (!reads.has(key)) reads.set(key, read())
    return reads.get(key)!
  }
  const used = new Set<string>()
  const fits = (key: string, path: string): boolean => {
    if (!used.has(key)) {
      used.add(key)
      return true
    }
    return budget.again(path)
  }
  const inline = [
    ...Array.from(source.querySelectorAll('link[rel~="stylesheet" i][href]'), (link) => async () => {
      const path = local(link.getAttribute('href'))
      if (path === null) return
      const css = await once(`css:${path}`, () => readWorkspaceFile(workspaceId, path)
        .then((f) => (typeof f.content === 'string' && budget.take(path, f.size) ? f.content : null), () => null))
      if (css === null || !fits(`css:${path}`, path)) return
      const style = source.createElement('style')
      style.textContent = css.replace(/<\/(style)/gi, '<\\/$1')
      link.replaceWith(style)
    }),
    ...Array.from(source.querySelectorAll('img[src]'), (img) => async () => {
      img.removeAttribute('srcset')
      const path = local(img.getAttribute('src'))
      if (path === null) return
      const data = await once(`img:${path}`, () => imageDataUrl(workspaceId, path, budget))
      if (data !== null && fits(`img:${path}`, path)) img.setAttribute('src', data)
    }),
  ]
  await Promise.all(inline.slice(0, MAX_INLINED).map((run) => run()))

  const doc = new DOMParser().parseFromString(`<!doctype html>${source.documentElement.outerHTML}`, 'text/html')
  doc.querySelectorAll('script, base, meta[http-equiv]').forEach((el) => el.remove())
  const csp = doc.createElement('meta')
  csp.httpEquiv = 'Content-Security-Policy'
  csp.content = PREVIEW_CSP
  doc.head.prepend(csp)
  for (const a of doc.querySelectorAll('a[href], area[href]')) {
    const href = a.getAttribute('href')!
    if (href.startsWith('#')) {
      a.setAttribute('href', `about:srcdoc${href}`)
    } else if (local(href) === null) {
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noreferrer noopener')
    } else {
      a.removeAttribute('href')
    }
  }
  return `<!doctype html>${doc.documentElement.outerHTML}`
}

/**
 * The preview's iframe. Its sandbox grants only popups, which nothing but a
 * click on a link can open, and lets them leave the sandbox so the page
 * opened works normally.
 */
export function HtmlDocument({ workspaceId, path, text }: {
  workspaceId: string
  path: string
  text: string
}): JSX.Element {
  const [doc, setDoc] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    void staticDocument(workspaceId, path, text).then((d) => { if (current) setDoc(d) })
    return () => { current = false }
  }, [workspaceId, path, text])
  return (
    <iframe
      title={path}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      srcDoc={doc ?? ''}
      className="min-h-0 flex-1 border-0 bg-white"
    />
  )
}
