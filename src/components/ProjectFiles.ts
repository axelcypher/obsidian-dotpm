import { type App, TFile, TFolder, normalizePath } from 'obsidian'
import {
  type PMSettings,
  type ProjectDataField,
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

  /** The spreadsheet's file name: the data note's name with `.xlsx`. */
  sheetName(): string {
    return `${this.name('data')}.xlsx`
  }

  /** Whether `path` is named like a data note, so most changes are told apart without a lookup. */
  isDataNoteName(path: string): boolean {
    return path === `${this.name('data')}.md` || path.endsWith(`/${this.name('data')}.md`)
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

  /** Which of the project's files `path` is, or null for none of them. */
  kindOf(projectPath: string, path: string): ProjectFileKind | 'meeting' | null {
    const kinds: ProjectFileKind[] = ['participants', 'data', 'timesheet']
    const kind = kinds.find((candidate) => this.path(projectPath, candidate) === path)
    if (kind) return kind
    return path.startsWith(`${this.meetingsFolder(projectPath)}/`) && path.endsWith('.md') ? 'meeting' : null
  }

  /** Whether a change at `path` touches one of the project's files. */
  concerns(projectPath: string, path: string): boolean {
    return this.kindOf(projectPath, path) !== null
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
          ? projectDataTemplate(this.dataTemplateFields())
          : timesheetTemplate()
    return this.app.vault.create(this.path(projectPath, kind), content)
  }

  /** The project folder first, then the data fields: what a new data note starts with, all empty. */
  private dataTemplateFields(): ProjectDataField[] {
    const { projectFolderProperty, projectDataFields } = this.getSettings()
    const folder = projectFolderProperty.trim()
    const rest = projectDataFields.filter((field) => field.key !== folder)
    return folder ? [{ key: folder, label: folder, group: '' }, ...rest] : rest
  }

  /** A new note for today's meeting, numbered when one of the same name exists. */
  async createMeeting(
    projectPath: string,
    title: string,
    opts: { date?: string; content?: string } = {}
  ): Promise<TFile> {
    const folder = this.meetingsFolder(projectPath)
    await ensureFolder(this.app, folder)
    const base = sanitizeFileName(meetingFileName(opts.date ?? today().toString(), title))
    let path = normalizePath(`${folder}/${base}.md`)
    for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++) path = normalizePath(`${folder}/${base} ${n}.md`)
    return this.app.vault.create(path, opts.content ?? '')
  }

  /** Adds the entry as the last row of the timesheet, creating the timesheet if needed. */
  async addTimesheetEntry(projectPath: string, entry: TimesheetEntry): Promise<void> {
    const file = await this.ensure(projectPath, 'timesheet')
    await this.app.vault.process(file, (text) => appendTimesheetEntry(text, entry, locale()))
  }
}
