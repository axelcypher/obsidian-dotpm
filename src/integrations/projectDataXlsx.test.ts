import { describe, expect, it } from 'vitest'
import { read, utils, write } from 'xlsx'
import { readProjectDataWorkbook, writeProjectDataWorkbook, type ProjectDataSheetLabels } from './projectDataXlsx'

const labels: ProjectDataSheetLabels = {
  sheet: 'Projektdaten',
  mailMerge: 'Serienbrief',
  group: 'Gruppe',
  label: 'Bezeichnung',
  key: 'Schlüssel',
  value: 'Wert'
}

const rows = [
  { group: 'Projekt', label: 'Projektordner', key: 'projektordner', value: 'Z:\\Projekte\\HVO' },
  { group: 'Bauherr', label: 'Name', key: 'bauherr-name', value: 'Jonas Vogelsang' },
  { group: 'B-Plan', label: 'GRZ', key: 'bplan-grz', value: 0.4 },
  { group: 'Grundstück', label: 'Flurstück', key: 'grundstueck-flurstueck', value: null }
]

describe('project data workbook', () => {
  it('reads back what it wrote, numbers as numbers and empty cells as empty', () => {
    expect(readProjectDataWorkbook(writeProjectDataWorkbook(rows, labels), labels)).toEqual({
      projektordner: 'Z:\\Projekte\\HVO',
      'bauherr-name': 'Jonas Vogelsang',
      'bplan-grz': 0.4,
      'grundstueck-flurstueck': null
    })
  })

  it('writes a list sheet and a one-row mail merge sheet', () => {
    const book = read(writeProjectDataWorkbook(rows, labels), { type: 'array' })
    expect(book.SheetNames).toEqual(['Projektdaten', 'Serienbrief'])
    const merge = utils.sheet_to_json<unknown[]>(book.Sheets['Serienbrief'], { header: 1, defval: null })
    expect(merge[0]).toEqual(['projektordner', 'bauherr-name', 'bplan-grz', 'grundstueck-flurstueck'])
    expect(merge[1]).toEqual(['Z:\\Projekte\\HVO', 'Jonas Vogelsang', 0.4, null])
  })

  it('finds key and value by their headings in a sheet someone rearranged', () => {
    const book = utils.book_new()
    const sheet = utils.aoa_to_sheet([
      ['Wert', 'Notiz', 'Schlüssel'],
      ['Neu GmbH', 'geändert', 'bauherr-name'],
      [new Date(Date.UTC(2026, 10, 9)), '', 'baugenehmigung'],
      ['ohne Schlüssel', '', '']
    ])
    utils.book_append_sheet(book, sheet, 'Tabelle1')
    const data = new Uint8Array(write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
    expect(readProjectDataWorkbook(data, labels)).toEqual({ 'bauherr-name': 'Neu GmbH', baugenehmigung: '2026-11-09' })
  })
})
