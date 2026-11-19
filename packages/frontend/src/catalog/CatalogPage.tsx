import { useState, type JSX } from 'react'
import {
  IDENTITY_FAMILIES, YActions, YAvatar, YBadge, YButton, YCheckbox, YChip, YConfirm, YDialog, YEmptyState, YField, YInput,
  YKbd, YLoader, YLogoMark, YMenu, YMenuCheckboxItem, YMenuItem, YMenuLabel, YMenuPopup, YMenuRadioItem,
  YMenuSeparator, YNumberInput, YSectionLabel, YSegmented, YSelect, YStatus, YSwitch, YTabs, YTextArea, YTip,
  YTooltip, type YStatusKind,
} from '#ui'
import * as icons from '#lib/icons'
import { Item, Section } from './CatalogParts'
import { ChatSection, DataSection, ListsSection, NavigationSection, PagesSection, PanelsSection, ProjectsSection } from './CatalogScreens'

/*
 * Every #ui component in each of its states, laid out like the design's
 * component catalog, at `?catalog`. A new component is added here when it is
 * added to #ui, so this page is where a component is reviewed against the
 * design (test-playwright-scripts/catalog-screens.js shoots it in both themes).
 */

type Theme = 'dark' | 'light'

export function CatalogPage(): JSX.Element {
  const [theme, setTheme] = useState<Theme>('dark')
  return (
    <div data-theme={theme} className="h-full overflow-y-auto bg-surface text-text">
      <header className="flex items-center gap-4 border-b border-line px-12 py-8">
        <div className="mr-auto">
          <h1 className="text-xl font-semibold tracking-tight">yaac components</h1>
          <p className="mt-1 max-w-2xl text-base text-muted">
            Every component screens are built from. A screen that needs something new adds it here first.
          </p>
        </div>
        <YSegmented
          ariaLabel="Theme"
          value={theme}
          onChange={setTheme}
          options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]}
        />
      </header>
      <Basics />
      <Controls />
      <Overlays />
      <ProjectsSection />
      <ChatSection />
      <NavigationSection />
      <PanelsSection />
      <ListsSection />
      <DataSection />
      <PagesSection />
      <States />
    </div>
  )
}

const STATUSES: YStatusKind[] = ['need', 'fail', 'work', 'bg', 'later', 'done', 'unread', 'stop']

function Basics(): JSX.Element {
  const [device, setDevice] = useState<'desktop' | 'phone'>('phone')
  return (
    <Section title="Basics" note="buttons, chips, badges, avatars, loader, status, icons">
      <Item name="YButton · primary"><YButton variant="primary">Allow</YButton></Item>
      <Item name="secondary"><YButton>Open preview</YButton></Item>
      <Item name="ghost"><YButton variant="ghost">Deny</YButton></Item>
      <Item name="danger"><YButton variant="danger">Delete</YButton></Item>
      <Item name="icon"><YButton icon={icons.SendIcon} aria-label="Send" /></Item>
      <Item name="small, key"><YButton variant="ghost" size="sm" kbd="E">Done</YButton></Item>
      <Item name="with icon"><YButton variant="primary" icon={icons.AddIcon}>New session</YButton></Item>
      <Item name="disabled"><YButton disabled>Save</YButton></Item>
      <Item name="YChip">
        <YChip dropdown icon={icons.AcceptEditsIcon}>Accept edits</YChip>
        <YChip selected>Selected</YChip>
      </Item>
      <Item name="YSegmented">
        <YSegmented
          value={device}
          onChange={setDevice}
          options={[{ value: 'desktop', label: 'Desktop' }, { value: 'phone', label: 'Phone' }]}
        />
      </Item>
      <Item name="YBadge">
        <YBadge tone="warning" dot>Waiting for you</YBadge>
        <YBadge tone="info" dot>Working</YBadge>
        <YBadge tone="success" dot>+2 added</YBadge>
        <YBadge tone="danger" dot>Failed</YBadge>
        <YBadge tone="accent" dot>Unread</YBadge>
        <YBadge>Draft</YBadge>
      </Item>
      <Item name="YAvatar">
        <YAvatar id="ben" name="Ben" /><YAvatar id="maya" name="Maya" /><YAvatar id="jo" name="Jo" />
      </Item>
      <Item name="YKbd"><YKbd>⌘K</YKbd><YKbd>esc</YKbd></Item>
      <Item name="YLoader"><YLoader /><YLoader size={20} tone="subtle" /></Item>
      <Item name="YLogoMark · still, colour and mono; step and rise">
        <YLogoMark height={32} colour /><YLogoMark height={32} className="text-muted" />
        <YLogoMark height={32} animation="step" className="text-info" /><YLogoMark height={32} animation="rise" className="text-info" />
      </Item>
      <Item name="YStatus">
        {STATUSES.map((k) => <YStatus key={k} kind={k} />)}
      </Item>
      <Item name="Project families">
        {IDENTITY_FAMILIES.map((f) => (
          <span key={f} className="flex flex-col gap-1">
            {(['fill', 'tint', 'ink', 'deep', 'glow'] as const).map((shade) => (
              <span key={shade} title={`${f}-${shade}`} className="h-4 w-8" style={{ background: `var(--proj-${f}-${shade})` }} />
            ))}
          </span>
        ))}
      </Item>
      <Item name="Icons (#lib/icons)" wide>
        <div className="flex max-w-5xl flex-wrap gap-3 text-muted">
          {Object.entries(icons).filter(([n, v]) => n.endsWith('Icon') && typeof v === 'object').map(([n, I]) => {
            const Glyph = I as icons.Icon
            return <span key={n} title={n}><Glyph size={16} strokeWidth={1.75} /></span>
          })}
        </div>
      </Item>
    </Section>
  )
}

function Controls(): JSX.Element {
  const [tab, setTab] = useState<'agent' | 'workflow' | 'site'>('agent')
  const [on, setOn] = useState(true)
  const [checked, setChecked] = useState(true)
  return (
    <Section title="Controls" note="tabs, fields, selects, switches">
      <Item name="YTabs">
        <YTabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'agent', label: 'Agent', icon: icons.ChatIcon },
            { value: 'workflow', label: 'Workflow', icon: icons.WorkflowIcon },
            { value: 'site', label: 'Site', icon: icons.SiteIcon },
          ]}
        />
      </Item>
      <Item name="YInput"><YInput placeholder="Search sessions" className="w-56" /></Item>
      <Item name="YSelect">
        <YSelect defaultValue="now" className="w-40">
          <option value="now">Now</option><option value="later">Later</option>
        </YSelect>
      </Item>
      <Item name="YNumberInput"><YNumberInput defaultValue={3} min={0} className="h-control-sm w-20" /></Item>
      <Item name="YSwitch"><YSwitch checked={on} onCheckedChange={setOn} aria-label="Enabled" /></Item>
      <Item name="YCheckbox"><YCheckbox checked={checked} onCheckedChange={setChecked}>Run on new PRs</YCheckbox></Item>
      <Item name="YTextArea"><YTextArea rows={3} placeholder="Notes" className="w-72" /></Item>
      <Item name="YField · YSectionLabel">
        <div className="w-72">
          <YSectionLabel>Network</YSectionLabel>
          <YField label="Allowed hosts" hint="One per line." className="mt-2">
            <YInput defaultValue="registry.npmjs.org" className="w-full" />
          </YField>
        </div>
      </Item>
    </Section>
  )
}

function Overlays(): JSX.Element {
  const [dialog, setDialog] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [theme, setTheme] = useState('dark')
  return (
    <Section title="Overlays" note="menus, tooltips, dialogs">
      <Item name="YMenu">
        <YMenu.Root>
          <YMenu.Trigger render={<YButton icon={icons.MoreIcon} aria-label="Open menu" />} />
          <YMenuPopup className="w-56">
            <YMenuLabel>Ben · home-lab</YMenuLabel>
            <YMenuItem icon={icons.SettingsIcon} kbd="⌘,">Settings</YMenuItem>
            <YMenuItem icon={icons.KeyboardIcon} kbd="⌘/">Keyboard shortcuts</YMenuItem>
            <YMenuSeparator />
            <YMenu.RadioGroup value={theme} onValueChange={(v) => setTheme(String(v))}>
              <YMenuRadioItem value="dark">Dark</YMenuRadioItem>
              <YMenuRadioItem value="light">Light</YMenuRadioItem>
            </YMenu.RadioGroup>
            <YMenuCheckboxItem checked>Sound</YMenuCheckboxItem>
            <YMenuSeparator />
            <YMenuItem danger icon={icons.DeleteIcon}>Delete</YMenuItem>
          </YMenuPopup>
        </YMenu.Root>
      </Item>
      <Item name="YActions · 24rem and 12rem wide, pressed and disabled">
        {['w-[24rem]', 'w-[12rem]'].map((width) => (
          <div key={width} className={`@container flex justify-end rounded-sm border border-line p-1 ${width}`}>
            <YActions
              size="sm"
              actions={[
                { label: 'Hide ignored files', icon: icons.ShowIcon, pressed: true, onClick: () => undefined },
                { label: 'New file', icon: icons.NewFileIcon, onClick: () => undefined },
                { label: 'New folder', icon: icons.NewFolderIcon, disabled: true, onClick: () => undefined },
              ]}
            />
          </div>
        ))}
      </Item>
      <Item name="YTooltip">
        <YTooltip tip={<YTip title="New session" keys="⌘N" hint="In the project in scope" />}>
          <YButton icon={icons.AddIcon} aria-label="New session" />
        </YTooltip>
      </Item>
      <Item name="YDialog">
        <YButton onClick={() => setDialog(true)}>Open dialog</YButton>
        <YDialog open={dialog} onOpenChange={setDialog} variant="form" title="Rename session" className="w-[420px]">
          <YInput defaultValue="Fix flaky e2e login test" className="mt-4 w-full" />
          <div className="mt-5 flex justify-end gap-2">
            <YButton variant="ghost" onClick={() => setDialog(false)}>Cancel</YButton>
            <YButton variant="primary" onClick={() => setDialog(false)}>Save</YButton>
          </div>
        </YDialog>
      </Item>
      <Item name="YConfirm">
        <YButton variant="danger" onClick={() => setConfirm(true)}>Delete…</YButton>
        <YConfirm
          open={confirm}
          onOpenChange={setConfirm}
          title="Delete this session?"
          description="Its checkout and conversation go with it."
          onConfirm={() => setConfirm(false)}
        />
      </Item>
    </Section>
  )
}

function States(): JSX.Element {
  return (
    <Section title="Data and states" note="empty and loading">
      <Item name="YEmptyState · loader">
        <div className="flex h-56 w-96 items-center justify-center shadow-inset">
          <YEmptyState mark="loader" title="Adding yaac" description="Cloning the repository. A large repo can take a few minutes." />
        </div>
      </Item>
      <Item name="YEmptyState · logo, action">
        <div className="flex h-56 w-96 items-center justify-center shadow-inset">
          <YEmptyState mark="logo" title="Welcome to yaac" description="Add a project to start."
            action={<YButton>Add a project</YButton>} />
        </div>
      </Item>
      <Item name="YEmptyState · compact">
        <div className="w-60 py-4 shadow-inset">
          <YEmptyState compact title="No workspaces yet" description="Start one with the + above." />
        </div>
      </Item>
    </Section>
  )
}
