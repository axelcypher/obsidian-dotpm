import { describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT_STATUSES } from '../types'
import {
  isValidProjectStatusProperty,
  projectStatusIdFor,
  projectStatusProperty,
  projectStatusRank,
  resolveProjectStatus
} from './ProjectStatus'

const statuses = DEFAULT_PROJECT_STATUSES

describe('resolveProjectStatus', () => {
  it('finds a preset by its id', () => {
    expect(resolveProjectStatus(statuses, 'on-hold')?.label).toBe('On hold')
  })

  it('accepts a hand-typed id or label in any case', () => {
    expect(resolveProjectStatus(statuses, 'ACTIVE')?.id).toBe('active')
    expect(resolveProjectStatus(statuses, ' on hold ')?.id).toBe('on-hold')
  })

  it('finds nothing for an empty or unknown value', () => {
    expect(resolveProjectStatus(statuses, '')).toBeUndefined()
    expect(resolveProjectStatus(statuses, 'someday')).toBeUndefined()
  })
})

describe('projectStatusRank', () => {
  it('ranks by place in the preset list, everything else after it', () => {
    expect(projectStatusRank(statuses, 'active')).toBe(0)
    expect(projectStatusRank(statuses, 'done')).toBe(3)
    expect(projectStatusRank(statuses, '')).toBe(statuses.length)
    expect(projectStatusRank(statuses, 'someday')).toBe(statuses.length)
  })
})

describe('projectStatusProperty', () => {
  it('uses the configured key, trimmed', () => {
    expect(projectStatusProperty({ projectStatusProperty: ' phase ' })).toBe('phase')
  })

  it('falls back to the default for an empty key or one a project save owns', () => {
    expect(projectStatusProperty({ projectStatusProperty: '' })).toBe('status')
    expect(projectStatusProperty({ projectStatusProperty: 'title' })).toBe('status')
    expect(isValidProjectStatusProperty('color')).toBe(false)
    expect(isValidProjectStatusProperty('stage')).toBe(true)
  })
})

describe('projectStatusIdFor', () => {
  it('turns a label into a readable id', () => {
    expect(projectStatusIdFor('Auf Eis gelegt', [])).toBe('auf-eis-gelegt')
    expect(projectStatusIdFor('  Später / Größer! ', [])).toBe('spater-grosser')
  })

  it('numbers an id another preset already has', () => {
    expect(projectStatusIdFor('Done', ['done', 'done-2'])).toBe('done-3')
  })

  it('gives up on a label without letters or digits', () => {
    expect(projectStatusIdFor('🚀', [])).toBe('')
  })
})
