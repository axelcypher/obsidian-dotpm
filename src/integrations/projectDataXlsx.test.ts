import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { read, utils, write } from 'xlsx'
import { readProjectDataWorkbook, writeProjectDataWorkbook, type ProjectDataSheetLabels } from './projectDataXlsx'

const labels: ProjectDataSheetLabels = {
  sheet: 'Projektdaten',
  mailMerge: 'Serienbrief',
  key: 'Schlüssel',
  value: 'Wert'
}

const rows = [
  { group: 'Projekt', label: 'Projektordner', key: 'projektordner', value: 'Z:\\Projekte\\BS5' },
  { group: 'Projekt', label: 'Kürzel', key: 'projekt-code', value: 'BS5' },
  { group: 'Bauherr', label: 'Straße', key: 'bauherr-straße', value: 'Buchenstraße 15' },
  { group: 'Baugrundstück', label: 'Flur', key: 'grundstueck-flur', value: 2 },
  { group: 'Baugrundstück', label: 'Grundstücksgröße', key: 'grundstueck-groesse', value: null }
]

const sheetRows = (data: Uint8Array, name: string): unknown[][] =>
  utils.sheet_to_json<unknown[]>(read(data, { type: 'array' }).Sheets[name], { header: 1, defval: null })

describe('project data workbook', () => {
  it('reads back what it wrote, numbers as numbers and empty cells as empty', () => {
    expect(readProjectDataWorkbook(writeProjectDataWorkbook(rows, labels), labels)).toEqual({
      projektordner: 'Z:\\Projekte\\BS5',
      'projekt-code': 'BS5',
      'bauherr-straße': 'Buchenstraße 15',
      'grundstueck-flur': 2,
      'grundstueck-groesse': null
    })
  })

  it('lays out a heading per group, then label, key and value in B to D', () => {
    expect(sheetRows(writeProjectDataWorkbook(rows, labels), 'Projektdaten')).toEqual([
      ['Projekt', null, null, null],
      [null, 'Projektordner', 'projektordner', 'Z:\\Projekte\\BS5'],
      [null, 'Kürzel', 'projekt-code', 'BS5'],
      ['Bauherr', null, null, null],
      [null, 'Straße', 'bauherr-straße', 'Buchenstraße 15'],
      ['Baugrundstück', null, null, null],
      [null, 'Flur', 'grundstueck-flur', 2],
      [null, 'Grundstücksgröße', 'grundstueck-groesse', null]
    ])
  })

  it('formats in Arial with grey group bands, bold labels and column widths', () => {
    const files = unzipSync(writeProjectDataWorkbook(rows, labels))
    const styles = strFromU8(files['xl/styles.xml'])
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml'])
    expect(styles).toContain('<name val="Arial"/>')
    expect(styles).toContain('<font><b/><sz val="14"/>')
    expect(styles).toContain('<font><b/><sz val="10"/>')
    expect(styles).toContain('<fgColor rgb="FFD9D9D9"/>')
    expect(sheet).toMatch(/<row r="1" s="\d+" customFormat="1" ht="21" customHeight="1">/)
    expect(sheet).toContain('<col min="4" max="4" width="80" customWidth="1"/>')
  })

  it('writes a one-row mail merge sheet', () => {
    const merge = sheetRows(writeProjectDataWorkbook(rows, labels), 'Serienbrief')
    expect(merge[0]).toEqual([
      'projektordner',
      'projekt-code',
      'bauherr-straße',
      'grundstueck-flur',
      'grundstueck-groesse'
    ])
    expect(merge[1]).toEqual(['Z:\\Projekte\\BS5', 'BS5', 'Buchenstraße 15', 2, null])
  })

  it('still reads a sheet with headings over its columns, wherever they are', () => {
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

  it('reads a sheet laid out by hand without headings, key and value in C and D', () => {
    const book = utils.book_new()
    const sheet = utils.aoa_to_sheet([
      [null, 'Kürzel', 'projekt-code', 'BS5'],
      ['Bauherr'],
      [null, 'Ort', 'bauherr-ort', 'Welver']
    ])
    utils.book_append_sheet(book, sheet, 'Projektdaten')
    const data = new Uint8Array(write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
    expect(readProjectDataWorkbook(data, labels)).toEqual({ 'projekt-code': 'BS5', 'bauherr-ort': 'Welver' })
  })
})
