import { describe, expect, it } from 'vitest'
import {
  changedValues,
  projectDataHash,
  projectDataRows,
  projectFolderFromText,
  rowValues,
  sheetSyncAction,
  type ProjectSheetState
} from './ProjectDataSync'

const fields = [
  { key: 'bauherr-name', label: 'Name', group: 'Bauherr' },
  { key: 'bplan-grz', label: 'GRZ', group: 'B-Plan' }
]
const folder = { key: 'projektordner', label: 'Projektordner', group: 'Projekt' }

describe('projectDataRows', () => {
  it('lists the folder, every field filled or not, then other properties', () => {
    const rows = projectDataRows(
      fields,
      { projektordner: 'Z:\\Projekte\\HVO', 'bauherr-name': ' Jonas ', 'bplan-grz': 0.4, baujahr: 1912, tags: ['x'] },
      folder,
      'Weitere Angaben'
    )
    expect(rows).toEqual([
      { group: 'Projekt', label: 'Projektordner', key: 'projektordner', value: 'Z:\\Projekte\\HVO' },
      { group: 'Bauherr', label: 'Name', key: 'bauherr-name', value: 'Jonas' },
      { group: 'B-Plan', label: 'GRZ', key: 'bplan-grz', value: 0.4 },
      { group: 'Weitere Angaben', label: 'baujahr', key: 'baujahr', value: 1912 }
    ])
  })

  it('keeps empty fields as empty rows, joins lists and works without a note', () => {
    expect(rowValues(projectDataRows(fields, { 'bauherr-name': ['A', 'B'] }, folder, 'x'))).toEqual({
      projektordner: null,
      'bauherr-name': 'A, B',
      'bplan-grz': null
    })
    expect(projectDataRows(fields, null, folder, 'x')).toHaveLength(3)
  })
})

describe('projectDataHash', () => {
  it('treats empty and missing alike and numbers as their digits', () => {
    expect(projectDataHash({ a: 0.4, b: null })).toBe(projectDataHash({ a: '0.4', c: '' }))
    expect(projectDataHash({ a: '1' })).not.toBe(projectDataHash({ a: '2' }))
    expect(projectDataHash({ a: 'x', b: 'y' })).toBe(projectDataHash({ b: 'y', a: 'x' }))
    expect(projectDataHash({})).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('changedValues', () => {
  it('keeps only what the sheet changed', () => {
    expect(changedValues({ a: 0.4, b: 'alt', c: null }, { a: '0.4', b: 'neu', c: null, d: 'x' })).toEqual({
      b: 'neu',
      d: 'x'
    })
  })
})

describe('sheetSyncAction', () => {
  const state: ProjectSheetState = { path: 'Z:\\P\\Projektdaten.xlsx', mtime: 100, hash: 'aaaa' }
  const base = { state, path: state.path, noteHash: 'aaaa', noteMtime: 50, sheetMtime: 100 }

  it('writes a missing sheet', () => {
    expect(sheetSyncAction({ ...base, sheetMtime: null })).toBe('write-sheet')
  })

  it('does nothing when neither side changed', () => {
    expect(sheetSyncAction(base)).toBe('none')
  })

  it('follows the side that changed', () => {
    expect(sheetSyncAction({ ...base, noteHash: 'bbbb', noteMtime: 300 })).toBe('write-sheet')
    expect(sheetSyncAction({ ...base, sheetMtime: 200 })).toBe('read-sheet')
  })

  it('lets the newer file win when both changed', () => {
    expect(sheetSyncAction({ ...base, noteHash: 'bbbb', noteMtime: 300, sheetMtime: 200 })).toBe('write-sheet')
    expect(sheetSyncAction({ ...base, noteHash: 'bbbb', noteMtime: 150, sheetMtime: 200 })).toBe('read-sheet')
  })

  it('compares by age when there was no sync yet or the sheet moved', () => {
    expect(sheetSyncAction({ ...base, state: undefined, noteMtime: 300 })).toBe('write-sheet')
    expect(sheetSyncAction({ ...base, state: undefined, noteMtime: 50 })).toBe('read-sheet')
    expect(sheetSyncAction({ ...base, path: 'Y:\\neu.xlsx', noteMtime: 50 })).toBe('read-sheet')
  })
})

describe('projectFolderFromText', () => {
  it('reads the target of a file link, decoded, with backslashes', () => {
    const text =
      '## Projektdaten\n\n- Projektordner: [Z:\\Projekte\\___Aquise\\HVO Um_Anbau EFH Vogelsang Welver](file:///Z:/Projekte/___Aquise/HVO%20Um_Anbau%20EFH%20Vogelsang%20Welver)\n- LPH aktuell: 4'
    expect(projectFolderFromText(text)).toBe('Z:\\Projekte\\___Aquise\\HVO Um_Anbau EFH Vogelsang Welver')
  })

  it('prefers the link over a label that is no path', () => {
    const text = 'Projektordner: [projekte//K62](file:///Z:\\Projekte\\K62%20Sanierung%20MFH%20Kölner%20Ring)'
    expect(projectFolderFromText(text)).toBe('Z:\\Projekte\\K62 Sanierung MFH Kölner Ring')
  })

  it('takes a plain path and drops a trailing separator', () => {
    expect(projectFolderFromText('**Projektordner:** Z:/Projekte/BS1/')).toBe('Z:\\Projekte\\BS1')
    expect(projectFolderFromText('Project folder: /mnt/projects/bs1')).toBe('/mnt/projects/bs1')
  })

  it('finds nothing without such a line', () => {
    expect(projectFolderFromText('Ordner irgendwo')).toBe('')
  })
})
