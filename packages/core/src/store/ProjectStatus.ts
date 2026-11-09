import { DEFAULT_PROJECT_STATUS_PROPERTY, type PMSettings, type ProjectStatusConfig } from '../types'
import { PROJECT_FRONTMATTER_KEYS } from './YamlSerializer'

/**
 * Whether a project note property can hold the status. The keys a project save writes
 * itself would overwrite it, so they are refused.
 */
export function isValidProjectStatusProperty(key: string): boolean {
  const trimmed = key.trim()
  return trimmed !== '' && !PROJECT_FRONTMATTER_KEYS.has(trimmed)
}

/** The property the status is read from and written to. */
export function projectStatusProperty(settings: Pick<PMSettings, 'projectStatusProperty'>): string {
  const key = settings.projectStatusProperty?.trim() ?? ''
  return isValidProjectStatusProperty(key) ? key : DEFAULT_PROJECT_STATUS_PROPERTY
}

/**
 * The preset a property value names: by id, or failing that by id or label ignoring case,
 * so a hand-typed `status: Active` counts as the `active` preset.
 */
export function resolveProjectStatus(
  statuses: readonly ProjectStatusConfig[],
  raw: string
): ProjectStatusConfig | undefined {
  const value = raw.trim()
  if (!value) return undefined
  const exact = statuses.find((status) => status.id === value)
  if (exact) return exact
  const lower = value.toLowerCase()
  return statuses.find((status) => status.id.toLowerCase() === lower || status.label.trim().toLowerCase() === lower)
}

/** Where a project sits in status order. A project without a known status comes after every preset. */
export function projectStatusRank(statuses: readonly ProjectStatusConfig[], raw: string): number {
  const status = resolveProjectStatus(statuses, raw)
  return status ? statuses.indexOf(status) : statuses.length
}

/**
 * A readable id for a preset called `label`, as it is written into project notes, unique
 * among `taken`. Empty when the label holds no letter or digit to build one from.
 */
export function projectStatusIdFor(label: string, taken: readonly string[]): string {
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
