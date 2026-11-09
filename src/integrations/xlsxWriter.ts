import { strToU8, zipSync } from 'fflate'

/*
 * A small SpreadsheetML writer: values, fonts, fills, row heights and column widths, which
 * is all a formatted data sheet needs and more than SheetJS's free edition writes.
 */

export interface XlsxStyle {
  bold?: boolean
  /** Points. */
  size?: number
  /** Background as `RRGGBB`. */
  fill?: string
}

export interface XlsxCell {
  value: string | number | boolean | null
  style?: XlsxStyle
}

export interface XlsxRow {
  /** One entry per column from A; null leaves the cell out. */
  cells: (XlsxCell | null)[]
  /** Applied to the whole row, cells left out included, such as a band of colour. */
  style?: XlsxStyle
  /** Points. */
  height?: number
}

export interface XlsxSheet {
  name: string
  /** Widths in characters, from column A. */
  columns?: number[]
  rows: XlsxRow[]
}

export interface XlsxFont {
  name: string
  size: number
}

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

/** Control characters other than tab and line breaks aren't allowed in XML at all. */
function withoutControlCharacters(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.charCodeAt(0)
    if (code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) out += char
  }
  return out
}

function escapeXml(text: string): string {
  return withoutControlCharacters(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** A, B, …, Z, AA, AB, … for the 0-based column. */
export function columnName(index: number): string {
  let name = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  return name
}

/** Excel refuses sheet names over 31 characters or with any of `[]:*?/\`. */
function sheetName(name: string): string {
  return name.replace(/[[\]:*?/\\]/g, '-').slice(0, 31) || 'Sheet'
}

/** Fonts, fills and cell formats, each registered once and referred to by index. */
class StyleSheet {
  private fonts: string[]
  private fills = [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>'
  ]
  private formats = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>']
  private formatIds = new Map<string, number>()

  constructor(private base: XlsxFont) {
    this.fonts = [this.font({})]
  }

  private font(style: XlsxStyle): string {
    const bold = style.bold ? '<b/>' : ''
    return `<font>${bold}<sz val="${style.size ?? this.base.size}"/><name val="${escapeXml(this.base.name)}"/><family val="2"/></font>`
  }

  private indexOf(list: string[], entry: string): number {
    const at = list.indexOf(entry)
    if (at !== -1) return at
    list.push(entry)
    return list.length - 1
  }

  /** The cell format index for the style; 0, the default, for none. */
  format(style: XlsxStyle | undefined): number {
    if (!style || (!style.bold && !style.size && !style.fill)) return 0
    const key = JSON.stringify([style.bold ?? false, style.size ?? 0, style.fill ?? ''])
    const known = this.formatIds.get(key)
    if (known !== undefined) return known
    const fontId = this.indexOf(this.fonts, this.font(style))
    const fillId = style.fill
      ? this.indexOf(
          this.fills,
          `<fill><patternFill patternType="solid"><fgColor rgb="FF${style.fill.toUpperCase()}"/><bgColor indexed="64"/></patternFill></fill>`
        )
      : 0
    const applyFill = fillId ? ' applyFill="1"' : ''
    this.formats.push(
      `<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="0" xfId="0" applyFont="1"${applyFill}/>`
    )
    const id = this.formats.length - 1
    this.formatIds.set(key, id)
    return id
  }

  xml(): string {
    return (
      `${XML_HEAD}<styleSheet xmlns="${MAIN}">` +
      `<fonts count="${this.fonts.length}">${this.fonts.join('')}</fonts>` +
      `<fills count="${this.fills.length}">${this.fills.join('')}</fills>` +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${this.formats.length}">${this.formats.join('')}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>'
    )
  }
}

function cellXml(ref: string, cell: XlsxCell, styleId: number): string {
  const style = styleId ? ` s="${styleId}"` : ''
  const { value } = cell
  if (value === null || value === '') return `<c r="${ref}"${style}/>`
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${style}><v>${value}</v></c>`
  if (typeof value === 'boolean') return `<c r="${ref}"${style} t="b"><v>${value ? 1 : 0}</v></c>`
  const text = String(value)
  const space = text !== text.trim() || text.includes('\n') ? ' xml:space="preserve"' : ''
  return `<c r="${ref}"${style} t="inlineStr"><is><t${space}>${escapeXml(text)}</t></is></c>`
}

function sheetXml(sheet: XlsxSheet, styles: StyleSheet): string {
  const columns = sheet.columns?.length
    ? `<cols>${sheet.columns
        .map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`)
        .join('')}</cols>`
    : ''
  const rows = sheet.rows
    .map((row, r) => {
      const number = r + 1
      const rowStyle = styles.format(row.style)
      const attrs =
        (rowStyle ? ` s="${rowStyle}" customFormat="1"` : '') +
        (row.height ? ` ht="${row.height}" customHeight="1"` : '')
      const cells = row.cells
        .map((cell, c) => {
          if (!cell) return ''
          // A cell without a style of its own takes the row's, as Excel does for empty ones.
          const styleId = cell.style ? styles.format(cell.style) : rowStyle
          return cellXml(`${columnName(c)}${number}`, cell, styleId)
        })
        .join('')
      return `<row r="${number}"${attrs}>${cells}</row>`
    })
    .join('')
  return `${XML_HEAD}<worksheet xmlns="${MAIN}" xmlns:r="${REL}">${columns}<sheetData>${rows}</sheetData></worksheet>`
}

/** The sheets as an .xlsx file, every cell in `font` unless its style says otherwise. */
export function writeXlsx(sheets: readonly XlsxSheet[], font: XlsxFont): Uint8Array {
  const styles = new StyleSheet(font)
  const sheetFiles = sheets.map((sheet) => sheetXml(sheet, styles))
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        sheets
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
          )
          .join('') +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>'
    ),
    '_rels/.rels': strToU8(
      `${XML_HEAD}<Relationships xmlns="${PACKAGE_REL}">` +
        `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/>` +
        '</Relationships>'
    ),
    'xl/workbook.xml': strToU8(
      `${XML_HEAD}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets>` +
        sheets
          .map(
            (sheet, i) => `<sheet name="${escapeXml(sheetName(sheet.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
          )
          .join('') +
        '</sheets></workbook>'
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `${XML_HEAD}<Relationships xmlns="${PACKAGE_REL}">` +
        sheets
          .map(
            (_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
          )
          .join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/>` +
        '</Relationships>'
    ),
    'xl/styles.xml': strToU8(styles.xml())
  }
  sheetFiles.forEach((xml, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(xml)
  })
  return zipSync(files, { level: 6 })
}
