import { memo, useMemo, type JSX, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeView } from '#components/CodeView'
import { languageForFence, type HighlightLanguage } from '#lib/highlight'

/**
 * Renders agent markdown in the chat pane. Raw HTML stays disabled
 * (react-markdown's default) because the text may echo untrusted repository
 * content. Elements are styled individually with tight margins so a one-line
 * reply stays one line high.
 */

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
 */
function Link({ href, children }: { href?: string; children: ReactNode }): JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-link underline decoration-link/40 underline-offset-2 hover:decoration-link"
    >
      {children}
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
    <th className="border border-hairline bg-surface-2 px-2 py-1 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="border border-hairline px-2 py-1 align-top">{children}</td>,
}

const PLUGINS = [remarkGfm]

/** Memoized on the text so streaming chunks into the last message doesn't
 *  re-parse every earlier one. */
export const Markdown = memo(function Markdown({ children }: { children: string }): ReactNode {
  return <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>{children}</ReactMarkdown>
})
