import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { read, utils } from 'xlsx'
import { columnName, writeXlsx } from './xlsxWriter'

const font = { name: 'Arial', size: 12 }

describe('writeXlsx', () => {
  it('names columns past Z', () => {
    expect([0, 25, 26, 51, 52, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA'])
  })

  it('writes text, numbers and booleans as their types, and escapes markup', () => {
    const data = writeXlsx(
      [
        {
          name: 'Daten',
          rows: [{ cells: [{ value: 'A & <B>' }, { value: 1.5 }, { value: true }, null, { value: ' x ' }] }]
        }
      ],
      font
    )
    const sheet = read(data, { type: 'array' }).Sheets['Daten']
    expect(sheet['A1']).toMatchObject({ t: 's', v: 'A & <B>' })
    expect(sheet['B1']).toMatchObject({ t: 'n', v: 1.5 })
    expect(sheet['C1']).toMatchObject({ t: 'b', v: true })
    expect(sheet['D1']).toBeUndefined()
    expect(sheet['E1']).toMatchObject({ v: ' x ' })
  })

  it('drops control characters XML does not allow, keeping line breaks', () => {
    const data = writeXlsx([{ name: 'S', rows: [{ cells: [{ value: `a${String.fromCharCode(7)}b\nc` }] }] }], font)
    expect(read(data, { type: 'array' }).Sheets['S']['A1'].v).toBe('ab\nc')
  })

  it('makes a sheet name Excel accepts', () => {
    const data = writeXlsx([{ name: 'Projekt: 1/2 [alt] mit einem sehr langen Namen', rows: [] }], font)
    expect(read(data, { type: 'array' }).SheetNames).toEqual(['Projekt- 1-2 -alt- mit einem se'])
  })

  it('registers each style once and refers to it by index', () => {
    const bold = { bold: true }
    const files = unzipSync(
      writeXlsx(
        [
          {
            name: 'S',
            rows: [
              {
                cells: [
                  { value: 'a', style: bold },
                  { value: 'b', style: { bold: true } }
                ]
              }
            ]
          }
        ],
        font
      )
    )
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml'])
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr">')
    expect(sheet).toContain('<c r="B1" s="1" t="inlineStr">')
    expect(strFromU8(files['xl/styles.xml'])).toContain('<cellXfs count="2">')
  })

  it('keeps every part Excel needs', () => {
    const files = unzipSync(
      writeXlsx(
        [
          { name: 'A', rows: [] },
          { name: 'B', rows: [] }
        ],
        font
      )
    )
    expect(Object.keys(files).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml'
    ])
  })

  it('writes an empty sheet that reads as empty', () => {
    const book = read(writeXlsx([{ name: 'A', rows: [] }], font), { type: 'array' })
    expect(utils.sheet_to_json(book.Sheets['A'])).toEqual([])
  })
})
