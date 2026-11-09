import { type Component, MarkdownRenderer, type TFile } from 'obsidian'
import type PMPlugin from '#main'
import {
  formatDateLong,
  formatHours,
  locale,
  meetingDate,
  meetingTitle,
  parseParticipants,
  parseTimesheet,
  projectDataGroups,
  summarizeTimesheet,
  t
} from '@dotpm/core'
import { IconButton, renderPropRow, safeAsync } from '@dotpm/ui'
import type { ProjectFileKind } from '../../components/ProjectFiles'

/** Entries the timesheet section lists below the totals. */
const RECENT_ENTRIES = 3

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface FileSectionContext {
  plugin: PMPlugin
  projectPath: string
  /** Owns the Markdown rendered into the sections. The overview unloads it before each repaint. */
  component: Component
  /** A titled section, the way the overview draws all of its sections. */
  section: (parent: HTMLElement, title: string, note?: string) => HTMLElement
}

function actions(section: HTMLElement): HTMLElement {
  const head = section.find('.pm-overview-section-head') ?? section
  return head.find('.pm-overview-section-actions') ?? head.createDiv('pm-overview-section-actions')
}

function action(section: HTMLElement, icon: string, tooltip: string, onClick: () => Promise<void> | void): void {
  new IconButton(actions(section))
    .setIcon(icon)
    .setTooltip(tooltip)
    .onClick(safeAsync(async () => onClick()))
}

/** Opens the note, creating it first when the project has none: the edit button of a section. */
function editAction(section: HTMLElement, ctx: FileSectionContext, kind: ProjectFileKind): void {
  action(section, 'pencil', t('projectFiles.edit'), () => ctx.plugin.openProjectFile(ctx.projectPath, kind))
}

function emptyState(
  section: HTMLElement,
  text: string,
  create?: { label: string; onClick: () => Promise<void> }
): void {
  const empty = section.createDiv('pm-overview-muted')
  empty.createSpan({ text })
  if (!create) return
  const link = empty.createEl('button', { cls: 'pm-overview-link', text: create.label })
  link.addEventListener('click', safeAsync(create.onClick))
}

async function noteBody(plugin: PMPlugin, file: TFile): Promise<string> {
  return (await plugin.app.vault.cachedRead(file)).replace(FRONTMATTER, '').trim()
}

async function renderNote(ctx: FileSectionContext, file: TFile, host: HTMLElement): Promise<void> {
  const body = await noteBody(ctx.plugin, file)
  if (!host.isConnected) return
  host.empty()
  if (!body) {
    host.createDiv({ cls: 'pm-overview-muted', text: t('meetings.empty') })
    return
  }
  await MarkdownRenderer.render(ctx.plugin.app, body, host, file.path, ctx.component)
}

/**
 * Each meeting note as running text, newest first and open; older ones fold under their
 * date and title, and render the first time they are opened.
 */
export function renderMeetingsSection(parent: HTMLElement, ctx: FileSectionContext): void {
  const files = ctx.plugin.projectFiles.meetings(ctx.projectPath)
  const section = ctx.section(parent, t('overview.meetings'), files.length ? String(files.length) : '')
  action(section, 'plus', t('meetings.new'), () => ctx.plugin.newMeetingFlow(ctx.projectPath))
  if (!files.length) {
    emptyState(section, t('overview.noMeetings'))
    return
  }
  files.forEach((file, index) => {
    const details = section.createEl('details', { cls: 'pm-meeting' })
    const summary = details.createEl('summary', { cls: 'pm-meeting-summary' })
    const date = meetingDate(file.basename)
    if (date) summary.createSpan({ cls: 'pm-meeting-date', text: formatDateLong(date) })
    summary.createSpan({ cls: 'pm-meeting-title', text: meetingTitle(file.basename) || file.basename })
    new IconButton(summary)
      .setIcon('external-link')
      .setTooltip(t('meetings.open'))
      .onClick(
        safeAsync(async (e: MouseEvent) => {
          e.preventDefault()
          await ctx.plugin.app.workspace.getLeaf('tab').openFile(file)
        })
      )
    const body = details.createDiv('pm-meeting-body markdown-rendered')
    let rendered = false
    const show = (): void => {
      if (rendered || !details.open) return
      rendered = true
      void renderNote(ctx, file, body)
    }
    details.addEventListener('toggle', show)
    if (index === 0) {
      details.open = true
      show()
    }
  })
}

function renderValue(value: string): HTMLElement {
  const cell = createDiv('pm-prop-value pm-overview-data-value')
  if (EMAIL.test(value)) cell.createEl('a', { text: value, href: `mailto:${value}` })
  else cell.setText(value)
  return cell
}

/** The data note's properties under their groups, in the order the settings give the fields. */
export function renderProjectDataSection(parent: HTMLElement, ctx: FileSectionContext): void {
  const { plugin } = ctx
  const file = plugin.projectFiles.file(ctx.projectPath, 'data')
  const section = ctx.section(parent, t('overview.projectData'))
  editAction(section, ctx, 'data')
  const frontmatter = file ? plugin.app.metadataCache.getFileCache(file)?.frontmatter : null
  const groups = projectDataGroups(plugin.settings.projectDataFields, frontmatter, t('projectData.more'))
  if (!groups.length) {
    emptyState(section, t('projectData.empty'), {
      label: file ? t('projectFiles.edit') : t('projectData.create'),
      onClick: () => plugin.openProjectFile(ctx.projectPath, 'data')
    })
    return
  }
  for (const group of groups) {
    section.createDiv({ cls: 'pm-overview-data-group', text: group.name })
    const list = section.createDiv('pm-overview-props')
    for (const item of group.items) renderPropRow(list, item.label, () => renderValue(item.value))
  }
}

/** The participants table as one entry per person: name and role, then company and how to reach them. */
export function renderParticipantsSection(parent: HTMLElement, ctx: FileSectionContext): void {
  const { plugin } = ctx
  const file = plugin.projectFiles.file(ctx.projectPath, 'participants')
  const section = ctx.section(parent, t('overview.participants'))
  editAction(section, ctx, 'participants')
  const create = {
    label: file ? t('projectFiles.edit') : t('participants.create'),
    onClick: () => plugin.openProjectFile(ctx.projectPath, 'participants')
  }
  if (!file) {
    emptyState(section, t('participants.empty'), create)
    return
  }
  const list = section.createDiv('pm-participants')
  void (async () => {
    const participants = parseParticipants(await plugin.app.vault.cachedRead(file))
    if (!list.isConnected) return
    if (!participants.length) {
      emptyState(list, t('participants.empty'), create)
      return
    }
    for (const person of participants) {
      const row = list.createDiv('pm-participant')
      const head = row.createDiv('pm-participant-head')
      head.createSpan({ cls: 'pm-participant-name', text: person.name })
      if (person.role) head.createSpan({ cls: 'pm-participant-role', text: person.role })
      const details = row.createDiv('pm-participant-details')
      if (person.company) details.createSpan({ text: person.company })
      if (person.email) details.createEl('a', { text: person.email, href: `mailto:${person.email}` })
      if (person.phone) {
        details.createEl('a', { text: person.phone, href: `tel:${person.phone.replace(/[^\d+]/g, '')}` })
      }
    }
  })()
}

/** The booked hours in total and per person, the latest entries, and a quick way to book more. */
export function renderTimesheetSection(parent: HTMLElement, ctx: FileSectionContext): void {
  const { plugin } = ctx
  const file = plugin.projectFiles.file(ctx.projectPath, 'timesheet')
  const section = ctx.section(parent, t('overview.timesheet'))
  action(section, 'plus', t('timesheet.add'), () => plugin.logTimeFlow(ctx.projectPath))
  if (file) editAction(section, ctx, 'timesheet')
  const add = { label: t('timesheet.add'), onClick: async () => plugin.logTimeFlow(ctx.projectPath) }
  if (!file) {
    emptyState(section, t('timesheet.empty'), add)
    return
  }
  const body = section.createDiv('pm-timesheet')
  void (async () => {
    const entries = parseTimesheet(await plugin.app.vault.cachedRead(file))
    if (!body.isConnected) return
    if (!entries.length) {
      emptyState(body, t('timesheet.empty'), add)
      return
    }
    const hours = (value: number): string => formatHours(value, locale())
    const summary = summarizeTimesheet(entries)
    body.createDiv({ cls: 'pm-timesheet-total', text: t('timesheet.total', { hours: hours(summary.total) }) })
    if (summary.byPerson.length > 1 || summary.byPerson[0]?.person) {
      const people = body.createDiv('pm-overview-props')
      for (const { person, hours: booked } of summary.byPerson) {
        renderPropRow(people, person || t('timesheet.noPerson'), () =>
          createDiv({ cls: 'pm-prop-value', text: `${hours(booked)} h` })
        )
      }
    }
    body.createDiv({ cls: 'pm-overview-data-group', text: t('timesheet.recent') })
    const recent = [...entries].sort((a, b) => b.date.localeCompare(a.date)).slice(0, RECENT_ENTRIES)
    for (const entry of recent) {
      const row = body.createDiv('pm-timesheet-entry')
      row.createSpan({ cls: 'pm-timesheet-entry-date', text: entry.date ? formatDateLong(entry.date) : '—' })
      row.createSpan({ cls: 'pm-timesheet-entry-hours', text: `${hours(entry.hours)} h` })
      row.createSpan({
        cls: 'pm-timesheet-entry-text',
        text: [entry.person, entry.activity].filter(Boolean).join(' · ')
      })
    }
  })()
}
