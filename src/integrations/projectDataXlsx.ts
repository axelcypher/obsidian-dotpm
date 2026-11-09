import { read, utils } from 'xlsx'
import type { ProjectDataRow, ProjectDataValue } from '@dotpm/core'
import { type XlsxRow, type XlsxStyle, writeXlsx } from './xlsxWriter'

/** The words the workbook is written with, in the vault's language. */
export interface ProjectDataSheetLabels {
  /** The list sheet, which is also the one read back. */
  sheet: string
  /** The one-row sheet for mail merges and other programs. */
  mailMerge: string
  /** Headings an older sheet may carry over its key and value columns. */
  key: string
  value: string
}

const KEY_HEADINGS = ['schlüssel', 'key', 'eigenschaft', 'property']
const VALUE_HEADINGS = ['wert', 'value']

/** Where the list sheet keeps a row's label, key and value; column A holds the group headings. */
const LABEL_COLUMN = 1
const KEY_COLUMN = 2
const VALUE_COLUMN = 3

const FONT = { name: 'Arial', size: 12 }
const GROUP: XlsxStyle = { bold: true, size: 14, fill: 'D9D9D9' }
const LABEL: XlsxStyle = { bold: true, size: 10 }
const VALUE: XlsxStyle = { size: 10 }

/**
 * The list sheet: each group as a grey band with its name, then one row per field with its
 * label in bold, its key, and its value.
 */
function listRows(rows: readonly ProjectDataRow[]): XlsxRow[] {
  const out: XlsxRow[] = []
  let group: string | null = null
  for (const row of rows) {
    if (row.group !== group) {
      group = row.group
      if (group) out.push({ cells: [{ value: group, style: GROUP }], style: GROUP, height: 21 })
    }
    const cells: XlsxRow['cells'] = []
    cells[LABEL_COLUMN] = { value: row.label, style: LABEL }
    cells[KEY_COLUMN] = { value: row.key }
    cells[VALUE_COLUMN] = { value: row.value, style: VALUE }
    out.push({ cells })
  }
  return out
}

/**
 * A workbook with two sheets: the data as a grouped list to read and edit, and the keys as
 * headings over one row of values, as a mail merge expects them.
 */
export function writeProjectDataWorkbook(rows: readonly ProjectDataRow[], labels: ProjectDataSheetLabels): Uint8Array {
  return writeXlsx(
    [
      { name: labels.sheet, columns: [3, 26, 26, 80], rows: listRows(rows) },
      {
        name: labels.mailMerge,
        columns: rows.map(() => 22),
        rows: [
          { cells: rows.map((row) => ({ value: row.key, style: LABEL })) },
          { cells: rows.map((row) => ({ value: row.value, style: VALUE })) }
        ]
      }
    ],
    FONT
  )
}

/** A cell as text: what a heading or a key is written as. */
function cellText(cell: unknown): string {
  if (typeof cell === 'string') return cell.trim()
  return typeof cell === 'number' || typeof cell === 'boolean' ? String(cell) : ''
}

function sheetValue(raw: unknown): ProjectDataValue {
  if (raw === null || raw === undefined) return null
  if (raw instanceof Date) return raw.toISOString().slice(0, 10)
  if (typeof raw === 'string') return raw.trim() === '' ? null : raw.trim()
  if (typeof raw === 'number' || typeof raw === 'boolean') return raw
  return null
}

/**
 * Key and value of each row of the list sheet. A sheet with headings over its columns,
 * as older versions wrote and people rearrange, is read by those headings; otherwise key
 * and value are columns C and D. Group headings have no key and are passed over. The mail
 * merge sheet is never read: it only mirrors the list.
 */
export function readProjectDataWorkbook(
  data: ArrayBuffer | Uint8Array,
  labels: ProjectDataSheetLabels
): Record<string, ProjectDataValue> {
  const book = read(data, { type: 'array', cellDates: true })
  const sheet = book.Sheets[labels.sheet] ?? book.Sheets[book.SheetNames[0]]
  if (!sheet) return {}
  const rows = utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null })
  const header = (rows[0] ?? []).map((cell) => cellText(cell).toLowerCase())
  const keyHeading = header.findIndex((cell) => [labels.key.toLowerCase(), ...KEY_HEADINGS].includes(cell))
  const valueHeading = header.findIndex((cell) => [labels.value.toLowerCase(), ...VALUE_HEADINGS].includes(cell))
  const hasHeadings = keyHeading !== -1 && valueHeading !== -1
  const keyColumn = hasHeadings ? keyHeading : KEY_COLUMN
  const valueColumn = hasHeadings ? valueHeading : VALUE_COLUMN
  const values: Record<string, ProjectDataValue> = {}
  for (const row of rows.slice(hasHeadings ? 1 : 0)) {
    const key = cellText(row[keyColumn])
    if (key) values[key] = sheetValue(row[valueColumn])
  }
  return values
}
