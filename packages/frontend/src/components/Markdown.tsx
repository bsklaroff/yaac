import { memo, useMemo, type JSX, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeView } from '#components/CodeView'
import { languageForFence, type HighlightLanguage } from '#lib/highlight'

/**
 * Agent prose, rendered as the markdown it is.
 *
 * An agent writes markdown whether or not anyone renders it — headings, lists,
 * tables and fenced code arrive in the ACP stream as literal `##` and triple
 * backticks — so the choice is only whether the user reads the source or the
 * document. Raw HTML stays off (react-markdown's default): the text comes from
 * a model reading untrusted repository content, and nothing about a chat
 * message needs an escape hatch into the DOM.
 *
 * Every element is styled explicitly rather than through a typography preset,
 * because this is a chat bubble, not an article: margins are tight and
 * collapse at the edges, so a one-line reply stays one line high.
 */

/** The raw text and fence language of a ```fenced block, from its hast node.
 *  Typed loosely on purpose — this is a tree shape, not our data. */
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

/**
 * A fenced code block, rendered by the same view a read tool call and the diff
 * views use — so a snippet in a message and the same code shown as a file are
 * the same colors. Only the chrome belongs to this component: a fence sits
 * inside prose, so it gets a card.
 */
function CodeBlock({ text, language }: { text: string; language: HighlightLanguage | null }): JSX.Element {
  // A fence's trailing newline is the fence itself, not a blank last line. The
  // lines are taken literally — never `codeLines` — because a fence is prose
  // the agent wrote, so anything in it that looks like a line-number gutter is
  // text it meant to show.
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
 * The one place a URL from the stream reaches the DOM, shared by links and by
 * images so both get the same treatment. The href is already sanitized by the
 * time it arrives: react-markdown's default `urlTransform` empties any
 * protocol outside `https?`/`ircs?`/`mailto`/`xmpp`, so `javascript:` and
 * `data:` URIs are blanked before a component sees them. Passing a
 * `urlTransform` prop to `ReactMarkdown` would replace that, not add to it.
 */
function Link({ href, children }: { href?: string; children: ReactNode }): JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-[#58a6ff] underline decoration-[#58a6ff]/40 underline-offset-2 hover:decoration-[#58a6ff]"
    >
      {children}
    </a>
  )
}

/**
 * Block code is rendered from `pre` rather than from `code`, and deliberately
 * without recursing into its children: that is what keeps the `code` override
 * below meaning "inline code" without having to guess which it is looking at.
 */
const COMPONENTS: Components = {
  pre: ({ node, children }) => {
    const fenced = fencedCode(node)
    // Anything that isn't the code element a fence produces is passed through
    // untouched — showing it plainly beats dropping it.
    return fenced ? <CodeBlock text={fenced.text} language={fenced.language} /> : <pre>{children}</pre>
  },
  code: ({ children }) => (
    <code className="rounded bg-surface-2 px-1 py-px font-mono text-[0.9em] text-text">{children}</code>
  ),
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children }) => <h1 className="mb-1 mt-2.5 text-base font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-1 mt-2.5 text-[0.95rem] font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 mt-2 font-semibold first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mb-1 mt-2 font-semibold first:mt-0">{children}</h4>,
  ul: ({ children }) => <ul className="my-1.5 list-disc space-y-0.5 pl-5 first:mt-0 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5 first:mt-0 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5 marker:text-text-faint">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-1.5 border-l-2 border-hairline pl-2.5 text-text-dim">{children}</blockquote>
  ),
  hr: () => <hr className="my-2.5 border-hairline" />,
  strong: ({ children }) => <strong className="font-semibold text-text">{children}</strong>,
  a: ({ href, children }) => <Link href={href}>{children}</Link>,
  // An image is shown as a link, never fetched. `<img src>` is a request the
  // browser makes on render — no click, no consent — so an image in a reply
  // built from untrusted repository content is a way out of the page for
  // whatever the URL encodes. The served SPA's CSP does refuse the fetch, but
  // that header belongs to another package and the dev server sets none; a
  // component that is only safe because of it is one edit away from not being.
  // So the pane says what the image claims to be and lets the reader decide.
  img: ({ src, alt, title }) => (
    <Link href={typeof src === 'string' ? src : undefined}>{alt || title || 'image'}</Link>
  ),
  table: ({ children }) => (
    <div className="my-1.5 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-hairline bg-surface-2 px-2 py-1 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="border border-hairline px-2 py-1 align-top">{children}</td>,
}

const PLUGINS = [remarkGfm]

/**
 * Memoized on the text, because the pane re-renders on every streamed chunk
 * and only the last bubble's text is actually changing — re-parsing every
 * earlier message each time is the one cost this rendering could have added.
 */
export const Markdown = memo(function Markdown({ children }: { children: string }): ReactNode {
  return <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>{children}</ReactMarkdown>
})
