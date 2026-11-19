import { useState, type JSX } from 'react'
import {
  YAgentText, YAsk, YBars, YButton, YChip, YCmdK, YComposer, YDetailCard, YDetailRow, YDetailsPanel,
  YListRow, YListSection, YMachineCard, YMeter, YPanel, YPanelHeader, YPanelTab, YPersonRow, YProjectCard, YProjectRail,
  YProjectTile, YRailItem, YRoutineRow, YSessionRow, YSidebar, YSidebarAll, YSidebarNewSession, YStatCard, YStep, YTopBar, YUserMessage,
} from '#ui'
import * as icons from '#lib/icons'
import { YInput, YSection, YSettingGroup, YSettingRow, YSwitch } from '#ui'
import { Item, Section } from './CatalogParts'

/* The catalog's project, chat, navigation, panel, list and data sections. */

const P = { yaac: { id: 'p-yaac', name: 'yaac' }, site: { id: 'p-site2', name: 'site' }, infra: { id: 'p-infra', name: 'infra' } }
const noop = (): void => {}
/* Tile pictures: one on a solid background of its own, which a working
 * tile keys out, and one with none. */
const svgUrl = (body: string): string =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`)}`
const opaqueIcon = svgUrl('<rect width="10" height="10" fill="#17171a"/><path d="M3 2v6M5 3v6M7 2v6" stroke="#6bc87f" stroke-width="1.2"/>')
const transparentIcon = svgUrl('<circle cx="5" cy="5" r="3" fill="#e8e8f0"/>')

export function ProjectsSection(): JSX.Element {
  return (
    <Section title="Projects" note="tile states, rail, card">
      <Item name="YProjectTile · quiet, working 1 and 3, waiting, failed, current, lit">
        <div className="flex gap-2 bg-shell p-2">
          <YProjectTile id="a" name="atlas" />
          <YProjectTile id="s" name="site" agents={1} />
          <YProjectTile id="d" name="docs" agents={3} />
          <YProjectTile id="i" name="infra" waiting={2} />
          <YProjectTile id="api" name="api" failed />
          <YProjectTile id="r" name="relay" current />
          <YProjectTile id="y" name="yaac" current agents={2} />
          <YProjectTile id="m" name="mobile" lit />
        </div>
      </Item>
      <Item name="YProjectTile · a picture: quiet, working, current and working; a transparent one working">
        <div className="flex gap-2 bg-shell p-2">
          <YProjectTile id="y" name="yaac" imageUrl={opaqueIcon} />
          <YProjectTile id="y" name="yaac" imageUrl={opaqueIcon} agents={1} />
          <YProjectTile id="y" name="yaac" imageUrl={opaqueIcon} agents={3} current />
          <YProjectTile id="s" name="site" imageUrl={transparentIcon} agents={2} />
        </div>
      </Item>
      <Item name="YProjectRail">
        <YProjectRail
          className="h-[420px]"
          top={<><YRailItem icon={icons.HomeIcon} label="Home" dot active /></>}
          bottom={<YRailItem label="yaac"><span className="text-subtle">Y</span></YRailItem>}
        >
          <YProjectTile size={44} id="y" name="yaac" current agents={2} />
          <YProjectTile size={44} id="i" name="infra" waiting={2} />
          <YProjectTile size={44} id="s" name="site" agents={1} />
          <YProjectTile size={44} id="api" name="api" failed />
          <YProjectTile size={44} id="a" name="atlas" />
          <YRailItem icon={icons.AddIcon} label="Add a project" />
        </YProjectRail>
      </Item>
      <Item name="YProjectCard">
        <div className="w-[360px]">
          <YProjectCard id="y" name="yaac" remote="github.com/acme/yaac" waiting={1} working={2} onOpen={noop}
            activity={<YBars name="Sessions this week" values={[2, 4, 3, 5, 6, 1, 0, 3]} height={24} className="w-16" />}
            rows={[{ label: 'Last change', value: 'Bump vitest to 3.x', meta: '18m' }, { label: 'Routine', value: 'Watch PRs, on new PR' }]} />
        </div>
      </Item>
    </Section>
  )
}

export function ChatSection(): JSX.Element {
  return (
    <Section title="Chat" note="messages, asks, composer">
      <Item name="YUserMessage" wide>
        <div className="w-[540px]"><YUserMessage>The e2e login test fails about one run in five. Find out why, fix it, then commit.</YUserMessage></div>
      </Item>
      <Item name="YAgentText">
        <div className="w-[540px]"><YAgentText>The test navigates as soon as the login form submits, but the session cookie arrives a few hundred milliseconds later.</YAgentText></div>
      </Item>
      <Item name="YAsk · command">
        <YAsk className="w-[540px]" title="Run pnpm install?"
          description="It needs to reach registry.npmjs.org, which this project blocks. Allowing opens it for this session only."
          actions={[{ label: 'Allow', onClick: noop }, { label: 'Always allow in this project', onClick: noop }, { label: 'Deny', variant: 'ghost', onClick: noop }]}
          onReply={noop} />
      </Item>
      <Item name="YAsk · question">
        <YAsk className="w-[540px]" title="Limit per API key or per IP address?"
          options={[{ label: 'Per API key', onPick: noop }, { label: 'Per IP address', onPick: noop }, { label: 'Both, key first', onPick: noop }]}
          onReply={noop} />
      </Item>
      <Item name="YComposer">
        <YComposer className="w-[540px]"
          tools={<><YButton variant="ghost" size="sm" icon={icons.AddIcon} aria-label="Attach" /><YChip dropdown>Accept edits</YChip>
            <YChip dropdown>Claude Opus 5.5</YChip><YChip dropdown>High effort</YChip></>}
          send={<YButton icon={icons.SendIcon} aria-label="Send" />}>
          <textarea rows={2} placeholder="Reply" className="resize-none bg-transparent px-3 pt-3 text-base text-text outline-none placeholder:text-subtle" />
        </YComposer>
      </Item>
    </Section>
  )
}

export function NavigationSection(): JSX.Element {
  const [cmdk, setCmdk] = useState(false)
  return (
    <Section title="Navigation" note="top bar, sidebar, command palette">
      <Item name="YTopBar" wide>
        <YTopBar title="Fix flaky e2e login test" sub="fix/e2e-login"
          trailing={<><span className="mr-2 text-md"><span className="text-success">+37</span> <span className="text-danger">−9</span></span>
            <YButton variant="ghost" icon={icons.PreviewIcon} aria-label="Preview" />
            <YButton variant="ghost" icon={icons.TerminalIcon} aria-label="Terminal" />
            <YButton variant="ghost" icon={icons.FilesIcon} aria-label="Files" />
            <YButton variant="ghost" icon={icons.DetailsIcon} aria-label="Details" /></>} />
      </Item>
      <Item name="YSidebar · Home scope">
        <YSidebar width={248} className="h-[380px]" newSession={<YSidebarNewSession kbd="⌘N" onClick={noop} />} footer={<YSidebarAll count={48} onClick={noop} />}>
          <YListSection label="Needs you" />
          <YSessionRow label="Fix flaky e2e login test" status="need" strong selected title="Fix flaky e2e login test" sub="Wants to run pnpm install" project={P.yaac} onSelect={noop} />
          <YSessionRow label="Rate-limit" status="need" strong title="Rate-limit the public API" sub="Asked a question" project={P.site} onSelect={noop} />
          <YListSection label="Working" />
          <YSessionRow label="Migrate" status="work" title="Migrate auth to passkeys" project={P.yaac} onSelect={noop} />
          <YSessionRow label="Watch" status="bg" title="Watch PRs and review" project={P.yaac} onSelect={noop} />
          <YSessionRow label="Watch s1" depth={1} status="work" title="Reviewer" onSelect={noop} />
          <YListSection label="Done" />
          <YSessionRow label="Bump" status="done" strong title="Bump vitest to 3.x" project={P.infra} onSelect={noop} />
        </YSidebar>
      </Item>
      <Item name="YCmdK">
        <YButton onClick={() => setCmdk(true)} kbd="Alt+O">Open palette</YButton>
        <YCmdK open={cmdk} onOpenChange={setCmdk} groups={[
          { label: 'Needs you', items: [
            { id: 'a', title: 'Rate-limit the public API', meta: 'site', detail: 'question', onSelect: noop },
            { id: 'b', title: 'Fix flaky e2e login test', meta: 'yaac', detail: 'approve pnpm install', onSelect: noop }] },
          { label: 'Actions', items: [{ id: 'n', title: 'New session in yaac', kbd: '⌘N', onSelect: noop }] },
        ]} />
      </Item>
    </Section>
  )
}

export function PanelsSection(): JSX.Element {
  const [git, setGit] = useState(true)
  return (
    <Section title="Panels" note="pane frame, details">
      <Item name="YPanel · YPanelHeader · YPanelTab">
        <YPanel className="h-48 w-[420px] shadow-inset"
          header={<YPanelHeader tabs={<><YPanelTab active label="Preview" onSelect={noop} /><YPanelTab active={false} label="Changes" onSelect={noop} /></>}
            actions={<><YButton variant="ghost" size="sm" icon={icons.OpenLinkIcon} aria-label="Pop out" />
              <YButton variant="ghost" size="sm" icon={icons.ExpandIcon} aria-label="Expand" />
              <YButton variant="ghost" size="sm" icon={icons.CloseIcon} aria-label="Close" /></>} />}>
          <div className="p-4 text-md text-muted">Pane body</div>
        </YPanel>
      </Item>
      <Item name="YDetailsPanel · YDetailCard">
        <div className="h-[460px] w-[260px] bg-shell">
          <YDetailsPanel footer={<><YButton>Stop session</YButton><YButton variant="danger">Delete</YButton></>}>
            <YDetailCard title="Where it runs">
              <YDetailRow icon={<icons.DockerIcon size={13} />} note="on this computer">Container</YDetailRow>
              <YDetailRow icon={<icons.QueuedIcon size={13} />} action={<YButton variant="ghost" size="sm">Keep running</YButton>}>Stops in 1h 20m</YDetailRow>
            </YDetailCard>
            <YDetailCard title="Git" open={git} onToggle={() => setGit(!git)}>
              <YDetailRow icon={<icons.BranchIcon size={13} />}>auth/passkeys</YDetailRow>
              <YDetailRow icon={<icons.CommitsIcon size={13} />} note="1 behind">3 commits ahead of main</YDetailRow>
            </YDetailCard>
            <YDetailCard title="Changes" open={false} onToggle={noop} summary="+212 −48" />
            <YDetailCard title="Network" open={false} onToggle={noop} summary="1 blocked host" tone="warning" />
          </YDetailsPanel>
        </div>
      </Item>
    </Section>
  )
}

export function ListsSection(): JSX.Element {
  return (
    <Section title="Lists" note="rows for sessions, routines, people, steps">
      <Item name="YListSection · YListRow">
        <div className="w-[480px]">
          <YListSection label="Needs you" count={2} />
          <YListRow label="Fix" title="Fix flaky e2e login test" sub="approve pnpm install" person={{ id: 'ben', name: 'Ben' }} time="4m" onSelect={noop} />
          <YListRow label="Split" title="Split billing service" sub="stopped" person={{ id: 'maya', name: 'Maya' }} time="2d" onSelect={noop} />
        </div>
      </Item>
      <Item name="YRoutineRow"><div className="w-[300px]"><YRoutineRow label="Watch" name="Watch PRs and review" trigger="On new PR" onSelect={noop} /></div></Item>
      <Item name="YPersonRow"><div className="w-[340px]"><YPersonRow id="ben" name="Ben" role="Owner" meta="4 sessions running" /></div></Item>
      <Item name="YStep"><div className="w-[340px]"><YStep n={1} title="Add a project">Give yaac a git repo URL and a credential to clone it.</YStep></div></Item>
    </Section>
  )
}

export function DataSection(): JSX.Element {
  return (
    <Section title="Data" note="stats, meters, charts, machines">
      <Item name="YStatCard"><YStatCard value={23} label="sessions" /><YStatCard value={41} label="commits" /></Item>
      <Item name="YMeter"><YMeter className="w-[380px]" label="CPU" value={0.46} /><YMeter className="w-[380px]" label="Memory" value={0.97} /></Item>
      <Item name="YBars"><YBars name="Sessions per day" className="w-[320px]" height={56} values={[3, 5, 4, 6, 8, 1, 0, 4, 6, 5, 8, 4, 3, 5]} /></Item>
      <Item name="YMachineCard">
        <YMachineCard className="w-[340px]" name="home-lab" sessions="5 sessions"
          meters={[{ label: 'CPU', value: 0.46 }, { label: 'Memory', value: 0.62 }, { label: 'Disk', value: 0.86 }]} />
      </Item>
    </Section>
  )
}

export function PagesSection(): JSX.Element {
  const [on, setOn] = useState(true)
  return (
    <Section title="Pages" note="sections and setting rows, for forms, panes and settings">
      <Item name="YSection · YSettingGroup · YSettingRow" wide>
        <div className="w-[640px]">
          <YSection title="Network" description="What workspaces in this project may reach."
            actions={<YButton size="sm">Add host</YButton>}>
            <YSettingGroup>
              <YSettingRow label="Allow package registries" hint="npm, PyPI and crates.io.">
                <YSwitch checked={on} onCheckedChange={setOn} aria-label="Allow package registries" />
              </YSettingRow>
              <YSettingRow label="Proxy" hint="Where outbound traffic goes."><YInput defaultValue="none" className="w-48" /></YSettingRow>
              <YSettingRow label="Allowed hosts" stacked><YInput defaultValue="registry.npmjs.org" className="w-full" /></YSettingRow>
            </YSettingGroup>
          </YSection>
        </div>
      </Item>
    </Section>
  )
}
