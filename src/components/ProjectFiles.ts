import { type App, TFile, TFolder, normalizePath } from 'obsidian'
import {
  type PMSettings,
  type TimesheetEntry,
  appendTimesheetEntry,
  defaultProjectFileNames,
  locale,
  meetingFileName,
  participantsTemplate,
  projectDataTemplate,
  sanitizeFileName,
  sortMeetings,
  timesheetTemplate,
  today
} from '@dotpm/core'
import { ensureFolder, projectFolderOf } from '#store'

/** The notes a project keeps once each in its folder. */
export type ProjectFileKind = 'participants' | 'data' | 'timesheet'

/**
 * Finds, creates and writes the notes a project keeps beside its own: one per meeting in
 * a folder, and one each for its participants, its data and its timesheet. They live in
 * the project's folder, and their names come from the settings.
 */
export class ProjectFiles {
  constructor(
    private app: App,
    private getSettings: () => PMSettings
  ) {}

  /** The project's own folder, or for a project note without one, a folder named after it beside it. */
  folder(projectPath: string): string {
    return projectFolderOf(this.app, projectPath) ?? normalizePath(projectPath.replace(/\.md$/, ''))
  }

  private name(kind: ProjectFileKind | 'meetings'): string {
    const settings = this.getSettings()
    const fallback = defaultProjectFileNames()
    const [raw, standard] = {
      meetings: [settings.meetingsFolder, fallback.meetingsFolder],
      participants: [settings.participantsFile, fallback.participantsFile],
      data: [settings.projectDataFile, fallback.projectDataFile],
      timesheet: [settings.timesheetFile, fallback.timesheetFile]
    }[kind]
    return sanitizeFileName(raw?.trim() ?? '') || standard
  }

  path(projectPath: string, kind: ProjectFileKind): string {
    return normalizePath(`${this.folder(projectPath)}/${this.name(kind)}.md`)
  }

  meetingsFolder(projectPath: string): string {
    return normalizePath(`${this.folder(projectPath)}/${this.name('meetings')}`)
  }

  file(projectPath: string, kind: ProjectFileKind): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(this.path(projectPath, kind))
    return file instanceof TFile ? file : null
  }

  /** The meeting notes, newest first. */
  meetings(projectPath: string): TFile[] {
    const folder = this.app.vault.getAbstractFileByPath(this.meetingsFolder(projectPath))
    if (!(folder instanceof TFolder)) return []
    const notes = folder.children.filter((child): child is TFile => child instanceof TFile && child.extension === 'md')
    return sortMeetings(notes.map((file) => ({ file, name: file.basename, created: file.stat.ctime }))).map(
      (entry) => entry.file
    )
  }

  /** Whether a change at `path` touches one of the project's files. */
  concerns(projectPath: string, path: string): boolean {
    const kinds: ProjectFileKind[] = ['participants', 'data', 'timesheet']
    return (
      kinds.some((kind) => this.path(projectPath, kind) === path) ||
      path.startsWith(`${this.meetingsFolder(projectPath)}/`)
    )
  }

  /** The note, created from its template when the project has none yet. */
  async ensure(projectPath: string, kind: ProjectFileKind): Promise<TFile> {
    const existing = this.file(projectPath, kind)
    if (existing) return existing
    await ensureFolder(this.app, this.folder(projectPath))
    const content =
      kind === 'participants'
        ? participantsTemplate()
        : kind === 'data'
          ? projectDataTemplate(this.getSettings().projectDataFields)
          : timesheetTemplate()
    return this.app.vault.create(this.path(projectPath, kind), content)
  }

  /** A new note for today's meeting, numbered when one of the same name exists. */
  async createMeeting(projectPath: string, title: string): Promise<TFile> {
    const folder = this.meetingsFolder(projectPath)
    await ensureFolder(this.app, folder)
    const base = sanitizeFileName(meetingFileName(today().toString(), title))
    let path = normalizePath(`${folder}/${base}.md`)
    for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++) path = normalizePath(`${folder}/${base} ${n}.md`)
    return this.app.vault.create(path, '')
  }

  /** Adds the entry as the last row of the timesheet, creating the timesheet if needed. */
  async addTimesheetEntry(projectPath: string, entry: TimesheetEntry): Promise<void> {
    const file = await this.ensure(projectPath, 'timesheet')
    await this.app.vault.process(file, (text) => appendTimesheetEntry(text, entry, locale()))
  }
}
