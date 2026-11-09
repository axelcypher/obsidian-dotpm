// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { ProjectRow, type ProjectRowProps } from './ProjectRow'

function noop(): void {}

function row(overrides: Partial<ProjectRowProps> = {}): ProjectRow {
  const tbody = document.body.createEl('table').createEl('tbody')
  return new ProjectRow(tbody, {
    title: 'Website',
    icon: '',
    color: '#8b72be',
    depth: 0,
    treeGuides: null,
    isLastChild: true,
    childCount: 0,
    fields: ['status', 'progress'],
    collapsed: false,
    archived: false,
    tasksDone: 1,
    tasksTotal: 4,
    overdue: 0,
    members: [],
    dueLabel: '',
    dueUrgency: 'normal',
    onClick: noop,
    onContextMenu: noop,
    onActions: noop,
    ...overrides
  })
}

const statusChip = (project: ProjectRow): HTMLElement | null =>
  project.el.find('.pm-table-cell-project-status .pm-chip')

describe('ProjectRow status', () => {
  it('tints the row in the color of its preset and names it in the status cell', () => {
    const project = row({ status: { label: 'Active', color: '#79b58d', icon: '', preset: true } })
    expect(project.el.hasClass('pm-project-row--status')).toBe(true)
    expect(project.el.style.getPropertyValue('--pm-project-status-color')).toBe('#79b58d')
    expect(statusChip(project)?.textContent).toBe('Active')
    expect(statusChip(project)?.hasClass('pm-chip--solid')).toBe(true)
  })

  it('shows a value no preset names as written, without tinting the row', () => {
    const project = row({ status: { label: 'someday', color: '', icon: '', preset: false } })
    expect(project.el.hasClass('pm-project-row--status')).toBe(false)
    expect(statusChip(project)?.textContent).toBe('someday')
    expect(statusChip(project)?.hasClass('pm-chip--outline')).toBe(true)
  })

  it('offers an empty chip without a status', () => {
    const project = row({ status: null })
    expect(project.el.hasClass('pm-project-row--status')).toBe(false)
    expect(statusChip(project)?.hasClass('pm-project-status--empty')).toBe(true)
  })

  it('opens the status picker from the chip without opening the project', () => {
    const onStatus = vi.fn<(e: MouseEvent) => void>()
    const onClick = vi.fn<() => void>()
    const project = row({ status: null, onStatus, onClick })
    statusChip(project)?.click()
    expect(onStatus).toHaveBeenCalledTimes(1)
    expect(onClick).not.toHaveBeenCalled()
    project.el.find('.pm-table-cell-title')?.click()
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('leaves the status cell out with the field hidden, but still tints the row', () => {
    const project = row({ fields: ['progress'], status: { label: 'Done', color: '#8a94a0', icon: '', preset: true } })
    expect(statusChip(project)).toBeNull()
    expect(project.el.hasClass('pm-project-row--status')).toBe(true)
  })
})
