import { Menu } from 'obsidian'
import type PMPlugin from '#main'
import { type ProjectLabelConfig, resolveProjectLabel, t } from '@dotpm/core'
import { addPaletteMenuItem, safeAsync, type PlatformMenu, type ProjectRowLabel } from '@dotpm/ui'

function rowLabel(presets: readonly ProjectLabelConfig[], raw: string): ProjectRowLabel {
  const preset = resolveProjectLabel(presets, raw)
  if (!preset) return { label: raw, color: '', icon: '', preset: false }
  return { label: preset.label, color: preset.color, icon: preset.icon, preset: true }
}

/** The project's status as a row or chip shows it, or null without one. */
export function projectRowStatus(plugin: PMPlugin, path: string): ProjectRowLabel | null {
  const raw = plugin.index.projectRef(path)?.status ?? ''
  return raw ? rowLabel(plugin.settings.projectStatuses, raw) : null
}

/** The project's types as a row or chip shows them, each preset once. */
export function projectRowTypes(plugin: PMPlugin, path: string): ProjectRowLabel[] {
  const presets = plugin.settings.projectTypes
  const seen = new Set<string>()
  return (plugin.index.projectRef(path)?.types ?? []).flatMap((raw) => {
    const key = resolveProjectLabel(presets, raw)?.id ?? raw
    if (seen.has(key)) return []
    seen.add(key)
    return [rowLabel(presets, raw)]
  })
}

/** One checked item per preset, and a way back to no status while the project has one. */
export function addProjectStatusItems(menu: PlatformMenu, plugin: PMPlugin, path: string): void {
  const raw = plugin.index.projectRef(path)?.status ?? ''
  const current = resolveProjectLabel(plugin.settings.projectStatuses, raw)
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

/** One item per preset that adds or removes it, and a way to remove them all. */
export function addProjectTypeItems(menu: PlatformMenu, plugin: PMPlugin, path: string): void {
  const presets = plugin.settings.projectTypes
  const values = plugin.index.projectRef(path)?.types ?? []
  const current = new Set(values.map((raw) => resolveProjectLabel(presets, raw)?.id))
  for (const type of presets) {
    addPaletteMenuItem(menu, type, {
      checked: current.has(type.id),
      onClick: safeAsync(() => plugin.toggleProjectType(path, type.id))
    })
  }
  if (values.length) {
    menu.addItem((item) =>
      item
        .setTitle(t('projectType.clear'))
        .setIcon('circle-off')
        .onClick(safeAsync(() => plugin.clearProjectTypes(path)))
    )
  }
}

/** The quick switch behind a status chip. */
export function openProjectStatusMenu(plugin: PMPlugin, path: string, e: MouseEvent): void {
  const menu = new Menu()
  addProjectStatusItems(menu, plugin, path)
  menu.showAtMouseEvent(e)
}

/** The quick switch behind a type chip. Each pick toggles one type; the menu closes after it. */
export function openProjectTypeMenu(plugin: PMPlugin, path: string, e: MouseEvent): void {
  const menu = new Menu()
  addProjectTypeItems(menu, plugin, path)
  menu.showAtMouseEvent(e)
}
