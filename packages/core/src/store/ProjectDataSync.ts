import type { ProjectDataField } from '../types'
import { isNoteProperty } from './ProjectFiles'

/*
 * Keeping a project's data note and its spreadsheet in step. Both sides are compared by a
 * fingerprint of their values; whichever changed since the last sync wins, and when both
 * did, the newer file. Everything here is pure; reading and writing happen elsewhere.
 */

export type ProjectDataValue = string | number | boolean | null

/** One row of the data sheet: group and label for people, key and value for programs. */
export interface ProjectDataRow {
  group: string
  label: string
  key: string
  value: ProjectDataValue
}

/** The project folder outside the vault, which leads the sheet. */
export interface ProjectFolderRow {
  key: string
  label: string
  group: string
}

function cellValue(raw: unknown): ProjectDataValue {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string') return raw.trim() === '' ? null : raw.trim()
  if (typeof raw === 'number' || typeof raw === 'boolean') return raw
  if (Array.isArray(raw)) {
    const joined = raw
      .map((item) => String(cellValue(item) ?? ''))
      .filter(Boolean)
      .join(', ')
    return joined || null
  }
  return JSON.stringify(raw)
}

/**
 * The sheet's rows: the project folder, then every field whether filled or not, so the
 * sheet shows what is missing, then the note's other properties.
 */
export function projectDataRows(
  fields: readonly ProjectDataField[],
  frontmatter: Record<string, unknown> | null | undefined,
  folder: ProjectFolderRow,
  otherGroup: string
): ProjectDataRow[] {
  const data = frontmatter ?? {}
  const rows: ProjectDataRow[] = [{ ...folder, value: cellValue(data[folder.key]) }]
  const known = new Set([folder.key, ...fields.map((field) => field.key)])
  for (const field of fields) {
    if (field.key === folder.key) continue
    rows.push({ group: field.group, label: field.label, key: field.key, value: cellValue(data[field.key]) })
  }
  for (const [key, raw] of Object.entries(data)) {
    if (known.has(key) || isNoteProperty(key)) continue
    const value = cellValue(raw)
    if (value !== null) rows.push({ group: otherGroup, label: key, key, value })
  }
  return rows
}

/** Key and value of each row. */
export function rowValues(rows: readonly ProjectDataRow[]): Record<string, ProjectDataValue> {
  return Object.fromEntries(rows.map((row) => [row.key, row.value]))
}

const asText = (value: unknown): string =>
  typeof value === 'string'
    ? value.trim()
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : ''

/**
 * A short fingerprint of the values. Empty and missing count alike, and a number equals
 * its digits, so a value survives a trip through YAML or a spreadsheet unchanged.
 */
export function projectDataHash(values: Record<string, unknown>): string {
  const text = Object.keys(values)
    .filter((key) => asText(values[key]) !== '')
    .sort()
    .map((key) => `${key}\u0000${asText(values[key])}`)
    .join('\u0001')
  // FNV-1a, 32 bit: enough to tell a changed set of values from an unchanged one.
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** The values from the sheet that differ from the note's, which are all a sync has to write. */
export function changedValues(
  note: Record<string, unknown>,
  sheet: Record<string, ProjectDataValue>
): Record<string, ProjectDataValue> {
  return Object.fromEntries(Object.entries(sheet).filter(([key, value]) => asText(note[key]) !== asText(value)))
}

/** What the last sync of a project left behind. */
export interface ProjectSheetState {
  /** Where the sheet was, so a moved project folder starts afresh. */
  path: string
  /** The sheet's modification time right after that sync. */
  mtime: number
  /** The fingerprint both sides had then. */
  hash: string
}

export type SheetSyncAction = 'none' | 'write-sheet' | 'read-sheet'

export interface SheetSyncInput {
  state: ProjectSheetState | undefined
  path: string
  noteHash: string
  noteMtime: number
  /** Null while there is no sheet yet. */
  sheetMtime: number | null
}

/** Which way to sync: whatever changed since the last time, the newer file when both did. */
export function sheetSyncAction(input: SheetSyncInput): SheetSyncAction {
  const { state, sheetMtime } = input
  if (sheetMtime === null) return 'write-sheet'
  const newer: SheetSyncAction = input.noteMtime >= sheetMtime ? 'write-sheet' : 'read-sheet'
  if (!state || state.path !== input.path) return newer
  const noteChanged = input.noteHash !== state.hash
  const sheetChanged = sheetMtime !== state.mtime
  if (noteChanged && sheetChanged) return newer
  if (noteChanged) return 'write-sheet'
  if (sheetChanged) return 'read-sheet'
  return 'none'
}

/**
 * The project folder a description names on a "Projektordner:" line, as a link or as
 * plain text. A `file:///` link becomes the path it points to, with backslashes for a
 * Windows drive. Empty without such a line.
 */
export function projectFolderFromText(markdown: string): string {
  const line = /^\s*[-*]?\s*(?:\*\*)?(?:projektordner|project folder)(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+)$/im.exec(markdown)
  if (!line) return ''
  const value = line[1].trim()
  const link = /\[[^\]]*\]\(([^)]+)\)/.exec(value) ?? /<([^>]+)>/.exec(value)
  let target = (link ? link[1] : value).trim().replace(/^`|`$/g, '')
  if (/^file:/i.test(target)) {
    target = target.replace(/^file:\/*/i, '')
    try {
      target = decodeURI(target)
    } catch {
      // A stray % leaves the link as it is written.
    }
  }
  if (/^[a-z]:[\\/]/i.test(target)) target = target.replace(/\//g, '\\')
  return target.replace(/[\\/]+$/, '')
}
