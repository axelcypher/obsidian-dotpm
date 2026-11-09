import { t } from '../i18n'
import {
  DEFAULT_PROJECT_STATUS_PROPERTY,
  DEFAULT_PROJECT_TYPE_PROPERTY,
  DEFAULT_PROJECT_TYPES,
  type PMSettings,
  type ProjectLabelConfig,
  type ProjectTypeConfig
} from '../types'
import { PROJECT_FRONTMATTER_KEYS } from './YamlSerializer'

/**
 * Whether a project note property can hold a status or types. The keys a project save
 * writes itself would overwrite it, so they are refused.
 */
export function isValidProjectLabelProperty(key: string): boolean {
  const trimmed = key.trim()
  return trimmed !== '' && !PROJECT_FRONTMATTER_KEYS.has(trimmed)
}

function propertyOr(key: string | undefined, fallback: string): string {
  const trimmed = key?.trim() ?? ''
  return isValidProjectLabelProperty(trimmed) ? trimmed : fallback
}

/** The property the status is read from and written to. */
export function projectStatusProperty(settings: Pick<PMSettings, 'projectStatusProperty'>): string {
  return propertyOr(settings.projectStatusProperty, DEFAULT_PROJECT_STATUS_PROPERTY)
}

/** The property the types are read from and written to. */
export function projectTypeProperty(settings: Pick<PMSettings, 'projectTypeProperty'>): string {
  return propertyOr(settings.projectTypeProperty, DEFAULT_PROJECT_TYPE_PROPERTY)
}

/**
 * The preset a property value names: by id, or failing that by id or label ignoring case,
 * so a hand-typed `status: Active` counts as the `active` preset.
 */
export function resolveProjectLabel<T extends ProjectLabelConfig>(entries: readonly T[], raw: string): T | undefined {
  const value = raw.trim()
  if (!value) return undefined
  const exact = entries.find((entry) => entry.id === value)
  if (exact) return exact
  const lower = value.toLowerCase()
  return entries.find((entry) => entry.id.toLowerCase() === lower || entry.label.trim().toLowerCase() === lower)
}

/** Where a value sits in the presets' order. A value no preset names comes after every preset. */
export function projectLabelRank(entries: readonly ProjectLabelConfig[], raw: string): number {
  const entry = resolveProjectLabel(entries, raw)
  return entry ? entries.indexOf(entry) : entries.length
}

/**
 * The values a property holds: a list, one value, or one line of comma-separated values as
 * the property editor leaves a text property. Numbers count as their digits.
 */
export function projectLabelValues(raw: unknown): string[] {
  const items: unknown[] = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [raw]
  return items
    .filter((item) => typeof item === 'string' || typeof item === 'number')
    .map((item) => String(item).trim())
    .filter(Boolean)
}

/**
 * The values with `id` added, or taken out when one of them already names its preset. The
 * order and every value no preset names stay as they were.
 */
export function toggleProjectLabel(
  entries: readonly ProjectLabelConfig[],
  values: readonly string[],
  id: string
): string[] {
  const named = (value: string): boolean => resolveProjectLabel(entries, value)?.id === id
  return values.some(named) ? values.filter((value) => !named(value)) : [...values, id]
}

/**
 * A readable id for a preset called `label`, as it is written into project notes, unique
 * among `taken`. Empty when the label holds no letter or digit to build one from.
 */
export function projectLabelIdFor(label: string, taken: readonly string[]): string {
  const base = label
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!base) return ''
  let id = base
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`
  return id
}

/**
 * The default types with their labels in the active language, for a vault that has none
 * yet. Their ids are built from those labels, so a German vault writes `umbau`.
 */
export function defaultProjectTypes(): ProjectTypeConfig[] {
  const labels: Record<string, string> = {
    'new-build': t('projectType.newBuild'),
    conversion: t('projectType.conversion'),
    extension: t('projectType.extension'),
    'existing-building': t('projectType.existingBuilding'),
    'listed-building': t('projectType.listedBuilding')
  }
  const taken: string[] = []
  return DEFAULT_PROJECT_TYPES.map((type) => {
    const label = labels[type.id] ?? type.label
    const id = projectLabelIdFor(label, taken) || type.id
    taken.push(id)
    return { ...type, id, label }
  })
}
