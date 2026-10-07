import type { JSX } from 'react'
import { NewProjectButton } from '#components/NewProjectButton'

const STEPS = [
  ['Add a project', 'Give yaac a git repo URL and a credential to clone it with: an HTTPS token, or an SSH key '
    + 'yaac generates for you to register with the host.'],
  ['Start a workspace', 'Pick a coding agent and give it a prompt. Each workspace is a checkout of its own, '
    + 'so several agents can work on one project at once.'],
  ['Review its work', 'Watch the agent in its terminal or chat, answer it when it waits for you, and '
    + 'review its changes.'],
]

/** The main area when there are no projects yet. */
export function WelcomePane(): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 overflow-y-auto px-8 py-10">
      <div className="m-auto w-full max-w-md">
        <h1 className="text-lg font-semibold text-text">Welcome to yaac</h1>
        <p className="mt-2 text-sm text-text-dim">
          yaac runs coding agents in workspaces, each in its own checkout of a project&apos;s git repo.
        </p>
        <ol className="mt-6 flex flex-col gap-4">
          {STEPS.map(([title, body], i) => (
            <li key={title} className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-2
                text-xs font-semibold text-text-dim">
                {i + 1}
              </span>
              <div>
                <p className="text-sm font-medium text-text">{title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-text-faint">{body}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-6">
          <NewProjectButton variant="cta" />
        </div>
      </div>
    </div>
  )
}
