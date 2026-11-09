import { read, utils, write } from 'xlsx'
import type { ProjectDataRow, ProjectDataValue } from '@dotpm/core'

/** The words the workbook is written with, in the vault's language. */
export interface ProjectDataSheetLabels {
  /** The list sheet, which is also the one read back. */
  sheet: string
  /** The one-row sheet for mail merges and other programs. */
  mailMerge: string
  group: string
  label: string
  key: string
  value: string
}

const KEY_HEADINGS = ['schlüssel', 'key', 'eigenschaft', 'property']
const VALUE_HEADINGS = ['wert', 'value']

/**
 * A workbook with two sheets: the rows as a list (group, label, key, value) to read and
 * edit, and the keys as headings over one row of values, as a mail merge expects them.
 */
export function writeProjectDataWorkbook(rows: readonly ProjectDataRow[], labels: ProjectDataSheetLabels): Uint8Array {
  const book = utils.book_new()
  const list = utils.aoa_to_sheet([
    [labels.group, labels.label, labels.key, labels.value],
    ...rows.map((row) => [row.group, row.label, row.key, row.value])
  ])
  list['!cols'] = [{ wch: 14 }, { wch: 26 }, { wch: 26 }, { wch: 48 }]
  utils.book_append_sheet(book, list, labels.sheet)
  const merge = utils.aoa_to_sheet([rows.map((row) => row.key), rows.map((row) => row.value)])
  utils.book_append_sheet(book, merge, labels.mailMerge)
  return new Uint8Array(write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
}

/** A cell as text: what a heading or a key is written as. */
function cellText(cell: unknown): string {
  if (typeof cell === 'string') return cell.trim()
  return typeof cell === 'number' || typeof cell === 'boolean' ? String(cell) : ''
}

function columnOf(header: unknown[], names: string[], fallback: number): number {
  const index = header.findIndex((cell) => names.includes(cellText(cell).toLowerCase()))
  return index === -1 ? fallback : index
}

function sheetValue(raw: unknown): ProjectDataValue {
  if (raw === null || raw === undefined) return null
  if (raw instanceof Date) return raw.toISOString().slice(0, 10)
  if (typeof raw === 'string') return raw.trim() === '' ? null : raw.trim()
  if (typeof raw === 'number' || typeof raw === 'boolean') return raw
  return null
}

/**
 * Key and value of each row of the list sheet, wherever its key and value columns are,
 * found by their headings. The mail merge sheet is never read: it only mirrors the list.
 */
export function readProjectDataWorkbook(
  data: ArrayBuffer | Uint8Array,
  labels: ProjectDataSheetLabels
): Record<string, ProjectDataValue> {
  const book = read(data, { type: 'array', cellDates: true })
  const sheet = book.Sheets[labels.sheet] ?? book.Sheets[book.SheetNames[0]]
  if (!sheet) return {}
  const rows = utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null })
  const header = rows[0] ?? []
  const keyColumn = columnOf(header, [labels.key.toLowerCase(), ...KEY_HEADINGS], 2)
  const valueColumn = columnOf(header, [labels.value.toLowerCase(), ...VALUE_HEADINGS], 3)
  const values: Record<string, ProjectDataValue> = {}
  for (const row of rows.slice(1)) {
    const key = cellText(row[keyColumn])
    if (key) values[key] = sheetValue(row[valueColumn])
  }
  return values
}
