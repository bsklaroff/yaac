import { Children, createContext, memo, useContext, useMemo, type JSX, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeView } from '#components/DiffView'
import { fileLinksIn, resolveFilePath, type CheckoutFiles, type FileRef } from '#lib/files'
import { languageForFence, type HighlightLanguage } from '#lib/highlight'

/**
 * Renders agent markdown in the chat pane. Raw HTML stays disabled
 * (react-markdown's default) because the text may echo untrusted repository
 * content. Elements are styled individually with tight margins so a one-line
 * reply stays one line high.
 *
 * Under a `FileLinksContext`, paths of files in the checkout open the file
 * pane on click: in prose, as inline code, or as a link's target (claude
 * writes `[main.ts:12](src/main.ts#L12)`), at the line they name. Matching
 * is the terminal's (`fileLinksIn`).
 */

/**
 * The checkout's listing to match paths against, and what opens a file.
 * Only the live chat pane provides one; a stopped workspace has no file
 * pane, so its transcript leaves paths as text.
 */
export interface FileLinks extends CheckoutFiles {
  open: (file: FileRef) => void
}

export const FileLinksContext = createContext<FileLinks | null>(null)

const LINK_CLASS = 'text-link underline decoration-link/40 underline-offset-2 hover:decoration-link'

/**
 * Opens one file. A span rather than a button, so a long path wraps. The
 * click stops here, since a tool row's label sits inside its toggle.
 */
export function FileLink({ file, children }: { file: FileRef; children: ReactNode }): ReactNode {
  const links = useContext(FileLinksContext)
  if (!links) return children
  return (
    <span
      role="link"
      tabIndex={0}
      title={file.line === undefined ? file.path : `${file.path}:${file.line}`}
      onClick={(e) => {
        e.stopPropagation()
        links.open(file)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') links.open(file)
      }}
      className={`${LINK_CLASS} cursor-pointer`}
    >
      {children}
    </span>
  )
}

/**
 * Opens a web page in a new tab, which the desktop and iPhone apps hand to
 * the system browser. A span for the same reasons as `FileLink`.
 */
function WebLink({ url }: { url: string }): JSX.Element {
  const open = (): void => void window.open(url, '_blank', 'noopener,noreferrer')
  return (
    <span
      role="link"
      tabIndex={0}
      title={url}
      onClick={(e) => {
        e.stopPropagation()
        open()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') open()
      }}
      className={`${LINK_CLASS} cursor-pointer`}
    >
      {url}
    </span>
  )
}

/** An http(s) URL in plain text, less punctuation that may follow it. */
const WEB_URL = /\bhttps?:\/\/[^\s'"`<>]*[^\s'"`<>.,;:!?\]}]/g

/**
 * The web URLs in `text`. A closing `)` stays only while it closes a `(` in
 * the URL, as in GFM's autolinks (`wiki/Foo_(bar)`).
 */
function webLinksIn(text: string): Array<{ start: number; end: number; url: string }> {
  return Array.from(text.matchAll(WEB_URL), (m) => {
    let url = m[0]
    while (url.endsWith(')') && url.split(')').length > url.split('(').length) url = url.slice(0, -1)
    return { start: m.index, end: m.index + url.length, url }
  })
}

/**
 * `children` with the file paths in their text made into links, and with
 * `web`, its URLs. Only text that is not markdown asks for URLs (a tool
 * call's label): gfm links a markdown URL itself, so one left unlinked there
 * is a link's label, which must not link again. `about` is the file the text
 * is about, if known: a link to it that names no line takes `about`'s (a
 * Read call's title, whose line is in its location).
 */
export function Linked({ children, about, web = false }: {
  children: ReactNode
  about?: FileRef
  web?: boolean
}): ReactNode {
  const links = useContext(FileLinksContext)
  return Children.map(children, (child) => {
    if (typeof child !== 'string') return child
    const found = [
      ...(web ? webLinksIn(child) : []),
      ...(links ? fileLinksIn(child, links) : []),
    ].sort((a, b) => a.start - b.start)
    if (found.length === 0) return child
    const out: ReactNode[] = []
    let at = 0
    for (const link of found) {
      // A path inside a URL is part of the URL.
      if (link.start < at) continue
      out.push(child.slice(at, link.start))
      if ('url' in link) out.push(<WebLink key={link.start} url={link.url} />)
      else {
        const { start, end, ...file } = link
        const ref = file.line === undefined && file.path === about?.path ? about : file
        out.push(<FileLink key={start} file={ref}>{child.slice(start, end)}</FileLink>)
      }
      at = link.end
    }
    out.push(child.slice(at))
    return out
  })
}

/** Inline code, as a link when it is exactly a file's path. */
function InlineCode({ children }: { children: ReactNode }): JSX.Element {
  const links = useContext(FileLinksContext)
  const file = links && typeof children === 'string' ? resolveFilePath(children, links) : undefined
  const code = <code className="rounded bg-surface-2 px-1 py-px font-mono text-[0.9em] text-text">{children}</code>
  return file === undefined ? code : <FileLink file={file}>{code}</FileLink>
}

/** The file a link's target names, at the line of a `:12` or `#L12`. */
function hrefFile(href: string | undefined, links: FileLinks | null): FileRef | undefined {
  if (!href || !links) return undefined
  let decoded = href.replace(/[#?].*$/, '')
  try {
    decoded = decodeURIComponent(decoded)
  } catch {
    // Not percent-encoded after all; match it as written.
  }
  const file = resolveFilePath(decoded, links)
  const anchor = /#L(\d+)/.exec(href)?.[1]
  return file && anchor ? { path: file.path, line: Number(anchor) } : file
}

/** The text and language of a fenced code block, from its hast node. */
function fencedCode(node: unknown): { text: string; language: HighlightLanguage | null } | undefined {
  const pre = (node ?? {}) as { children?: Array<{ tagName?: string; properties?: { className?: unknown }; children?: Array<{ value?: unknown }> }> }
  const code = pre.children?.[0]
  if (code?.tagName !== 'code') return undefined
  const text = (code.children ?? []).map((c) => (typeof c.value === 'string' ? c.value : '')).join('')
  const classes = code.properties?.className
  const names = Array.isArray(classes) ? classes.map(String) : typeof classes === 'string' ? [classes] : []
  const fence = names.find((c) => c.startsWith('language-'))?.slice('language-'.length) ?? ''
  return { text, language: languageForFence(fence) }
}

/** A fenced code block, drawn with `CodeView` inside a card. */
function CodeBlock({ text, language }: { text: string; language: HighlightLanguage | null }): JSX.Element {
  // Drop the fence's trailing newline. Lines are taken literally (not via
  // `codeLines`) so text that looks like line numbers is kept.
  const lines = useMemo(
    () => text.replace(/\n$/, '').split('\n').map((line) => ({ text: line })),
    [text],
  )
  return (
    <pre className="my-1.5 overflow-x-auto rounded-md border border-hairline bg-surface-2 px-2.5 py-1.5">
      <code>
        <CodeView lines={lines} language={language} />
      </code>
    </pre>
  )
}

/**
 * Link used for both links and images. react-markdown's default
 * `urlTransform` has already blanked unsafe protocols such as `javascript:`
 * and `data:`; passing a custom `urlTransform` would replace that check.
 *
 * Nothing in its label links again. claude often labels a link with a
 * backticked path, and a file link inside would take the click: inside a
 * file link it opens the file without the line, inside a web link the
 * click opens both.
 */
function Link({ href, children }: { href?: string; children: ReactNode }): JSX.Element {
  const file = hrefFile(href, useContext(FileLinksContext))
  const label = <FileLinksContext.Provider value={null}>{children}</FileLinksContext.Provider>
  if (file !== undefined) return <FileLink file={file}>{label}</FileLink>
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={LINK_CLASS}>
      {label}
    </a>
  )
}

/**
 * Block code is rendered from `pre` without recursing into its children, so
 * the `code` override only ever sees inline code.
 */
const COMPONENTS: Components = {
  pre: ({ node, children }) => {
    const fenced = fencedCode(node)
    return fenced ? <CodeBlock text={fenced.text} language={fenced.language} /> : <pre>{children}</pre>
  },
  code: ({ children }) => <InlineCode>{children}</InlineCode>,
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0"><Linked>{children}</Linked></p>,
  h1: ({ children }) => <h1 className="mb-1 mt-2.5 text-base font-semibold first:mt-0"><Linked>{children}</Linked></h1>,
  h2: ({ children }) => <h2 className="mb-1 mt-2.5 text-[0.95rem] font-semibold first:mt-0"><Linked>{children}</Linked></h2>,
  h3: ({ children }) => <h3 className="mb-1 mt-2 font-semibold first:mt-0"><Linked>{children}</Linked></h3>,
  h4: ({ children }) => <h4 className="mb-1 mt-2 font-semibold first:mt-0"><Linked>{children}</Linked></h4>,
  ul: ({ children }) => <ul className="my-1.5 list-disc space-y-0.5 pl-5 first:mt-0 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5 first:mt-0 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5 marker:text-text-faint"><Linked>{children}</Linked></li>,
  blockquote: ({ children }) => (
    <blockquote className="my-1.5 border-l-2 border-hairline pl-2.5 text-text-dim">{children}</blockquote>
  ),
  hr: () => <hr className="my-2.5 border-hairline" />,
  strong: ({ children }) => <strong className="font-semibold text-text"><Linked>{children}</Linked></strong>,
  em: ({ children }) => <em><Linked>{children}</Linked></em>,
  a: ({ href, children }) => <Link href={href}>{children}</Link>,
  // Images render as links, never fetched: an automatic <img> request could
  // exfiltrate data encoded in a URL from untrusted content. Don't rely on
  // the server's CSP for this; the dev server sets none.
  img: ({ src, alt, title }) => (
    <Link href={typeof src === 'string' ? src : undefined}>{alt || title || 'image'}</Link>
  ),
  table: ({ children }) => (
    <div className="my-1.5 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-hairline bg-surface-2 px-2 py-1 text-left font-semibold"><Linked>{children}</Linked></th>
  ),
  td: ({ children }) => <td className="border border-hairline px-2 py-1 align-top"><Linked>{children}</Linked></td>,
}

const PLUGINS = [remarkGfm]

/** Memoized on the text so streaming chunks into the last message doesn't
 *  re-parse every earlier one. */
export const Markdown = memo(function Markdown({ children }: { children: string }): ReactNode {
  return <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>{children}</ReactMarkdown>
})
