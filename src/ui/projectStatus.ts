import { Menu } from 'obsidian'
import type PMPlugin from '#main'
import { resolveProjectStatus, t } from '@dotpm/core'
import { addPaletteMenuItem, safeAsync, type PlatformMenu, type ProjectRowStatus } from '@dotpm/ui'

/** The project's status as a row or chip shows it, or null without one. */
export function projectRowStatus(plugin: PMPlugin, path: string): ProjectRowStatus | null {
  const raw = plugin.index.projectRef(path)?.status ?? ''
  if (!raw) return null
  const preset = resolveProjectStatus(plugin.settings.projectStatuses, raw)
  if (!preset) return { label: raw, color: '', icon: '', preset: false }
  return { label: preset.label, color: preset.color, icon: preset.icon, preset: true }
}

/** One checked item per preset, and a way back to no status while the project has one. */
export function addProjectStatusItems(menu: PlatformMenu, plugin: PMPlugin, path: string): void {
  const raw = plugin.index.projectRef(path)?.status ?? ''
  const current = resolveProjectStatus(plugin.settings.projectStatuses, raw)
  for (const status of plugin.settings.projectStatuses) {
    addPaletteMenuItem(menu, status, {
      checked: status.id === current?.id,
      onClick: safeAsync(() => plugin.setProjectStatus(path, status.id))
    })
  }
  if (raw) {
    menu.addItem((item) =>
      item
        .setTitle(t('projectStatus.clear'))
        .setIcon('circle-off')
        .onClick(safeAsync(() => plugin.setProjectStatus(path, null)))
    )
  }
}

/** The quick switch behind a status chip. */
export function openProjectStatusMenu(plugin: PMPlugin, path: string, e: MouseEvent): void {
  const menu = new Menu()
  addProjectStatusItems(menu, plugin, path)
  menu.showAtMouseEvent(e)
}
