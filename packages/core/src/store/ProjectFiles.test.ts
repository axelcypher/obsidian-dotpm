import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '../i18n'
import {
  appendParticipant,
  appendTimesheetEntry,
  defaultProjectDataFields,
  defaultProjectFileNames,
  filterParticipants,
  isValidDataKey,
  meetingDate,
  meetingFileName,
  meetingTitle,
  parseHours,
  parseMarkdownTable,
  parseParticipants,
  parseTimesheet,
  participantsTemplate,
  plainCell,
  projectDataGroups,
  projectDataKeyFor,
  projectDataTemplate,
  removeParticipant,
  removeTimesheetEntry,
  sortMeetings,
  summarizeTimesheet,
  tableCells,
  timesheetTemplate,
  updateParticipant,
  updateTimesheetEntry
} from './ProjectFiles'

afterEach(() => setLocale('en'))

describe('markdown tables', () => {
  it('reads the first table with its position, keeping escaped pipes in their cell', () => {
    const text = 'Intro\n\n| A | B |\n| --- | :-: |\n| 1 | x \\| y |\n| 2 |  |\n\nAfter'
    expect(parseMarkdownTable(text)).toEqual({
      header: ['A', 'B'],
      rows: [
        ['1', 'x | y'],
        ['2', '']
      ],
      start: 2,
      end: 6
    })
  })

  it('finds nothing without a separator line', () => {
    expect(parseMarkdownTable('| A | B |\n| 1 | 2 |')).toBeNull()
    expect(parseMarkdownTable('plain text')).toBeNull()
  })

  it('splits a line without outer pipes too', () => {
    expect(tableCells('a | b')).toEqual(['a', 'b'])
  })

  it('strips links, emphasis and line breaks from a cell', () => {
    expect(plainCell('**Name** <br>_Rolle_')).toBe('Name Rolle')
    expect(plainCell('[mail@soest.de](mailto:mail@soest.de)')).toBe('mail@soest.de')
    expect(plainCell('[[Max Muster|Max]]')).toBe('Max')
  })
})

describe('participants', () => {
  it('matches columns by their headings in any order and skips empty rows', () => {
    const text = [
      '| Rolle | Name | Firma | Telefon | E-Mail |',
      '| --- | --- | --- | --- | --- |',
      '| Bauaufsicht | **M. Rövekamp** | Stadt Soest | 02921 1234 | [m.r@soest.de](mailto:m.r@soest.de) |',
      '|  |  |  |  |  |'
    ].join('\n')
    expect(parseParticipants(text)).toEqual([
      { name: 'M. Rövekamp', role: 'Bauaufsicht', company: 'Stadt Soest', email: 'm.r@soest.de', phone: '02921 1234' }
    ])
  })

  it('filters by every word of the query across all columns', () => {
    const people = [
      { name: 'M. Rövekamp', role: 'Bauaufsicht', company: 'Stadt Soest', email: '', phone: '' },
      { name: 'K. Eickhoff', role: 'Balkonanlage', company: 'Eickhoff GmbH', email: 'info@eick.de', phone: '' }
    ]
    expect(filterParticipants(people, 'soest').map((person) => person.name)).toEqual(['M. Rövekamp'])
    expect(filterParticipants(people, 'gmbh balkon').map((person) => person.name)).toEqual(['K. Eickhoff'])
    expect(filterParticipants(people, '  ')).toHaveLength(2)
    expect(filterParticipants(people, 'statik')).toEqual([])
  })

  it('adds a participant under the right headings, filling a template row', () => {
    setLocale('de')
    const person = { name: 'K. Eickhoff', role: 'Balkon', company: 'Eickhoff GmbH', email: 'info@eick.de', phone: '' }
    const fromTemplate = appendParticipant(participantsTemplate(), person)
    expect(fromTemplate).not.toContain('|  |  |')
    expect(parseParticipants(fromTemplate)).toEqual([person])
    const custom = '| Rolle | Name |\n| --- | --- |\n| Statik | Anna |\n'
    expect(appendParticipant(custom, person)).toBe(
      '| Rolle | Name |\n| --- | --- |\n| Statik | Anna |\n| Balkon | K. Eickhoff |\n'
    )
    expect(parseParticipants(appendParticipant('', person))).toEqual([person])
  })

  it('changes and removes a participant by its place in the list, leaving other cells as written', () => {
    const text = [
      '| Name | Rolle | Notiz | E-Mail |',
      '| --- | --- | --- | --- |',
      '| Anna | Statik | **wichtig** | [a@x.de](mailto:a@x.de) |',
      '|  |  |  |  |',
      '| Bernd | Bauleitung | x \\| y |  |'
    ].join('\n')
    const changed = updateParticipant(text, 1, { role: 'Bauüberwachung', email: 'b@x.de' })
    expect(changed?.split('\n')[4]).toBe('| Bernd | Bauüberwachung | x \\| y | b@x.de |')
    expect(changed?.split('\n')[2]).toBe('| Anna | Statik | **wichtig** | [a@x.de](mailto:a@x.de) |')
    expect(parseParticipants(removeParticipant(text, 0) ?? '').map((person) => person.name)).toEqual(['Bernd'])
    expect(updateParticipant(text, 2, { name: 'X' })).toBeNull()
    expect(removeParticipant('kein Tisch', 0)).toBeNull()
  })

  it('takes the first column as the name when no heading says so', () => {
    expect(parseParticipants('| Wer | Was |\n| --- | --- |\n| Anna | Statik |')[0].name).toBe('Anna')
  })

  it('writes a German template the parser reads back as empty', () => {
    setLocale('de')
    const template = participantsTemplate()
    expect(template.split('\n')[0]).toBe('| Name | Rolle | Firma | E-Mail | Telefon |')
    expect(parseParticipants(template)).toEqual([])
  })
})

describe('timesheet', () => {
  it('reads hours as they are typed', () => {
    expect(parseHours('2,5')).toBe(2.5)
    expect(parseHours('2.25 h')).toBe(2.25)
    expect(parseHours('1:30')).toBe(1.5)
    expect(parseHours('3 Std.')).toBe(3)
    expect(parseHours('viel')).toBeNull()
    expect(parseHours('')).toBeNull()
  })

  it('reads entries by their headings, German dates included, and skips rows without hours', () => {
    const text = [
      '| Datum | Stunden | Bearbeiter | Tätigkeit |',
      '| --- | ---: | --- | --- |',
      '| 2026-11-09 | 2,5 | Tobias | Entwurf |',
      '| 10.11.2026 | 1:15 | Bastian | Abstimmung Statik |',
      '| 2026-11-11 | ? | Tobias | Notiz |'
    ].join('\n')
    expect(parseTimesheet(text)).toEqual([
      { date: '2026-11-09', hours: 2.5, person: 'Tobias', activity: 'Entwurf' },
      { date: '2026-11-10', hours: 1.25, person: 'Bastian', activity: 'Abstimmung Statik' }
    ])
  })

  it('adds an entry as the last row, in the table own column order', () => {
    const text = '# Stunden\n\n| Tätigkeit | Datum | Stunden |\n| --- | --- | --- |\n| Alt | 2026-11-01 | 1 |\n\nEnde\n'
    const next = appendTimesheetEntry(
      text,
      { date: '2026-11-09', hours: 2.5, person: 'Tobias', activity: 'Neu | wichtig' },
      'de'
    )
    expect(next).toBe(
      '# Stunden\n\n| Tätigkeit | Datum | Stunden |\n| --- | --- | --- |\n| Alt | 2026-11-01 | 1 |\n| Neu \\| wichtig | 2026-11-09 | 2,5 |\n\nEnde\n'
    )
    expect(parseTimesheet(next)[1]).toEqual({ date: '2026-11-09', hours: 2.5, person: '', activity: 'Neu | wichtig' })
  })

  it('starts a table in a note without one, and replaces an empty template row', () => {
    setLocale('de')
    const entry = { date: '2026-11-09', hours: 1, person: 'Tobias', activity: 'Aufmaß' }
    expect(appendTimesheetEntry('', entry, 'de')).toBe(
      '| Datum | Stunden | Bearbeiter | Tätigkeit |\n| --- | ---: | --- | --- |\n| 2026-11-09 | 1 | Tobias | Aufmaß |\n'
    )
    expect(appendTimesheetEntry('Notizen', entry, 'de').startsWith('Notizen\n\n| Datum |')).toBe(true)
    const withEmptyRow = `${timesheetTemplate()}|  |  |  |  |\n`
    expect(parseTimesheet(appendTimesheetEntry(withEmptyRow, entry, 'de'))).toEqual([entry])
    expect(appendTimesheetEntry(withEmptyRow, entry, 'de')).not.toContain('|  |  |  |  |')
  })

  it('corrects and removes an entry by its place among the readable ones', () => {
    const text = [
      '| Datum | Stunden | Bearbeiter | Tätigkeit |',
      '| --- | ---: | --- | --- |',
      '| 2026-11-09 | 2,5 | Tobias | Entwurf |',
      '| Notiz | ? |  | keine Stunden |',
      '| 2026-11-10 | 1 | Bastian | Statik |'
    ].join('\n')
    const corrected = updateTimesheetEntry(text, 1, { hours: 1.75, activity: 'Abstimmung Statik' }, 'de')
    expect(parseTimesheet(corrected ?? '')[1]).toEqual({
      date: '2026-11-10',
      hours: 1.75,
      person: 'Bastian',
      activity: 'Abstimmung Statik'
    })
    expect(corrected).toContain('| Notiz | ? |  | keine Stunden |')
    expect(parseTimesheet(removeTimesheetEntry(text, 0) ?? '').map((entry) => entry.person)).toEqual(['Bastian'])
    expect(removeTimesheetEntry(text, 2)).toBeNull()
  })

  it('sums the hours, per person with the most first', () => {
    const summary = summarizeTimesheet([
      { date: '', hours: 1, person: 'Bastian', activity: '' },
      { date: '', hours: 2.5, person: 'Tobias', activity: '' },
      { date: '', hours: 1, person: 'Bastian', activity: '' }
    ])
    expect(summary).toEqual({
      total: 4.5,
      byPerson: [
        { person: 'Tobias', hours: 2.5 },
        { person: 'Bastian', hours: 2 }
      ]
    })
  })
})

describe('meetings', () => {
  it('reads the date and the title from the note name', () => {
    expect(meetingDate('2026-11-09 Abgleich Statik')).toBe('2026-11-09')
    expect(meetingTitle('2026-11-09 Abgleich Statik')).toBe('Abgleich Statik')
    expect(meetingDate('Erstgespräch')).toBe('')
    expect(meetingTitle('Erstgespräch')).toBe('Erstgespräch')
    expect(meetingFileName('2026-11-09', ' Abgleich ')).toBe('2026-11-09 Abgleich')
  })

  it('puts the newest first, undated notes last by creation', () => {
    const notes = [
      { name: '2026-10-01 Alt', created: 5 },
      { name: 'Ohne Datum', created: 9 },
      { name: '2026-11-09 Neu', created: 1 },
      { name: 'Älter ohne Datum', created: 2 }
    ]
    expect(sortMeetings(notes).map((note) => note.name)).toEqual([
      '2026-11-09 Neu',
      '2026-10-01 Alt',
      'Ohne Datum',
      'Älter ohne Datum'
    ])
  })
})

describe('project data', () => {
  const fields = [
    { key: 'bauherr-name', label: 'Name', group: 'Bauherr' },
    { key: 'grundstueck-flur', label: 'Flur', group: 'Grundstück' },
    { key: 'bauherr-telefon', label: 'Telefon', group: 'Bauherr' }
  ]

  it('groups the filled fields in field order, with unknown properties last', () => {
    const groups = projectDataGroups(
      fields,
      { 'bauherr-name': 'Jonas Vogelsang', 'grundstueck-flur': 4, 'bauherr-telefon': '', tags: ['x'], baujahr: 1912 },
      'Weitere Angaben'
    )
    expect(groups).toEqual([
      { name: 'Bauherr', items: [{ key: 'bauherr-name', label: 'Name', value: 'Jonas Vogelsang' }] },
      { name: 'Grundstück', items: [{ key: 'grundstueck-flur', label: 'Flur', value: '4' }] },
      { name: 'Weitere Angaben', items: [{ key: 'baujahr', label: 'baujahr', value: '1912' }] }
    ])
  })

  it('shows nothing for a missing note and joins lists', () => {
    expect(projectDataGroups(fields, null, 'x')).toEqual([])
    expect(projectDataGroups(fields, { 'bauherr-name': ['A', 'B'] }, 'x')[0].items[0].value).toBe('A, B')
  })

  it('writes every field as an empty property', () => {
    expect(projectDataTemplate(fields)).toBe('---\nbauherr-name:\ngrundstueck-flur:\nbauherr-telefon:\n---\n')
    expect(projectDataTemplate([])).toBe('')
  })

  it('builds keys from group and label and checks typed ones', () => {
    expect(projectDataKeyFor('B-Plan', 'Dachneigung', [])).toBe('b-plan-dachneigung')
    expect(projectDataKeyFor('Bauherr', 'Name', ['bauherr-name'])).toBe('bauherr-name-2')
    expect(isValidDataKey('grundstueck-flur')).toBe(true)
    expect(isValidDataKey('flurstück_nr')).toBe(true)
    expect(isValidDataKey('a: b')).toBe(false)
    expect(isValidDataKey('-x')).toBe(false)
  })

  it('starts German vaults with German labels and the same keys', () => {
    setLocale('de')
    const german = defaultProjectDataFields()
    setLocale('en')
    const english = defaultProjectDataFields()
    expect(german.map((field) => field.key)).toEqual(english.map((field) => field.key))
    expect(german.find((field) => field.key === 'grundstueck-flurstueck')).toEqual({
      key: 'grundstueck-flurstueck',
      label: 'Flurstück',
      group: 'Baugrundstück'
    })
    expect(german.every((field) => isValidDataKey(field.key))).toBe(true)
  })

  it('names the project files in the active language', () => {
    setLocale('de')
    expect(defaultProjectFileNames()).toEqual({
      meetingsFolder: 'Abgleiche',
      participantsFile: 'Projektbeteiligte',
      projectDataFile: 'Projektdaten',
      timesheetFile: 'Stundenzettel'
    })
  })
})
