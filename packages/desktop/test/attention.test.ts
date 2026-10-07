import { describe, it, expect } from 'vitest'
import {
  badgeText,
  notificationFor,
  AttentionMonitor,
} from '#attention'
import type { ProjectSummary, ServerSnapshot, WorkspaceListEntry } from '@yaac/shared/types'

const snap = (entries: Array<Partial<WorkspaceListEntry>>): ServerSnapshot => ({
  driver: 'k8s',
  workspaceGroups: [],
  queuedWorkspaces: [],
  heldWorkspaces: [],
  draftWorkspaces: [],
  workspaces: entries.map((s, i): WorkspaceListEntry => ({
    workspaceId: s.workspaceId ?? `s${i}`,
    projectId: s.projectId ?? 'proj',
    tool: s.tool ?? 'claude',
    status: s.status ?? 'running',
    createdAt: '2026-01-01 00:00:00',
    blockedHosts: [],
    forwardedPorts: [],
    unforwardedPorts: [],
    agentSessions: [],
    ...s,
  })),
  stale: [],
  projects: [],
  provisioning: [],
  gitAuthFailures: {},
  imageBuilds: [],
  planUsage: {},
  forwardBindHost: '127.0.0.1',
  codexPlanUsage: {},
})

describe('badgeText', () => {
  it('is the count when positive', () => expect(badgeText(3)).toBe('3'))
  it('is empty at zero', () => expect(badgeText(0)).toBe(''))
})

describe('notificationFor', () => {
  it('names the project and workspace, by title, else prompt, else id', () => {
    const projects = [{ id: 'proj', name: 'Widgets' } as ProjectSummary]
    const [titled, prompted, bare, orphan] = snap([
      { workspaceId: 'a', projectId: 'proj', title: 'Fix bug' },
      { workspaceId: 'b', prompt: 'P' },
      { workspaceId: 'c' },
      { workspaceId: 'd', projectId: 'gone' },
    ]).workspaces
    expect(notificationFor(titled, projects)).toEqual({ title: 'Workspace waiting for you', body: 'Widgets · Fix bug' })
    expect([prompted, bare].map((w) => notificationFor(w, projects).body)).toEqual(['Widgets · P', 'Widgets · c'])
    // A project missing from the list is named by its id.
    expect(notificationFor(orphan, projects).body).toBe('gone · d')
  })
})

describe('AttentionMonitor', () => {
  it('seeds silently on the first snapshot but still counts', () => {
    const m = new AttentionMonitor()
    const r = m.update(snap([{ workspaceId: 'a', status: 'waiting', waitingSinceMs: 1 }]))
    expect(r.waitingCount).toBe(1)
    expect(r.toNotify).toEqual([])
  })
  it('notifies on a workspace that enters waiting after seeding', () => {
    const m = new AttentionMonitor()
    m.update(snap([{ workspaceId: 'a', status: 'running' }]))
    const r = m.update(snap([{ workspaceId: 'a', status: 'waiting', waitingSinceMs: 1 }]))
    expect(r.toNotify.map((s) => s.workspaceId)).toEqual(['a'])
    expect(r.waitingCount).toBe(1)
  })
  it('does not re-notify an ongoing wait, but does a new spell', () => {
    const m = new AttentionMonitor()
    m.update(snap([{ workspaceId: 'a', status: 'running' }]))
    m.update(snap([{ workspaceId: 'a', status: 'waiting', waitingSinceMs: 1 }]))
    const r = m.update(snap([{ workspaceId: 'a', status: 'waiting', waitingSinceMs: 1 }]))
    expect(r.toNotify).toEqual([])
    expect(r.waitingCount).toBe(1)
    const again = m.update(snap([{ workspaceId: 'a', status: 'waiting', waitingSinceMs: 2 }]))
    expect(again.toNotify.map((s) => s.workspaceId)).toEqual(['a'])
  })
})
