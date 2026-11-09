import { t, type MessageKey } from '../i18n'
import type { PMSettings, ProjectDataField } from '../types'
import { projectLabelIdFor } from './ProjectLabels'

/*
 * The notes a project keeps beside its own: one per meeting, its participants, its data
 * and its timesheet. Everything here works on their text, so it runs without Obsidian.
 */

// ---------------------------------------------------------------------------------------
// Markdown tables

export interface MarkdownTable {
  header: string[]
  rows: string[][]
  /** The line of the header and the line after the last row, so a row can be added. */
  start: number
  end: number
}

const SEPARATOR = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/

function isTableLine(line: string): boolean {
  return line.trim().startsWith('|')
}

/** The cells of one table line. An escaped `\|` stays inside its cell. */
export function tableCells(line: string): string[] {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1)
  const cells: string[] = []
  let cell = ''
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '\\' && text[i + 1] === '|') {
      cell += '|'
      i++
    } else if (char === '|') {
      cells.push(cell.trim())
      cell = ''
    } else cell += char
  }
  cells.push(cell.trim())
  return cells
}

/** The first table in the text, or null without one. */
export function parseMarkdownTable(markdown: string): MarkdownTable | null {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!isTableLine(lines[i]) || !SEPARATOR.test(lines[i + 1].trim())) continue
    const rows: string[][] = []
    let end = i + 2
    while (end < lines.length && isTableLine(lines[end])) rows.push(tableCells(lines[end++]))
    return { header: tableCells(lines[i]), rows, start: i, end }
  }
  return null
}

function escapeCell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim()
}

function tableLine(cells: string[]): string {
  return `| ${cells.map(escapeCell).join(' | ')} |`
}

/** The text of a cell without the Markdown a reader doesn't need in a list: links, emphasis, line breaks. */
export function plainCell(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const normalizeHeader = (text: string): string => plainCell(text).toLowerCase()

/** For each wanted column, the index of the first header that starts with one of its names. */
function columnIndexes<K extends string>(header: string[], names: Record<K, string[]>): Record<K, number> {
  const normalized = header.map(normalizeHeader)
  const result = {} as Record<K, number>
  for (const key of Object.keys(names) as K[]) {
    result[key] = normalized.findIndex((cell) => names[key].some((name) => cell === name || cell.startsWith(name)))
  }
  return result
}

const cellAt = (row: string[], index: number): string => (index >= 0 ? (row[index] ?? '') : '')

// ---------------------------------------------------------------------------------------
// Participants

export interface Participant {
  name: string
  role: string
  company: string
  email: string
  phone: string
}

const PARTICIPANT_COLUMNS: Record<keyof Participant, string[]> = {
  name: ['name', 'kontakt', 'contact', 'person'],
  role: ['rolle', 'role', 'funktion', 'aufgabe'],
  company: ['firma', 'institution', 'company', 'büro', 'organisation', 'organization'],
  email: ['e-mail', 'email', 'mail'],
  phone: ['telefon', 'phone', 'tel', 'mobil', 'handy']
}

/** The participants in the note's first table, matched to its columns by their headings. */
export function parseParticipants(markdown: string): Participant[] {
  const table = parseMarkdownTable(markdown)
  if (!table) return []
  const columns = columnIndexes(table.header, PARTICIPANT_COLUMNS)
  if (columns.name < 0) columns.name = 0
  return table.rows
    .map((row) => ({
      name: plainCell(cellAt(row, columns.name)),
      role: plainCell(cellAt(row, columns.role)),
      company: plainCell(cellAt(row, columns.company)),
      email: plainCell(cellAt(row, columns.email)),
      phone: plainCell(cellAt(row, columns.phone))
    }))
    .filter((participant) => Object.values(participant).some(Boolean))
}

/** The participants whose name, role, company, email or phone holds every word of the query. */
export function filterParticipants(participants: readonly Participant[], query: string): Participant[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return [...participants]
  return participants.filter((participant) => {
    const text = Object.values(participant).join(' ').toLowerCase()
    return words.every((word) => text.includes(word))
  })
}

/** A new participants note: the table's headings and one empty row to fill in. */
export function participantsTemplate(): string {
  const header = [
    t('participants.name'),
    t('participants.role'),
    t('participants.company'),
    t('participants.email'),
    t('participants.phone')
  ]
  return `${tableLine(header)}\n${tableLine(header.map(() => '---'))}\n${tableLine(header.map(() => ''))}\n`
}

// ---------------------------------------------------------------------------------------
// Timesheet

export interface TimesheetEntry {
  /** `YYYY-MM-DD`, or empty when the row's date can't be read. */
  date: string
  hours: number
  person: string
  activity: string
}

const TIMESHEET_COLUMNS: Record<keyof TimesheetEntry, string[]> = {
  date: ['datum', 'date', 'tag'],
  hours: ['stunden', 'hours', 'dauer', 'duration', 'std', 'zeit', 'h'],
  person: ['bearbeiter', 'person', 'wer', 'mitarbeiter', 'who'],
  activity: ['tätigkeit', 'taetigkeit', 'activity', 'beschreibung', 'leistung', 'description', 'was', 'notiz']
}

/** Hours as typed: `2,5`, `2.5`, `2:30` or `2,5 h`. Null for anything else. */
export function parseHours(text: string): number | null {
  const value = text.trim().replace(/\s*(h|std\.?|stunden|hours?)$/i, '')
  const clock = /^(\d+):([0-5]\d)$/.exec(value)
  if (clock) return Number(clock[1]) + Number(clock[2]) / 60
  if (!/^\d+([.,]\d+)?$/.test(value)) return null
  return Number(value.replace(',', '.'))
}

/** Hours with at most two decimals, in the language's own way of writing them. */
export function formatHours(hours: number, localeTag: string): string {
  return hours.toLocaleString(localeTag, { maximumFractionDigits: 2 })
}

/** A date as a timesheet holds it: `YYYY-MM-DD`, or `DD.MM.YYYY` as it is often typed. */
function isoDate(text: string): string {
  const value = plainCell(text)
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const german = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value)
  return german ? `${german[3]}-${german[2].padStart(2, '0')}-${german[1].padStart(2, '0')}` : ''
}

/** The entries of the timesheet's first table. Rows without readable hours are left out. */
export function parseTimesheet(markdown: string): TimesheetEntry[] {
  const table = parseMarkdownTable(markdown)
  if (!table) return []
  const columns = columnIndexes(table.header, TIMESHEET_COLUMNS)
  // A table whose headings name none of the columns is read in the order the template writes them.
  if (Object.values(columns).every((index) => index < 0)) {
    Object.assign(columns, { date: 0, hours: 1, person: 2, activity: 3 })
  }
  return table.rows.flatMap((row) => {
    const hours = parseHours(plainCell(cellAt(row, columns.hours)))
    if (hours === null) return []
    return [
      {
        date: isoDate(cellAt(row, columns.date)),
        hours,
        person: plainCell(cellAt(row, columns.person)),
        activity: plainCell(cellAt(row, columns.activity))
      }
    ]
  })
}

function timesheetHeader(): string[] {
  return [t('timesheet.date'), t('timesheet.hours'), t('timesheet.person'), t('timesheet.activity')]
}

/** A new timesheet note: the table's headings, ready for the first entry. */
export function timesheetTemplate(): string {
  const header = timesheetHeader()
  return `${tableLine(header)}\n${tableLine(['---', '---:', '---', '---'])}\n`
}

/**
 * The timesheet with the entry as a new last row of its table, in the table's own column
 * order. A note without a table gets one at its end.
 */
export function appendTimesheetEntry(markdown: string, entry: TimesheetEntry, localeTag: string): string {
  const values: Record<keyof TimesheetEntry, string> = {
    date: entry.date,
    hours: formatHours(entry.hours, localeTag),
    person: entry.person,
    activity: entry.activity
  }
  const text = markdown.replace(/\r\n/g, '\n')
  const table = parseMarkdownTable(text)
  if (!table) {
    const row = tableLine([values.date, values.hours, values.person, values.activity])
    const lead = text.trim() ? `${text.replace(/\n*$/, '')}\n\n` : ''
    return `${lead}${timesheetTemplate()}${row}\n`
  }
  const columns = columnIndexes(table.header, TIMESHEET_COLUMNS)
  const known = Object.values(columns).some((index) => index >= 0)
  const order: (keyof TimesheetEntry)[] = ['date', 'hours', 'person', 'activity']
  const cells = table.header.map((_, index) => {
    const key = known ? order.find((column) => columns[column] === index) : order[index]
    return key ? values[key] : ''
  })
  const lines = text.split('\n')
  // A template's empty row would otherwise sit above every entry.
  const last = lines[table.end - 1]
  const lastIsEmpty = table.rows.length > 0 && tableCells(last).every((cell) => !cell)
  lines.splice(lastIsEmpty ? table.end - 1 : table.end, lastIsEmpty ? 1 : 0, tableLine(cells))
  return lines.join('\n')
}

export interface TimesheetSummary {
  total: number
  /** Hours per person, most first; entries without a person count under `''`. */
  byPerson: { person: string; hours: number }[]
}

export function summarizeTimesheet(entries: readonly TimesheetEntry[]): TimesheetSummary {
  const byPerson = new Map<string, number>()
  let total = 0
  for (const entry of entries) {
    total += entry.hours
    byPerson.set(entry.person, (byPerson.get(entry.person) ?? 0) + entry.hours)
  }
  return {
    total,
    byPerson: [...byPerson].map(([person, hours]) => ({ person, hours })).sort((a, b) => b.hours - a.hours)
  }
}

// ---------------------------------------------------------------------------------------
// Meetings

const MEETING_DATE = /^(\d{4}-\d{2}-\d{2})\b\s*/

/** The `YYYY-MM-DD` a meeting note's name starts with, or empty. */
export function meetingDate(name: string): string {
  return MEETING_DATE.exec(name)?.[1] ?? ''
}

/** What follows the date in a meeting note's name; the whole name when it has no date. */
export function meetingTitle(name: string): string {
  return name.replace(MEETING_DATE, '').trim()
}

/** The name of a new meeting note: the day, then the title. */
export function meetingFileName(date: string, title: string): string {
  return `${date} ${title.trim()}`.trim()
}

/** Newest first: by the date in the name, then by when the note was created. */
export function sortMeetings<T extends { name: string; created: number }>(meetings: readonly T[]): T[] {
  return [...meetings].sort((a, b) => meetingDate(b.name).localeCompare(meetingDate(a.name)) || b.created - a.created)
}

// ---------------------------------------------------------------------------------------
// Project data

/** Properties every note may carry that say nothing about the project. */
const NOTE_PROPERTIES = new Set(['tags', 'aliases', 'cssclasses', 'position'])

export function isNoteProperty(key: string): boolean {
  return NOTE_PROPERTIES.has(key)
}

export interface ProjectDataGroup {
  name: string
  items: { key: string; label: string; value: string }[]
}

function dataValue(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  if (Array.isArray(raw)) return raw.map(dataValue).filter(Boolean).join(', ')
  if (typeof raw === 'object') return JSON.stringify(raw)
  if (typeof raw === 'string') return raw.trim()
  return typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : ''
}

/**
 * The data note's filled-in properties under their groups, in the order of the fields.
 * Properties no field names come last under `otherGroup`, so data another program wrote
 * still shows.
 */
export function projectDataGroups(
  fields: readonly ProjectDataField[],
  frontmatter: Record<string, unknown> | null | undefined,
  otherGroup: string,
  /** Properties the caller shows on its own, such as the project folder. */
  hidden: readonly string[] = []
): ProjectDataGroup[] {
  const data = frontmatter ?? {}
  const groups: ProjectDataGroup[] = []
  const groupOf = (name: string): ProjectDataGroup => {
    let group = groups.find((entry) => entry.name === name)
    if (!group) {
      group = { name, items: [] }
      groups.push(group)
    }
    return group
  }
  const known = new Set([...hidden, ...fields.map((field) => field.key)])
  for (const field of fields) {
    if (hidden.includes(field.key)) continue
    const value = dataValue(data[field.key])
    if (value) groupOf(field.group).items.push({ key: field.key, label: field.label, value })
  }
  for (const [key, raw] of Object.entries(data)) {
    if (known.has(key) || NOTE_PROPERTIES.has(key)) continue
    const value = dataValue(raw)
    if (value) groupOf(otherGroup).items.push({ key, label: key, value })
  }
  return groups.filter((group) => group.items.length)
}

/** A new data note: every field as an empty property, ready to fill in from the properties panel. */
export function projectDataTemplate(fields: readonly ProjectDataField[]): string {
  if (!fields.length) return ''
  return `---\n${fields.map((field) => `${field.key}:`).join('\n')}\n---\n`
}

/** Whether a property name can be written as is into a data note. */
export function isValidDataKey(key: string): boolean {
  return /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(key)
}

/** The key a field gets from its group and label, unique among `taken`. */
export function projectDataKeyFor(group: string, label: string, taken: readonly string[]): string {
  const base = [projectLabelIdFor(group, []), projectLabelIdFor(label, [])].filter(Boolean).join('-') || 'feld'
  return projectLabelIdFor(base, taken) || base
}

const DEFAULT_DATA_FIELDS: { key: string; group: MessageKey; label: MessageKey }[] = [
  { key: 'bauherr-name', group: 'projectData.group.client', label: 'projectData.field.clientName' },
  { key: 'bauherr-anschrift', group: 'projectData.group.client', label: 'projectData.field.clientAddress' },
  { key: 'bauherr-telefon', group: 'projectData.group.client', label: 'projectData.field.clientPhone' },
  { key: 'bauherr-email', group: 'projectData.group.client', label: 'projectData.field.clientEmail' },
  { key: 'grundstueck-adresse', group: 'projectData.group.plot', label: 'projectData.field.plotAddress' },
  { key: 'grundstueck-gemarkung', group: 'projectData.group.plot', label: 'projectData.field.plotDistrict' },
  { key: 'grundstueck-flur', group: 'projectData.group.plot', label: 'projectData.field.plotFlur' },
  { key: 'grundstueck-flurstueck', group: 'projectData.group.plot', label: 'projectData.field.plotParcel' },
  { key: 'grundstueck-groesse', group: 'projectData.group.plot', label: 'projectData.field.plotArea' },
  { key: 'bplan-name', group: 'projectData.group.zoning', label: 'projectData.field.zoningName' },
  { key: 'bplan-nutzung', group: 'projectData.group.zoning', label: 'projectData.field.zoningUse' },
  { key: 'bplan-grz', group: 'projectData.group.zoning', label: 'projectData.field.zoningGrz' },
  { key: 'bplan-gfz', group: 'projectData.group.zoning', label: 'projectData.field.zoningGfz' },
  { key: 'bplan-geschosse', group: 'projectData.group.zoning', label: 'projectData.field.zoningStoreys' },
  { key: 'bplan-bauweise', group: 'projectData.group.zoning', label: 'projectData.field.zoningBuildingMode' },
  { key: 'bplan-dach', group: 'projectData.group.zoning', label: 'projectData.field.zoningRoof' },
  { key: 'bplan-festsetzungen', group: 'projectData.group.zoning', label: 'projectData.field.zoningProvisions' }
]

/**
 * The fields a vault starts with: client, plot and zoning plan, labelled in the active
 * language. The keys stay the same in every language, since programs read them.
 */
export function defaultProjectDataFields(): ProjectDataField[] {
  return DEFAULT_DATA_FIELDS.map((field) => ({ key: field.key, group: t(field.group), label: t(field.label) }))
}

/** The names a vault's project files start with, in the active language. */
export function defaultProjectFileNames(): Pick<
  PMSettings,
  'meetingsFolder' | 'participantsFile' | 'projectDataFile' | 'timesheetFile'
> {
  return {
    meetingsFolder: t('projectFiles.meetingsFolder'),
    participantsFile: t('projectFiles.participantsFile'),
    projectDataFile: t('projectFiles.projectDataFile'),
    timesheetFile: t('projectFiles.timesheetFile')
  }
}
