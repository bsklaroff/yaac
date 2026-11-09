import { api, resolveProject } from '#commands/api'
import { formatCacheVolumes, formatPortForwards, onOff } from '#commands/config-launch-settings'
import { DEFAULT_SCRATCH_DIR_GIB } from '@yaac/shared/types'

/**
 * `yaac config show <project>`: every setting of a project, one per line,
 * each named as the `yaac config` command that changes it. Settings a
 * containerless server lacks are left out there.
 */
export async function configShow(project: string): Promise<void> {
  const p = await resolveProject(project)
  const projectId = p.id
  const [{ driver }, { vars }, { secrets: runSecrets }] = await Promise.all([
    api.health.$get(),
    api.project[':projectId'].env.$get({ param: { projectId } }),
    api.project[':projectId']['run-secrets'].$get({ param: { projectId } }),
  ])
  const k8s = driver === 'k8s'
  const [allowlist, dockerfile] = k8s
    ? await Promise.all([
      api.project[':projectId'].allowlist.$get({ param: { projectId } }),
      api.project[':projectId'].dockerfile.$get({ param: { projectId } }),
    ])
    : [undefined, undefined]
  const list = (items: string[]): string => (items.length === 0 ? 'none' : items.join(', '))

  const rows = ([
    ['git-credential', p.hosted ? 'none needed (hosted by yaac)' : p.gitCredential?.name ?? 'none'],
    p.hosted && ['default-branch-guard', onOff(p.guardDefaultBranch)],
    ['env', list([
      ...vars.map((v) => (v.secret ? `${v.name} (secret)` : v.name)),
      ...runSecrets.map((r) => `${r.name} (run secret)`),
    ])],
    allowlist !== undefined && ['egress-allowlist',
      list([...(allowlist.allowlist.defaults ? ['the defaults'] : []), ...allowlist.allowlist.hosts])],
    ['port-forwards', formatPortForwards(p.portForwards)],
    ['scratch-dirs', list(p.scratchDirs.dirs.map((d) => `${d.path} (${d.sizeGiB ?? DEFAULT_SCRATCH_DIR_GIB} GiB)`))],
    ['kept-ignored-paths', list(p.keptIgnoredPaths ?? [])],
    ['init-steps', list(Object.keys(p.initSteps))],
    ['workspace-auto-delete', p.stoppedWorkspaceRetentionDays === undefined ? 'off' : `${p.stoppedWorkspaceRetentionDays} days`],
    k8s && ['cache-volumes', formatCacheVolumes(p.cacheVolumes)],
    k8s && ['nested-containers', onOff(p.nestedContainers)],
    k8s && ['npm-cache', onOff(p.npmCache)],
    dockerfile !== undefined && ['dockerfile', dockerfile.content.trim() === '' ? 'none' : 'set'],
  ] satisfies Array<[string, string] | false>).filter((row) => row !== false)
  const width = Math.max(...rows.map(([key]) => key.length))
  console.log(`${p.name} (${projectId.slice(0, 8)}), ${p.hosted ? 'hosted by yaac' : p.remoteUrl}`)
  for (const [key, value] of rows) console.log(`  ${key.padEnd(width)}  ${value}`)
  console.log('Change one with `yaac config <setting>`.')
}
