import { TFile } from 'obsidian'
import type { Participant, Project, ProjectDataRow, ProjectLabelConfig, Task } from '@dotpm/core'
import {
  appendParticipant,
  displayName,
  findParentId,
  findTaskById,
  flattenTasks,
  makeTask,
  meetingDate,
  meetingTitle,
  noteBody,
  parseParticipants,
  parseTimesheet,
  resolveProjectLabel,
  summarizeTimesheet,
  today
} from '@dotpm/core'
import {
  ApiRequestError,
  parseMeetingCreate,
  parseParticipant,
  parseProjectDataWrite,
  parseProjectStatus,
  parseProjectTypes,
  parseTimeEntry,
  parseProjectCreate,
  parseTaskCreate,
  parseTaskMove,
  parseTaskWrite,
  taskPatch,
  taskResources,
  toProjectResource,
  toTaskResource,
  type ChangePage,
  type DomainApi,
  type MeetingResource,
  type ProjectDataResource,
  type ProjectLabelPresets,
  type ProjectResource,
  type ProjectSummary,
  type TaskResource,
  type TaskSearch,
  type TaskWrite,
  type TimesheetResource
} from '@dotpm/api'
import type PMPlugin from '#main'
import { findIgnoringCase, newProjectFolder, projectFilePath, TaskFileNameConflictError, type ProjectRef } from '#store'
import { projectLabelIds } from '#ui/projectLabels'
import { ChangeLog } from './ChangeLog'

const SCHEDULE_FIELDS: Array<keyof TaskWrite> = ['start', 'due', 'dependencies', 'status', 'type']

function notFound(what: string, id: string): never {
  throw new ApiRequestError('not_found', `${what} ${id} not found`)
}

/** A ref for a project the index has not read yet, built from the project itself. */
function refOf(project: Project): ProjectRef {
  return {
    path: project.filePath,
    id: project.id,
    title: project.title,
    icon: project.icon,
    color: project.color,
    teamMembers: project.teamMembers,
    tags: [],
    customFields: project.customFields,
    parentPath: project.parentPath,
    archived: project.archived === true,
    status: '',
    types: [],
    ownStatusIds: project.config?.statuses?.map((status) => status.id) ?? null,
    completeStatusIds: project.config?.statuses?.filter((status) => status.complete).map((status) => status.id) ?? null,
    autoArchiveDays: project.config?.autoArchiveDays ?? null
  }
}

/** The contract over this vault: ids resolve through the index, data through the store. */
export class LocalApi implements DomainApi {
  readonly changeLog = new ChangeLog()
  /** Task id to project path for every task served so far. The index learns about a new
   * file only once the metadata cache has parsed it, and a client that just created a
   * task reads it back before then. */
  private readonly known = new Map<string, string>()
  /** Projects created here, by id, until the index has read their notes. */
  private readonly created = new Map<string, ProjectRef>()

  constructor(private readonly plugin: PMPlugin) {}

  /** Feeds the change log from the store and the index. Returns the unsubscribe function. */
  attach(): () => void {
    const offStore = this.plugin.store.onProjectChanged((path) => {
      void (async () => {
        const project = await this.plugin.store.loadProjectByPath(path)
        if (project) this.changeLog.observe(project, true)
      })()
    })
    const offIndex = this.plugin.index.onChange(() => {
      for (const path of this.changeLog.trackedPaths()) {
        if (!this.plugin.index.projectRef(path)) this.changeLog.forget(path)
      }
    })
    return () => {
      offStore()
      offIndex()
    }
  }

  async listProjects(includeArchived = false): Promise<ProjectSummary[]> {
    return this.plugin.index.projectRefs(includeArchived).map((ref) => this.summary(ref))
  }

  async archiveProject(projectId: string, archived: boolean): Promise<ProjectResource> {
    const ref = this.refById(projectId)
    const project = await this.load(ref)
    if (Boolean(project.archived) !== archived) {
      await this.plugin.store.updateProject(project, { archived: archived || undefined })
      this.plugin.refreshViews()
    }
    // The index reads the note back later; the answer reflects the write just made.
    const parent = this.plugin.index.parentOf(ref.path)
    const summary = {
      ...this.summary(ref),
      archived: archived || (parent ? this.plugin.index.isArchived(parent.path) : false)
    }
    return toProjectResource(project, this.plugin.store.configFor(project), summary, this.presets())
  }

  async getProject(projectId: string): Promise<ProjectResource> {
    const ref = this.refById(projectId)
    const project = await this.load(ref)
    return toProjectResource(project, this.plugin.store.configFor(project), this.summary(ref), this.presets())
  }

  async createProject(input: unknown): Promise<ProjectResource> {
    const create = parseProjectCreate(input)
    const parent = create.parentId ? this.refById(create.parentId) : null
    const folder = newProjectFolder(this.plugin.app, this.plugin.settings.projectsFolder, parent?.path)
    if (findIgnoringCase(this.plugin.app, projectFilePath(create.title, folder))) {
      throw new ApiRequestError('invalid', `a project named "${create.title}" already exists in ${folder}`)
    }
    const project = await this.plugin.store.createProject(create.title, folder, {
      description: create.description ?? '',
      teamMembers: create.teamMembers ?? [],
      ...(create.icon === undefined ? {} : { icon: create.icon }),
      ...(create.color === undefined ? {} : { color: create.color }),
      ...(parent ? { parentPath: parent.path } : {})
    })
    const ref = refOf(project)
    this.created.set(project.id, ref)
    this.plugin.refreshViews()
    return toProjectResource(project, this.plugin.store.configFor(project), this.summary(ref), this.presets())
  }

  async listTasks(projectId: string, includeArchived = false): Promise<TaskResource[]> {
    const ref = this.refById(projectId)
    const project = await this.load(ref)
    await Promise.all(flattenTasks(project.tasks).map(({ task }) => this.plugin.store.loadTaskBody(task)))
    return taskResources(project, ref.id, includeArchived)
  }

  async getTask(taskId: string): Promise<TaskResource> {
    const { project, ref, task } = await this.locate(taskId)
    return this.serve(project, ref, task)
  }

  async searchTasks(search: TaskSearch): Promise<TaskResource[]> {
    const query = search.query?.toLowerCase()
    const projectPath = search.projectId ? this.refById(search.projectId).path : undefined
    const assignee = search.assignee ? displayName(search.assignee).toLowerCase() : undefined
    const limit = search.limit ?? 50
    const hits = this.plugin.index.allTaskRefs().filter((ref) => {
      if (ref.archived && !search.includeArchived) return false
      if (projectPath && ref.projectPath !== projectPath) return false
      if (search.status && ref.status !== search.status) return false
      if (query && !ref.title.toLowerCase().includes(query)) return false
      if (assignee && !ref.assignees.some((raw) => displayName(raw).toLowerCase() === assignee)) return false
      return true
    })
    const out: TaskResource[] = []
    for (const hit of hits) {
      if (out.length >= limit) break
      if (!hit.projectPath) continue
      const ref = this.plugin.index.projectRef(hit.projectPath)
      if (!ref) continue
      const project = await this.load(ref)
      const task = findTaskById(project, hit.id)
      if (task) out.push(await this.serve(project, ref, task))
    }
    return out
  }

  async createTask(projectId: string, input: unknown): Promise<TaskResource> {
    const ref = this.refById(projectId)
    const project = await this.load(ref)
    const create = parseTaskCreate(input, this.plugin.store.configFor(project))
    if (create.parentId && !findTaskById(project, create.parentId)) notFound('parent task', create.parentId)
    const task = makeTask(taskPatch(create))
    await this.plugin.store.insertTask(project, task, create.parentId ?? null)
    this.known.set(task.id, project.filePath)
    await this.plugin.store.scheduleAfterChange(project, task.id)
    this.plugin.refreshViews()
    return this.serve(project, ref, this.taskOf(project, task.id))
  }

  async updateTask(taskId: string, input: unknown, expectedUpdatedAt?: string): Promise<TaskResource> {
    const { project, ref, task } = await this.locate(taskId)
    if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== task.updatedAt) {
      throw new ApiRequestError('conflict', `task ${taskId} changed at ${task.updatedAt}`)
    }
    const write = parseTaskWrite(input, this.plugin.store.configFor(project))
    try {
      await this.plugin.store.updateTask(project, taskId, taskPatch(write))
    } catch (err) {
      if (err instanceof TaskFileNameConflictError) {
        throw new ApiRequestError('conflict', `a note named "${err.fileName}" already exists in this project`)
      }
      throw err
    }
    if (SCHEDULE_FIELDS.some((field) => write[field] !== undefined)) {
      await this.plugin.store.scheduleAfterChange(project, taskId)
    }
    this.plugin.refreshViews()
    return this.serve(project, ref, this.taskOf(project, taskId))
  }

  async moveTask(taskId: string, input: unknown): Promise<TaskResource> {
    const move = parseTaskMove(input)
    const located = await this.locate(taskId)
    let { project, ref } = located
    const store = this.plugin.store

    if (move.projectId !== undefined && move.projectId !== ref.id) {
      const targetRef = this.refById(move.projectId)
      const target = await this.load(targetRef)
      const parentId = move.parentId ?? null
      if (parentId && !findTaskById(target, parentId)) notFound('parent task', parentId)
      await store.moveTaskToProject(project, target, taskId, parentId)
      project = target
      ref = targetRef
    } else if (move.parentId !== undefined && move.parentId !== findParentId(project, taskId)) {
      if (move.parentId && !findTaskById(project, move.parentId)) notFound('parent task', move.parentId)
      if (move.parentId && this.inSubtree(located.task, move.parentId)) {
        throw new ApiRequestError('invalid', 'a task cannot be moved under itself')
      }
      await store.moveTask(project, taskId, move.parentId)
    }

    const sibling = move.before ?? move.after
    if (sibling) {
      if (!findTaskById(project, sibling)) notFound('sibling task', sibling)
      if (findParentId(project, sibling) !== findParentId(project, taskId)) {
        throw new ApiRequestError('invalid', 'before and after must name a sibling; pass parentId to re-parent first')
      }
      await store.reorderTask(project, taskId, sibling, move.before ? 'before' : 'after')
    }
    this.plugin.refreshViews()
    return this.serve(project, ref, this.taskOf(project, taskId))
  }

  async archiveTask(taskId: string, archived: boolean): Promise<TaskResource> {
    const { project, ref, task } = await this.locate(taskId)
    if (archived && !task.archived) await this.plugin.store.archiveTask(project, taskId)
    if (!archived && task.archived) await this.plugin.store.unarchiveTask(project, taskId)
    this.plugin.refreshViews()
    return this.serve(project, ref, this.taskOf(project, taskId))
  }

  async deleteTask(taskId: string): Promise<void> {
    const { project } = await this.locate(taskId)
    await this.plugin.store.deleteTask(project, taskId)
    this.plugin.refreshViews()
  }

  async changes(since: number | null): Promise<ChangePage> {
    return this.changeLog.since(since)
  }

  async setProjectStatus(projectId: string, input: unknown): Promise<ProjectResource> {
    const ref = this.refById(projectId)
    const asked = parseProjectStatus(input)
    const status = asked === null ? null : this.preset(this.plugin.settings.projectStatuses, asked, 'project status').id
    await this.plugin.setProjectStatus(ref.path, status)
    const project = await this.load(ref)
    // The index reads the note back later; the answer reflects the write just made.
    const summary = { ...this.summary(ref), status }
    return toProjectResource(project, this.plugin.store.configFor(project), summary, this.presets())
  }

  async setProjectTypes(projectId: string, input: unknown): Promise<ProjectResource> {
    const ref = this.refById(projectId)
    const presets = this.plugin.settings.projectTypes
    const types = [...new Set(parseProjectTypes(input).map((type) => this.preset(presets, type, 'project type').id))]
    await this.plugin.setProjectTypes(ref.path, types)
    const project = await this.load(ref)
    const summary = { ...this.summary(ref), types }
    return toProjectResource(project, this.plugin.store.configFor(project), summary, this.presets())
  }

  async getProjectData(projectId: string): Promise<ProjectDataResource> {
    const ref = this.refById(projectId)
    const note = this.plugin.projectFiles.file(ref.path, 'data')
    const frontmatter = note ? (this.plugin.app.metadataCache.getFileCache(note)?.frontmatter ?? {}) : {}
    return this.dataResource(ref, this.plugin.projectDataSync.rows(frontmatter))
  }

  async updateProjectData(projectId: string, input: unknown): Promise<ProjectDataResource> {
    const ref = this.refById(projectId)
    const values = parseProjectDataWrite(input)
    const note = await this.plugin.projectFiles.ensure(ref.path, 'data')
    let rows: ProjectDataRow[] = []
    await this.plugin.app.fileManager.processFrontMatter(note, (frontmatter: Record<string, unknown>) => {
      Object.assign(frontmatter, values)
      rows = this.plugin.projectDataSync.rows(frontmatter)
    })
    return this.dataResource(ref, rows)
  }

  private dataResource(ref: ProjectRef, rows: ProjectDataRow[]): ProjectDataResource {
    const folder = rows.find((row) => row.key === this.plugin.settings.projectFolderProperty)?.value
    return { projectId: ref.id, folder: typeof folder === 'string' ? folder : '', rows }
  }

  async listParticipants(projectId: string): Promise<Participant[]> {
    const ref = this.refById(projectId)
    return parseParticipants(await this.read(this.plugin.projectFiles.path(ref.path, 'participants')))
  }

  async addParticipant(projectId: string, input: unknown): Promise<Participant[]> {
    const ref = this.refById(projectId)
    const person = parseParticipant(input)
    const file = await this.plugin.projectFiles.ensure(ref.path, 'participants')
    const text = await this.plugin.app.vault.process(file, (current) => appendParticipant(current, person))
    return parseParticipants(text)
  }

  async listMeetings(projectId: string): Promise<MeetingResource[]> {
    const ref = this.refById(projectId)
    const files = this.plugin.projectFiles.meetings(ref.path)
    return Promise.all(files.map(async (file) => this.meeting(file, await this.plugin.app.vault.read(file))))
  }

  async createMeeting(projectId: string, input: unknown): Promise<MeetingResource> {
    const ref = this.refById(projectId)
    const create = parseMeetingCreate(input)
    const file = await this.plugin.projectFiles.createMeeting(ref.path, create.title, {
      date: create.date,
      content: create.content
    })
    return this.meeting(file, create.content ?? '')
  }

  private meeting(file: TFile, text: string): MeetingResource {
    return {
      path: file.path,
      date: meetingDate(file.basename),
      title: meetingTitle(file.basename) || file.basename,
      content: noteBody(text)
    }
  }

  async getTimesheet(projectId: string): Promise<TimesheetResource> {
    const ref = this.refById(projectId)
    return this.timesheet(ref, await this.read(this.plugin.projectFiles.path(ref.path, 'timesheet')))
  }

  async logTime(projectId: string, input: unknown): Promise<TimesheetResource> {
    const ref = this.refById(projectId)
    const entry = parseTimeEntry(input)
    await this.plugin.projectFiles.addTimesheetEntry(ref.path, {
      date: entry.date ?? today().toString(),
      hours: entry.hours,
      person: entry.person ?? this.plugin.settings.timesheetPerson,
      activity: entry.activity ?? ''
    })
    return this.timesheet(ref, await this.read(this.plugin.projectFiles.path(ref.path, 'timesheet')))
  }

  private timesheet(ref: ProjectRef, text: string): TimesheetResource {
    const entries = parseTimesheet(text)
    return { projectId: ref.id, entries, ...summarizeTimesheet(entries) }
  }

  private refById(projectId: string): ProjectRef {
    const indexed = this.plugin.index.projectRefs(true).find((ref) => ref.id === projectId)
    if (indexed) {
      this.created.delete(projectId)
      return indexed
    }
    return this.created.get(projectId) ?? notFound('project', projectId)
  }

  private summary(ref: ProjectRef): ProjectSummary {
    const counts = this.plugin.index.counts(ref)
    return {
      id: ref.id,
      path: ref.path,
      title: ref.title,
      icon: ref.icon,
      color: ref.color,
      parentId: this.parentIdOf(ref),
      archived: this.plugin.index.isArchived(ref.path),
      taskCount: counts.total,
      doneCount: counts.done,
      ...projectLabelIds(this.plugin, ref)
    }
  }

  private presets(): ProjectLabelPresets {
    return { projectStatuses: this.plugin.settings.projectStatuses, projectTypes: this.plugin.settings.projectTypes }
  }

  /** The preset a client named by id or label; anything else is refused with the ids it could have used. */
  private preset(presets: readonly ProjectLabelConfig[], value: string, what: string): ProjectLabelConfig {
    const preset = resolveProjectLabel(presets, value)
    if (preset) return preset
    const known = presets.map((entry) => entry.id).join(', ') || 'none are set up'
    throw new ApiRequestError('invalid', `unknown ${what} "${value}"; use one of: ${known}`)
  }

  private async read(path: string): Promise<string> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path)
    return file instanceof TFile ? this.plugin.app.vault.read(file) : ''
  }

  private createdAt(path: string): ProjectRef | undefined {
    return [...this.created.values()].find((ref) => ref.path === path)
  }

  private parentIdOf(ref: ProjectRef): string | null {
    if (this.plugin.index.projectRef(ref.path)) return this.plugin.index.parentOf(ref.path)?.id ?? null
    if (!ref.parentPath) return null
    return (this.plugin.index.projectRef(ref.parentPath) ?? this.createdAt(ref.parentPath))?.id ?? null
  }

  private async load(ref: ProjectRef): Promise<Project> {
    const project = (await this.plugin.store.loadProjectByPath(ref.path)) ?? notFound('project', ref.id)
    this.changeLog.observe(project, false)
    for (const { task } of flattenTasks(project.tasks)) this.known.set(task.id, project.filePath)
    return project
  }

  private async locate(taskId: string): Promise<{ project: Project; ref: ProjectRef; task: Task }> {
    const path = this.plugin.index.task(taskId)?.projectPath ?? this.known.get(taskId) ?? notFound('task', taskId)
    const ref = this.plugin.index.projectRef(path) ?? this.createdAt(path) ?? notFound('task', taskId)
    const project = await this.load(ref)
    return { project, ref, task: this.taskOf(project, taskId) }
  }

  private taskOf(project: Project, taskId: string): Task {
    return findTaskById(project, taskId) ?? notFound('task', taskId)
  }

  /** The task as a client sees it, with its note body loaded. */
  private async serve(project: Project, ref: ProjectRef, task: Task): Promise<TaskResource> {
    await this.plugin.store.loadTaskBody(task)
    const parentId = findParentId(project, task.id)
    const siblings = parentId ? (findTaskById(project, parentId)?.subtasks ?? []) : project.tasks
    return toTaskResource(task, ref.id, parentId, siblings.indexOf(task))
  }

  private inSubtree(root: Task, id: string): boolean {
    return root.id === id || root.subtasks.some((sub) => this.inSubtree(sub, id))
  }
}
