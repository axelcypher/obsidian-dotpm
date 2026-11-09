import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '../i18n'
import { DEFAULT_PROJECT_STATUSES, DEFAULT_PROJECT_TYPES } from '../types'
import {
  defaultProjectTypes,
  isValidProjectLabelProperty,
  projectLabelIdFor,
  projectLabelRank,
  projectLabelValues,
  projectStatusProperty,
  projectTypeProperty,
  resolveProjectLabel,
  toggleProjectLabel
} from './ProjectLabels'

const statuses = DEFAULT_PROJECT_STATUSES
const types = DEFAULT_PROJECT_TYPES

describe('resolveProjectLabel', () => {
  it('finds a preset by its id', () => {
    expect(resolveProjectLabel(statuses, 'on-hold')?.label).toBe('On hold')
  })

  it('accepts a hand-typed id or label in any case', () => {
    expect(resolveProjectLabel(statuses, 'ACTIVE')?.id).toBe('active')
    expect(resolveProjectLabel(statuses, ' on hold ')?.id).toBe('on-hold')
  })

  it('finds nothing for an empty or unknown value', () => {
    expect(resolveProjectLabel(statuses, '')).toBeUndefined()
    expect(resolveProjectLabel(statuses, 'someday')).toBeUndefined()
  })
})

describe('projectLabelRank', () => {
  it('ranks by place in the preset list, everything else after it', () => {
    expect(projectLabelRank(statuses, 'active')).toBe(0)
    expect(projectLabelRank(statuses, 'done')).toBe(3)
    expect(projectLabelRank(statuses, '')).toBe(statuses.length)
    expect(projectLabelRank(statuses, 'someday')).toBe(statuses.length)
  })
})

describe('label properties', () => {
  it('use the configured key, trimmed', () => {
    expect(projectStatusProperty({ projectStatusProperty: ' phase ' })).toBe('phase')
    expect(projectTypeProperty({ projectTypeProperty: ' kind ' })).toBe('kind')
  })

  it('fall back to the default for an empty key or one a project save owns', () => {
    expect(projectStatusProperty({ projectStatusProperty: '' })).toBe('status')
    expect(projectStatusProperty({ projectStatusProperty: 'title' })).toBe('status')
    expect(projectTypeProperty({ projectTypeProperty: 'color' })).toBe('projectType')
    expect(isValidProjectLabelProperty('color')).toBe(false)
    expect(isValidProjectLabelProperty('stage')).toBe(true)
  })
})

describe('projectLabelValues', () => {
  it('reads a list, a single value and a comma-separated line', () => {
    expect(projectLabelValues(['conversion', ' listed-building '])).toEqual(['conversion', 'listed-building'])
    expect(projectLabelValues('conversion')).toEqual(['conversion'])
    expect(projectLabelValues('Conversion, Listed building')).toEqual(['Conversion', 'Listed building'])
  })

  it('keeps numbers and drops empty or other values', () => {
    expect(projectLabelValues([2024, '', null, { a: 1 }])).toEqual(['2024'])
    expect(projectLabelValues(undefined)).toEqual([])
    expect(projectLabelValues(null)).toEqual([])
  })
})

describe('toggleProjectLabel', () => {
  it('adds a type the project does not have yet', () => {
    expect(toggleProjectLabel(types, ['conversion'], 'listed-building')).toEqual(['conversion', 'listed-building'])
  })

  it('takes a type out however it was written, keeping the rest', () => {
    expect(toggleProjectLabel(types, ['Conversion', 'someday', 'extension'], 'conversion')).toEqual([
      'someday',
      'extension'
    ])
  })
})

describe('projectLabelIdFor', () => {
  it('turns a label into a readable id', () => {
    expect(projectLabelIdFor('Auf Eis gelegt', [])).toBe('auf-eis-gelegt')
    expect(projectLabelIdFor('  Später / Größer! ', [])).toBe('spater-grosser')
  })

  it('numbers an id another preset already has', () => {
    expect(projectLabelIdFor('Done', ['done', 'done-2'])).toBe('done-3')
  })

  it('gives up on a label without letters or digits', () => {
    expect(projectLabelIdFor('🚀', [])).toBe('')
  })
})

describe('defaultProjectTypes', () => {
  afterEach(() => setLocale('en'))

  it('names the types and builds their ids in the active language', () => {
    setLocale('de')
    expect(defaultProjectTypes().map((type) => [type.id, type.label])).toEqual([
      ['neubau', 'Neubau'],
      ['umbau', 'Umbau'],
      ['anbau', 'Anbau'],
      ['bauen-im-bestand', 'Bauen im Bestand'],
      ['denkmal', 'Denkmal']
    ])
  })
})
