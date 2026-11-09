import { type ProjectListField, t, tn } from '@dotpm/core'
import { setTooltip } from '#platform'
import { formatBadgeText, isIconName } from '../icons'
import { AvatarStack, type AvatarPerson } from '#primitives/AvatarStack'
import { Chip } from '#primitives/Chip'
import { CollapseToggle } from '#primitives/CollapseToggle'
import { IconButton } from '#primitives/IconButton'
import { ProgressBar } from '#primitives/ProgressBar'
import { renderDueChip, type DueUrgency } from './dueChip'
import { renderGlyph } from './properties'
import { renderTagChip } from './tagChip'
import { renderTreeGuides } from './treeGuides'

/** A project's status or one of its types as its row shows it. */
export interface ProjectRowLabel {
  label: string
  color: string
  icon: string
  /** False for a value no preset names: it shows as written, in no color, and the row isn't tinted. */
  preset: boolean
}

/** Tags a row shows before the rest collapse into a count. */
const MAX_ROW_TAGS = 3

export interface ProjectRowProps {
  title: string
  icon: string
  color: string
  depth: number
  /** One entry per indent column: does an ancestor at that column still have rows below it. Null draws no connectors. */
  treeGuides: boolean[] | null
  isLastChild: boolean
  /** Sub-projects below this one. Above zero, the counts are the caller's subtree rollup. */
  childCount: number
  /** The cells after the title, in order. */
  fields: ProjectListField[]
  collapsed: boolean
  archived: boolean
  tasksDone: number
  tasksTotal: number
  overdue: number
  members: AvatarPerson[]
  /** Formatted by the caller; empty when nothing in the project has a date. */
  dueLabel: string
  dueUrgency: DueUrgency
  /** Null or left out for a project without a status. A preset tints the row in its color. */
  status?: ProjectRowLabel | null
  /** Opens the status picker from the status cell. Left out, the cell only shows the status. */
  onStatus?: (e: MouseEvent) => void
  /** The project's types in the order its note lists them. */
  types?: ProjectRowLabel[]
  /** Opens the type picker from the type cell. Left out, the cell only shows the types. */
  onTypes?: (e: MouseEvent) => void
  /** The project note's own tags, without `#`. */
  tags?: string[]
  /** Whether tag chips carry their color dot. */
  showTagColors?: boolean
  /** Leave it out while the list can't collapse, such as during a search: the row then has no toggle. */
  onToggleCollapsed?: () => void
  onClick: () => void
  onContextMenu: (e: MouseEvent) => void
  onActions: (e: MouseEvent) => void
}

const ROW_IGNORE_SELECTOR = 'button, .pm-chip--interactive, .pm-icon-btn, .pm-collapse-toggle'

export class ProjectRow {
  el: HTMLTableRowElement

  constructor(tbody: HTMLElement, props: ProjectRowProps) {
    this.el = tbody.createEl('tr', { cls: 'pm-table-row pm-project-row' })
    if (props.archived) this.el.addClass('pm-table-row--archived')
    this.el.style.setProperty('--depth', String(props.depth))
    if (props.status?.preset) {
      this.el.addClass('pm-project-row--status')
      this.el.style.setProperty('--pm-project-status-color', props.status.color)
    }

    const expand = this.el.createEl('td', { cls: 'pm-table-cell-expand' })
    const { onToggleCollapsed } = props
    if (props.childCount > 0 && onToggleCollapsed) {
      new CollapseToggle(expand, {
        collapsed: props.collapsed,
        onToggle: onToggleCollapsed,
        subject: t('collapse.subProjects')
      })
    }

    const title = this.el.createEl('td', { cls: 'pm-table-cell-title' })
    renderTreeGuides(title, props.treeGuides, props.isLastChild)
    const inner = title.createDiv('pm-table-title-inner')
    renderGlyph(inner.createSpan({ cls: 'pm-project-row-icon' }), { icon: props.icon, color: props.color })
    inner.createSpan({ text: props.title, cls: 'pm-task-title-text' })
    if (props.archived) new Chip(inner).setLabel(t('common.archived')).setVariant('outline').setSize('sm')

    for (const field of props.fields) renderCell(this.el.createEl('td', { cls: 'pm-table-cell' }), field, props)

    const actions = this.el.createEl('td', { cls: 'pm-table-cell pm-table-cell-actions' })
    new IconButton(actions)
      .setIcon('more-horizontal')
      .setTooltip(t('cell.projectActions'))
      .setRevealOnHover(true)
      .onClick((e) => props.onActions(e))

    this.el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      if (target.closest(ROW_IGNORE_SELECTOR)) return
      props.onClick()
    })
    this.el.addEventListener('contextmenu', (e) => props.onContextMenu(e))
  }
}

interface LabelChipOpts {
  /** The text of the chip that stands for no value. */
  empty: string
  tooltip: string
  /** A dot before the label when it has no icon; statuses have one, types don't. */
  dot: boolean
  onClick?: (e: MouseEvent) => void
}

function renderLabelChip(parent: HTMLElement, label: ProjectRowLabel | null, opts: LabelChipOpts): Chip {
  const chip = new Chip(parent).setSize('sm')
  if (label) {
    chip
      .setLabel(formatBadgeText(label.icon, label.label))
      .setColor(label.preset ? label.color : 'var(--text-muted)')
      .setVariant(label.preset ? 'solid' : 'outline')
      .setDot(opts.dot && !label.icon)
    if (isIconName(label.icon)) chip.setLeadingIcon(label.icon)
  } else {
    chip.setLabel(opts.empty).setVariant('outline')
    chip.el.addClass('pm-project-label--empty')
  }
  if (opts.onClick) chip.setTooltip(opts.tooltip).onClick(opts.onClick)
  return chip
}

/** A project's status, or an empty chip to set one from. With `onClick`, the chip opens the status picker. */
export function renderProjectStatusChip(
  parent: HTMLElement,
  status: ProjectRowLabel | null,
  onClick?: (e: MouseEvent) => void
): Chip {
  return renderLabelChip(parent, status, {
    empty: t('projectStatus.none'),
    tooltip: t('projectStatus.change'),
    dot: true,
    onClick
  })
}

/** One chip per type, or an empty chip to add one. With `onClick`, every chip opens the type picker. */
export function renderProjectTypeChips(
  parent: HTMLElement,
  types: ProjectRowLabel[],
  onClick?: (e: MouseEvent) => void
): HTMLElement {
  const list = parent.createSpan({ cls: 'pm-project-label-list' })
  const opts = { empty: t('projectType.none'), tooltip: t('projectType.change'), dot: false, onClick }
  if (!types.length) renderLabelChip(list, null, opts)
  for (const type of types) renderLabelChip(list, type, opts)
  return list
}

function renderTags(cell: HTMLElement, props: ProjectRowProps): void {
  const tags = props.tags ?? []
  if (!tags.length) {
    cell.createSpan({ cls: 'pm-project-row-empty', text: '—' })
    return
  }
  const list = cell.createSpan({ cls: 'pm-project-label-list' })
  for (const tag of tags.slice(0, MAX_ROW_TAGS)) renderTagChip(list, tag, props.showTagColors ?? true)
  if (tags.length > MAX_ROW_TAGS) {
    const more = list.createSpan({ cls: 'pm-project-row-empty', text: `+${tags.length - MAX_ROW_TAGS}` })
    setTooltip(more, tags.slice(MAX_ROW_TAGS).join(', '))
  }
}

function renderCell(cell: HTMLElement, field: ProjectListField, props: ProjectRowProps): void {
  switch (field) {
    case 'status':
      cell.addClass('pm-table-cell-project-status')
      renderProjectStatusChip(cell, props.status ?? null, props.onStatus)
      return
    case 'types':
      cell.addClass('pm-table-cell-project-types')
      renderProjectTypeChips(cell, props.types ?? [], props.onTypes)
      return
    case 'tags':
      cell.addClass('pm-table-cell-project-tags')
      renderTags(cell, props)
      return
    case 'progress':
      cell.addClass('pm-table-cell-progress')
      new ProgressBar(cell)
        .setSize('sm')
        .setValue(props.tasksTotal ? (props.tasksDone / props.tasksTotal) * 100 : 0)
        .setColor(props.color)
        .setShowLabel(true)
      return
    case 'tasks':
      cell.createSpan({ cls: 'pm-project-row-tasks', text: `${props.tasksDone}/${props.tasksTotal}` })
      if (props.overdue > 0) {
        new Chip(cell)
          .setLabel(tn('projectRow.overdue', props.overdue))
          .setVariant('solid')
          .setColor('var(--color-red)')
          .setSize('sm')
          .setStrong()
      }
      return
    case 'members':
      cell.addClass('pm-table-cell-assignees')
      new AvatarStack(cell).setPeople(props.members).setMax(3).setSize('sm')
      return
    case 'due':
      if (props.dueLabel) renderDueChip(cell, props.dueLabel, props.dueUrgency, 'sm')
      else cell.createSpan({ cls: 'pm-project-row-empty', text: '—' })
  }
}
