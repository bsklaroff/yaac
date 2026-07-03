import { useCallback, useState, type JSX } from 'react'
import { FileEditor } from '@/frontend/components/settings/FileEditor'
import {
  getProjectConfig,
  saveProjectConfig,
  getProjectDockerfile,
  saveProjectDockerfile,
} from '@/frontend/lib/projectApi'
import { useSnapshot } from '@/frontend/lib/useSnapshot'
import { useUiStore } from '@/frontend/store'

/**
 * Settings section for the per-machine, per-project overlay files: the
 * project's `yaac-config.json` and `Dockerfile.yaac`. A picker chooses the
 * project (defaulting to the workspace's active one) so any project can be
 * edited here regardless of what's open in the rail.
 */
export function ProjectSettings(): JSX.Element {
  const projects = useSnapshot()?.projects ?? []
  const activeProjectSlug = useUiStore((s) => s.activeProjectSlug)
  // Defaults to the workspace's active project. The settings dialog's portal
  // unmounts on close (keepMounted=false), so this remounts — and re-defaults
  // to the current project — every time the menu is reopened.
  const [picked, setPicked] = useState<string | null>(activeProjectSlug)

  // Keep the selection valid as projects load/change: fall back to the
  // active project, then the first project.
  const slug = picked && projects.some((p) => p.slug === picked)
    ? picked
    : (activeProjectSlug && projects.some((p) => p.slug === activeProjectSlug)
        ? activeProjectSlug
        : (projects[0]?.slug ?? null))

  const loadConfig = useCallback(async (): Promise<string> => {
    if (!slug) return '{}'
    const config = await getProjectConfig(slug)
    return JSON.stringify(config ?? {}, null, 2) + '\n'
  }, [slug])

  const saveConfig = useCallback(async (text: string): Promise<void> => {
    if (!slug) return
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (e) {
      throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`)
    }
    await saveProjectConfig(slug, parsed)
  }, [slug])

  const loadDockerfile = useCallback(
    (): Promise<string> => (slug ? getProjectDockerfile(slug) : Promise.resolve('')),
    [slug],
  )
  const saveDockerfile = useCallback(
    (text: string): Promise<void> => (slug ? saveProjectDockerfile(slug, text) : Promise.resolve()),
    [slug],
  )

  return (
    <section>
      <h2 className="text-sm font-semibold">Project Config</h2>

      {projects.length === 0 || !slug ? (
        <p className="mt-6 text-xs text-text-faint">No projects yet. Add one from the rail first.</p>
      ) : (
        <>
          <div className="mt-6">
            <div className="text-xs font-medium text-text">Project</div>
            <select
              value={slug}
              onChange={(e) => setPicked(e.target.value)}
              className="mt-2 w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-text
                outline-none focus:border-border-strong"
            >
              {projects.map((p) => (
                <option key={p.slug} value={p.slug}>{p.slug}</option>
              ))}
            </select>
          </div>

          <div className="mt-6">
            <div className="text-xs font-medium text-text">yaac-config.json</div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
              This machine&apos;s config overlay for the project.
            </p>
            <div className="mt-2">
              <FileEditor
                key={`config:${slug}`}
                language="json"
                load={loadConfig}
                save={saveConfig}
              />
            </div>
          </div>

          <div className="mt-6">
            <div className="text-xs font-medium text-text">Dockerfile</div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
              Overrides the base image for this project. Use{' '}
              <code className="text-text-dim">{'ARG BASE_IMAGE'}</code> and{' '}
              <code className="text-text-dim">{'FROM ${BASE_IMAGE}'}</code> to layer on the default
              image, or any other <code className="text-text-dim">FROM</code> for a standalone image.
            </p>
            <div className="mt-2">
              <FileEditor
                key={`dockerfile:${slug}`}
                language="dockerfile"
                load={loadDockerfile}
                save={saveDockerfile}
              />
            </div>
          </div>
        </>
      )}
    </section>
  )
}
