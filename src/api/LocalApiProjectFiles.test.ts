import { TFile, type App } from 'obsidian'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, projectLabelValues, toggleProjectLabel, type PMSettings } from '@dotpm/core'
import { ApiRequestError } from '@dotpm/api'
import { makeFakeApp } from '#test/fakeVault'
import type PMPlugin from '#main'
import { ProjectStore } from '#store/ProjectStore'
import { VaultIndex } from '#store/VaultIndex'
import { ProjectDataSync } from '../components/ProjectDataSync'
import { ProjectFiles } from '../components/ProjectFiles'
import { LocalApi } from './LocalApi'

const SETTINGS: PMSettings = {
  ...DEFAULT_SETTINGS,
  autoSchedule: false,
  projectDataFields: [
    { key: 'bauherr-name', label: 'Name', group: 'Bauherr' },
    { key: 'grundstueck-flur', label: 'Flur', group: 'Grundstück' }
  ],
  timesheetPerson: 'Tobias'
}

type FakeApp = ReturnType<typeof makeFakeApp>['app']

function fileAt(app: App, path: string): TFile {
  const file = app.vault.getAbstractFileByPath(path)
  if (!(file instanceof TFile)) throw new Error(`no note at ${path}`)
  return file
}

/** The plugin as the API sees it, with the label writes done the way the plugin does them. */
function newApi(): { api: LocalApi; app: FakeApp; store: ProjectStore; index: VaultIndex } {
  const { app } = makeFakeApp({ liveMetadataCache: true })
  const settings = structuredClone(SETTINGS)
  const typed = app as unknown as App
  const index = new VaultIndex(typed, () => settings)
  const store = new ProjectStore(typed, () => settings, index)
  const file = (path: string): TFile => fileAt(typed, path)
  const plugin = {
    app: typed,
    index,
    store,
    settings,
    refreshViews: () => undefined,
    saveSettings: async () => undefined,
    setProjectStatus: async (path: string, status: string | null) => {
      await typed.fileManager.processFrontMatter(file(path), (fm: Record<string, unknown>) => {
        if (status) fm['status'] = status
        else Reflect.deleteProperty(fm, 'status')
      })
    },
    setProjectTypes: async (path: string, ids: string[]) => {
      await typed.fileManager.processFrontMatter(file(path), (fm: Record<string, unknown>) => {
        fm['projectType'] = ids
      })
    }
  } as unknown as PMPlugin
  plugin.projectFiles = new ProjectFiles(typed, () => settings)
  plugin.projectDataSync = new ProjectDataSync(plugin)
  return { api: new LocalApi(plugin), app, store, index }
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(ApiRequestError)
  await expect(promise).rejects.toMatchObject({ code })
}

describe('LocalApi project labels and files', () => {
  let api: LocalApi
  let app: FakeApp
  let index: VaultIndex
  let projectId: string

  beforeEach(async () => {
    let store: ProjectStore
    ;({ api, app, store, index } = newApi())
    const project = await store.createProject('Vogelsang', 'Projects')
    index.build()
    projectId = project.id
  })

  const read = (path: string): Promise<string> =>
    (app as unknown as App).vault.read(fileAt(app as unknown as App, path))

  it('sets status and types by id or label and lists them on the project', async () => {
    expect((await api.setProjectStatus(projectId, { status: 'On hold' })).status).toBe('on-hold')
    expect(await read('Projects/Vogelsang/Vogelsang.md')).toMatch(/status: "?on-hold"?/)
    const typed = await api.setProjectTypes(projectId, { types: ['Conversion', 'conversion', 'listed-building'] })
    expect(typed.types).toEqual(['conversion', 'listed-building'])
    expect(typed.projectTypes.map((type) => type.id)).toContain('new-build')
    index.build()
    expect((await api.listProjects())[0]).toMatchObject({ status: 'on-hold', types: ['conversion', 'listed-building'] })
    await rejectsWith(api.setProjectStatus(projectId, { status: 'someday' }), 'invalid')
    expect((await api.setProjectStatus(projectId, { status: null })).status).toBeNull()
  })

  it('writes project data into the data note and reads it back with the folder first', async () => {
    const written = await api.updateProjectData(projectId, {
      values: { 'bauherr-name': 'Jonas Vogelsang', projektordner: 'Z:\\Projekte\\HVO', baujahr: 1912 }
    })
    expect(written.folder).toBe('Z:\\Projekte\\HVO')
    expect(written.rows.map((row) => [row.key, row.value])).toEqual([
      ['projektordner', 'Z:\\Projekte\\HVO'],
      ['bauherr-name', 'Jonas Vogelsang'],
      ['grundstueck-flur', null],
      ['baujahr', 1912]
    ])
    expect(await read('Projects/Vogelsang/Project data.md')).toMatch(/bauherr-name: "?Jonas Vogelsang"?/)
    expect((await api.getProjectData(projectId)).rows[1]).toMatchObject({
      key: 'bauherr-name',
      value: 'Jonas Vogelsang'
    })
    const emptied = await api.updateProjectData(projectId, { values: { 'bauherr-name': null } })
    expect(emptied.rows[1]).toMatchObject({ key: 'bauherr-name', value: null })
  })

  it('adds participants to the table and lists them', async () => {
    expect(await api.listParticipants(projectId)).toEqual([])
    await api.addParticipant(projectId, { name: 'M. Rövekamp', role: 'Bauaufsicht', company: 'Stadt Soest' })
    const all = await api.addParticipant(projectId, { name: 'K. Eickhoff', email: 'info@eick.de' })
    expect(all.map((person) => person.name)).toEqual(['M. Rövekamp', 'K. Eickhoff'])
    expect(await api.listParticipants(projectId)).toEqual(all)
  })

  it('creates meeting notes with their minutes and lists them newest first', async () => {
    await api.createMeeting(projectId, { title: 'Abgleich', date: '2026-10-21', content: '- Statik offen' })
    const latest = await api.createMeeting(projectId, {
      title: 'Abgleich Bauherr',
      date: '2026-11-09',
      content: '- Dach'
    })
    expect(latest).toMatchObject({
      path: 'Projects/Vogelsang/Meetings/2026-11-09 Abgleich Bauherr.md',
      date: '2026-11-09',
      title: 'Abgleich Bauherr',
      content: '- Dach'
    })
    expect((await api.listMeetings(projectId)).map((meeting) => meeting.title)).toEqual([
      'Abgleich Bauherr',
      'Abgleich'
    ])
  })

  it('books time into the timesheet, for the default person unless named', async () => {
    await api.logTime(projectId, { hours: 2.5, date: '2026-11-09', activity: 'Entwurf' })
    const sheet = await api.logTime(projectId, { hours: 1, date: '2026-11-10', person: 'Bastian' })
    expect(sheet.total).toBe(3.5)
    expect(sheet.entries).toEqual([
      { date: '2026-11-09', hours: 2.5, person: 'Tobias', activity: 'Entwurf' },
      { date: '2026-11-10', hours: 1, person: 'Bastian', activity: '' }
    ])
    expect((await api.getTimesheet(projectId)).byPerson).toEqual([
      { person: 'Tobias', hours: 2.5 },
      { person: 'Bastian', hours: 1 }
    ])
    await rejectsWith(api.logTime('missing', { hours: 1 }), 'not_found')
  })

  it('sets the project note tags and lists them', async () => {
    expect((await api.setProjectTags(projectId, { tags: ['#client', 'web'] })).tags).toEqual(['client', 'web'])
    index.build()
    expect((await api.listProjects())[0].tags).toEqual(['client', 'web'])
    expect((await api.setProjectTags(projectId, { tags: [] })).tags).toEqual([])
  })

  it('changes, renames and deletes a meeting note', async () => {
    const meeting = await api.createMeeting(projectId, { title: 'Abgleich', date: '2026-11-09', content: '- alt' })
    const renamed = await api.updateMeeting(projectId, {
      path: meeting.path,
      title: 'Abgleich Statik',
      content: '- neu'
    })
    expect(renamed).toMatchObject({
      path: 'Projects/Vogelsang/Meetings/2026-11-09 Abgleich Statik.md',
      title: 'Abgleich Statik',
      content: '- neu'
    })
    await rejectsWith(api.updateMeeting(projectId, { path: meeting.path, content: 'x' }), 'not_found')
    await api.deleteMeeting(projectId, { path: renamed.path })
    expect(await api.listMeetings(projectId)).toEqual([])
  })

  it('edits and removes participants by index, guarded by the name', async () => {
    await api.addParticipant(projectId, { name: 'Anna', role: 'Statik' })
    await api.addParticipant(projectId, { name: 'Bernd' })
    const edited = await api.updateParticipant(projectId, { index: 1, expectedName: 'bernd', email: 'b@x.de' })
    expect(edited[1]).toMatchObject({ name: 'Bernd', email: 'b@x.de' })
    await rejectsWith(api.removeParticipant(projectId, { index: 0, expectedName: 'Bernd' }), 'conflict')
    await rejectsWith(api.removeParticipant(projectId, { index: 5 }), 'not_found')
    expect((await api.removeParticipant(projectId, { index: 0, expectedName: 'Anna' })).map((p) => p.name)).toEqual([
      'Bernd'
    ])
  })

  it('corrects and deletes timesheet entries, guarded by date and hours', async () => {
    await api.logTime(projectId, { hours: 2, date: '2026-11-09' })
    await api.logTime(projectId, { hours: 1, date: '2026-11-10' })
    await rejectsWith(api.updateTimeEntry(projectId, { index: 1, expectedHours: 2, hours: 3 }), 'conflict')
    const corrected = await api.updateTimeEntry(projectId, {
      index: 1,
      expectedDate: '2026-11-10',
      hours: 1.5,
      activity: 'Statik'
    })
    expect(corrected.entries[1]).toEqual({ date: '2026-11-10', hours: 1.5, person: 'Tobias', activity: 'Statik' })
    expect((await api.removeTimeEntry(projectId, { index: 0 })).total).toBe(1.5)
    await rejectsWith(api.removeTimeEntry('missing', { index: 0 }), 'not_found')
  })

  it('reads and replaces the presets, deriving ids and keys from labels', async () => {
    const presets = await api.updatePresets({
      projectTypes: [{ label: 'Bauen im Bestand' }],
      projectDataFields: [{ group: 'B-Plan', label: 'Dachneigung' }]
    })
    expect(presets.projectTypes).toEqual([
      { id: 'bauen-im-bestand', label: 'Bauen im Bestand', color: '#8a94a0', icon: '' }
    ])
    expect(presets.projectDataFields).toEqual([{ key: 'b-plan-dachneigung', label: 'Dachneigung', group: 'B-Plan' }])
    expect((await api.getPresets()).projectStatuses.map((status) => status.id)).toContain('active')
  })

  it('records project file changes for pollers', async () => {
    const plugin = (api as unknown as { plugin: PMPlugin }).plugin
    expect(plugin).toBeDefined()
    const detach = api.attach()
    const { cursor } = await api.changes(null)
    await api.logTime(projectId, { hours: 1 })
    await api.addParticipant(projectId, { name: 'Anna' })
    const page = await api.changes(cursor)
    expect(page.changes.map((change) => [change.kind, change.op, change.projectId])).toEqual(
      expect.arrayContaining([
        ['timesheet', 'upsert', projectId],
        ['participants', 'upsert', projectId]
      ])
    )
    detach()
  })

  it('keeps label helpers in line with what the plugin writes', () => {
    expect(toggleProjectLabel(SETTINGS.projectTypes, projectLabelValues('conversion'), 'extension')).toEqual([
      'conversion',
      'extension'
    ])
  })
})
