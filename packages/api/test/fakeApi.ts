import {
  DEFAULT_PRIORITIES,
  DEFAULT_PROJECT_STATUSES,
  DEFAULT_PROJECT_TYPES,
  DEFAULT_STATUSES,
  makeProject,
  makeTask,
  resolveProjectLabel,
  summarizeTimesheet,
  type Participant,
  type Project,
  type ProjectDataField,
  type ProjectDataValue,
  type ProjectLabelConfig,
  type TimesheetEntry
} from '@dotpm/core'
import type {
  Change,
  ChangePage,
  DomainApi,
  MeetingResource,
  PresetsResource,
  ProjectDataResource,
  ProjectDataSetUp,
  SheetSyncResult,
  ProjectResource,
  ProjectSummary,
  TaskResource,
  TaskSearch,
  TimesheetResource
} from '../src/contract'
import { ApiRequestError } from '../src/contract'
import {
  parseMeetingRef,
  parseMeetingUpdate,
  parseParticipantRef,
  parseParticipantUpdate,
  parsePresets,
  parseProjectTags,
  parseSheetSync,
  parseTimeEntryRef,
  parseTimeEntryUpdate,
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
  toTaskResource
} from '../src/resources'

const CONFIG = {
  statuses: DEFAULT_STATUSES,
  priorities: DEFAULT_PRIORITIES,
  priorityIcons: 'chevrons' as const,
  customFields: [],
  defaultView: 'table' as const,
  autoSchedule: false,
  pullForwardOnEarlyFinish: false,
  autoArchiveDays: 0,
  showSubtreeConnections: true,
  lineBorders: 'none' as const
}

/** An in-memory host for testing the transports: one project, tasks as a flat list. */
export class FakeApi implements DomainApi {
  project: Project = makeProject('Demo', 'Projects/Demo/Demo.md')
  calls: string[] = []
  projectCount = 1
  changeLog: Change[] = []
  status: string | null = null
  types: string[] = []
  tags: string[] = []
  projectStatuses: ProjectLabelConfig[] = DEFAULT_PROJECT_STATUSES
  projectTypes: ProjectLabelConfig[] = DEFAULT_PROJECT_TYPES
  projectDataFields: ProjectDataField[] = []
  data: Record<string, ProjectDataValue> = {}
  participants: Participant[] = []
  meetings: MeetingResource[] = []
  timesheet: TimesheetEntry[] = []

  constructor() {
    this.project.id = 'p1'
    this.project.tasks = [
      makeTask({ id: 't1', title: 'First' }),
      makeTask({ id: 't2', title: 'Second', status: 'done' })
    ]
  }

  private summary(): ProjectSummary {
    return {
      id: this.project.id,
      path: this.project.filePath,
      title: this.project.title,
      icon: this.project.icon,
      color: this.project.color,
      parentId: null,
      archived: this.project.archived === true,
      taskCount: this.project.tasks.length,
      doneCount: this.project.tasks.filter((t) => t.status === 'done').length,
      status: this.status,
      types: [...this.types],
      tags: [...this.tags]
    }
  }

  private find(taskId: string): TaskResource {
    const index = this.project.tasks.findIndex((t) => t.id === taskId)
    if (index < 0) throw new ApiRequestError('not_found', `task ${taskId} not found`)
    return toTaskResource(this.project.tasks[index], this.project.id, null, index)
  }

  private checkProject(projectId: string): void {
    if (projectId !== this.project.id) throw new ApiRequestError('not_found', `project ${projectId} not found`)
  }

  async listProjects(includeArchived = false): Promise<ProjectSummary[]> {
    this.calls.push(`listProjects${includeArchived ? ' archived' : ''}`)
    return includeArchived || !this.project.archived ? [this.summary()] : []
  }

  async archiveProject(projectId: string, archived: boolean): Promise<ProjectResource> {
    this.calls.push(`archiveProject ${projectId} ${archived}`)
    this.checkProject(projectId)
    this.project.archived = archived
    return this.resource()
  }

  async getProject(projectId: string): Promise<ProjectResource> {
    this.calls.push(`getProject ${projectId}`)
    this.checkProject(projectId)
    return this.resource()
  }

  private resource(): ProjectResource {
    return {
      ...this.summary(),
      description: this.project.description,
      teamMembers: [],
      customFields: [],
      statuses: CONFIG.statuses,
      priorities: CONFIG.priorities,
      projectStatuses: DEFAULT_PROJECT_STATUSES,
      projectTypes: DEFAULT_PROJECT_TYPES,
      createdAt: this.project.createdAt,
      updatedAt: this.project.updatedAt
    }
  }

  async createProject(input: unknown): Promise<ProjectResource> {
    const create = parseProjectCreate(input)
    this.calls.push(`createProject ${create.title}`)
    const project = makeProject(create.title, `Projects/${create.title}/${create.title}.md`)
    project.id = `p${++this.projectCount}`
    Object.assign(project, {
      description: create.description ?? '',
      icon: create.icon ?? project.icon,
      color: create.color ?? project.color,
      teamMembers: create.teamMembers ?? []
    })
    return {
      id: project.id,
      path: project.filePath,
      title: project.title,
      icon: project.icon,
      color: project.color,
      parentId: create.parentId ?? null,
      archived: false,
      taskCount: 0,
      doneCount: 0,
      status: null,
      types: [],
      tags: [],
      description: project.description,
      teamMembers: project.teamMembers,
      customFields: [],
      statuses: CONFIG.statuses,
      priorities: CONFIG.priorities,
      projectStatuses: DEFAULT_PROJECT_STATUSES,
      projectTypes: DEFAULT_PROJECT_TYPES,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt
    }
  }

  async listTasks(projectId: string, includeArchived = false): Promise<TaskResource[]> {
    this.calls.push(`listTasks ${projectId}`)
    this.checkProject(projectId)
    return taskResources(this.project, this.project.id, includeArchived)
  }

  async getTask(taskId: string): Promise<TaskResource> {
    this.calls.push(`getTask ${taskId}`)
    return this.find(taskId)
  }

  async searchTasks(search: TaskSearch): Promise<TaskResource[]> {
    this.calls.push(`searchTasks ${JSON.stringify(search)}`)
    const q = search.query?.toLowerCase()
    return taskResources(this.project, this.project.id, true).filter((t) => !q || t.title.toLowerCase().includes(q))
  }

  async createTask(projectId: string, input: unknown): Promise<TaskResource> {
    this.calls.push(`createTask ${projectId}`)
    this.checkProject(projectId)
    const create = parseTaskCreate(input, CONFIG)
    const task = makeTask({ id: `t${this.project.tasks.length + 1}`, ...taskPatch(create) })
    this.project.tasks.push(task)
    return this.find(task.id)
  }

  async updateTask(taskId: string, input: unknown, expectedUpdatedAt?: string): Promise<TaskResource> {
    this.calls.push(`updateTask ${taskId}${expectedUpdatedAt ? ` if ${expectedUpdatedAt}` : ''}`)
    const current = this.find(taskId)
    if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== current.updatedAt) {
      throw new ApiRequestError('conflict', 'task changed')
    }
    const write = parseTaskWrite(input, CONFIG)
    Object.assign(this.project.tasks[current.position], taskPatch(write), { updatedAt: '2030-01-01T00:00:00.000Z' })
    return this.find(taskId)
  }

  async moveTask(taskId: string, input: unknown): Promise<TaskResource> {
    this.calls.push(`moveTask ${taskId} ${JSON.stringify(parseTaskMove(input))}`)
    return this.find(taskId)
  }

  async archiveTask(taskId: string, archived: boolean): Promise<TaskResource> {
    this.calls.push(`archiveTask ${taskId} ${archived}`)
    this.project.tasks[this.find(taskId).position].archived = archived
    return this.find(taskId)
  }

  async deleteTask(taskId: string): Promise<void> {
    this.calls.push(`deleteTask ${taskId}`)
    this.project.tasks.splice(this.find(taskId).position, 1)
  }

  async changes(since: number | null): Promise<ChangePage> {
    this.calls.push(`changes ${since}`)
    return {
      cursor: this.changeLog.length,
      changes: this.changeLog.filter((c) => since !== null && c.seq > since),
      reset: false
    }
  }

  async setProjectStatus(projectId: string, input: unknown): Promise<ProjectResource> {
    this.checkProject(projectId)
    const status = parseProjectStatus(input)
    this.calls.push(`setProjectStatus ${projectId} ${status}`)
    const preset = status === null ? null : resolveProjectLabel(DEFAULT_PROJECT_STATUSES, status)
    if (status !== null && !preset) throw new ApiRequestError('invalid', `unknown project status ${status}`)
    this.status = preset?.id ?? null
    return this.resource()
  }

  async setProjectTypes(projectId: string, input: unknown): Promise<ProjectResource> {
    this.checkProject(projectId)
    const types = parseProjectTypes(input)
    this.calls.push(`setProjectTypes ${projectId} ${types.join(',')}`)
    this.types = types.map((type) => resolveProjectLabel(DEFAULT_PROJECT_TYPES, type)?.id ?? type)
    return this.resource()
  }

  private dataResource(): ProjectDataResource {
    return {
      projectId: this.project.id,
      folder: '',
      rows: Object.entries(this.data).map(([key, value]) => ({ group: '', label: key, key, value })),
      sheet: null
    }
  }

  async getProjectData(projectId: string): Promise<ProjectDataResource> {
    this.calls.push(`getProjectData ${projectId}`)
    this.checkProject(projectId)
    return this.dataResource()
  }

  async updateProjectData(projectId: string, input: unknown): Promise<ProjectDataResource> {
    this.checkProject(projectId)
    const values = parseProjectDataWrite(input)
    this.calls.push(`updateProjectData ${projectId} ${Object.keys(values).join(',')}`)
    Object.assign(this.data, values)
    return this.dataResource()
  }

  async listParticipants(projectId: string): Promise<Participant[]> {
    this.calls.push(`listParticipants ${projectId}`)
    this.checkProject(projectId)
    return [...this.participants]
  }

  async addParticipant(projectId: string, input: unknown): Promise<Participant[]> {
    this.checkProject(projectId)
    const person = parseParticipant(input)
    this.calls.push(`addParticipant ${projectId} ${person.name}`)
    this.participants.push(person)
    return [...this.participants]
  }

  async listMeetings(projectId: string): Promise<MeetingResource[]> {
    this.calls.push(`listMeetings ${projectId}`)
    this.checkProject(projectId)
    return [...this.meetings]
  }

  async createMeeting(projectId: string, input: unknown): Promise<MeetingResource> {
    this.checkProject(projectId)
    const create = parseMeetingCreate(input)
    this.calls.push(`createMeeting ${projectId} ${create.title}`)
    const date = create.date ?? '2030-01-01'
    const meeting = {
      path: `Projects/Demo/Meetings/${date} ${create.title}.md`,
      date,
      title: create.title,
      content: create.content ?? ''
    }
    this.meetings.unshift(meeting)
    return meeting
  }

  private timesheetResource(): TimesheetResource {
    return { projectId: this.project.id, entries: [...this.timesheet], ...summarizeTimesheet(this.timesheet) }
  }

  async getTimesheet(projectId: string): Promise<TimesheetResource> {
    this.calls.push(`getTimesheet ${projectId}`)
    this.checkProject(projectId)
    return this.timesheetResource()
  }

  async logTime(projectId: string, input: unknown): Promise<TimesheetResource> {
    this.checkProject(projectId)
    const entry = parseTimeEntry(input)
    this.calls.push(`logTime ${projectId} ${entry.hours}`)
    this.timesheet.push({
      date: entry.date ?? '2030-01-01',
      hours: entry.hours,
      person: entry.person ?? '',
      activity: entry.activity ?? ''
    })
    return this.timesheetResource()
  }

  async setProjectTags(projectId: string, input: unknown): Promise<ProjectResource> {
    this.checkProject(projectId)
    this.tags = parseProjectTags(input)
    this.calls.push(`setProjectTags ${projectId} ${this.tags.join(',')}`)
    return this.resource()
  }

  private meetingAt(path: string): number {
    const index = this.meetings.findIndex((meeting) => meeting.path === path)
    if (index < 0) throw new ApiRequestError('not_found', `meeting ${path} not found`)
    return index
  }

  async updateMeeting(projectId: string, input: unknown): Promise<MeetingResource> {
    this.checkProject(projectId)
    const update = parseMeetingUpdate(input)
    this.calls.push(`updateMeeting ${projectId} ${update.path}`)
    const meeting = this.meetings[this.meetingAt(update.path)]
    Object.assign(meeting, {
      ...(update.title === undefined ? {} : { title: update.title }),
      ...(update.date === undefined ? {} : { date: update.date }),
      ...(update.content === undefined ? {} : { content: update.content })
    })
    return meeting
  }

  async deleteMeeting(projectId: string, input: unknown): Promise<void> {
    this.checkProject(projectId)
    const path = parseMeetingRef(input)
    this.calls.push(`deleteMeeting ${projectId} ${path}`)
    this.meetings.splice(this.meetingAt(path), 1)
  }

  private participantAt(index: number, expectedName?: string): Participant {
    const person = this.participants[index]
    if (!person) throw new ApiRequestError('not_found', `no participant at ${index}`)
    if (expectedName !== undefined && person.name !== expectedName) {
      throw new ApiRequestError('conflict', `participant ${index} is ${person.name}`)
    }
    return person
  }

  async updateParticipant(projectId: string, input: unknown): Promise<Participant[]> {
    this.checkProject(projectId)
    const { index, expectedName, patch } = parseParticipantUpdate(input)
    this.calls.push(`updateParticipant ${projectId} ${index}`)
    Object.assign(this.participantAt(index, expectedName), patch)
    return [...this.participants]
  }

  async removeParticipant(projectId: string, input: unknown): Promise<Participant[]> {
    this.checkProject(projectId)
    const { index, expectedName } = parseParticipantRef(input)
    this.calls.push(`removeParticipant ${projectId} ${index}`)
    this.participantAt(index, expectedName)
    this.participants.splice(index, 1)
    return [...this.participants]
  }

  private entryAt(index: number, expectedDate?: string, expectedHours?: number): TimesheetEntry {
    const entry = this.timesheet[index]
    if (!entry) throw new ApiRequestError('not_found', `no timesheet entry at ${index}`)
    if (
      (expectedDate !== undefined && entry.date !== expectedDate) ||
      (expectedHours !== undefined && entry.hours !== expectedHours)
    ) {
      throw new ApiRequestError('conflict', `timesheet entry ${index} changed`)
    }
    return entry
  }

  async updateTimeEntry(projectId: string, input: unknown): Promise<TimesheetResource> {
    this.checkProject(projectId)
    const { index, expectedDate, expectedHours, patch } = parseTimeEntryUpdate(input)
    this.calls.push(`updateTimeEntry ${projectId} ${index}`)
    Object.assign(this.entryAt(index, expectedDate, expectedHours), patch)
    return this.timesheetResource()
  }

  async removeTimeEntry(projectId: string, input: unknown): Promise<TimesheetResource> {
    this.checkProject(projectId)
    const { index, expectedDate, expectedHours } = parseTimeEntryRef(input)
    this.calls.push(`removeTimeEntry ${projectId} ${index}`)
    this.entryAt(index, expectedDate, expectedHours)
    this.timesheet.splice(index, 1)
    return this.timesheetResource()
  }

  async getPresets(): Promise<PresetsResource> {
    this.calls.push('getPresets')
    return {
      projectStatuses: this.projectStatuses,
      projectTypes: this.projectTypes,
      projectDataFields: this.projectDataFields
    }
  }

  async updatePresets(input: unknown): Promise<PresetsResource> {
    const presets = parsePresets(input)
    this.calls.push(`updatePresets ${Object.keys(presets).join(',')}`)
    Object.assign(this, presets)
    return this.getPresets()
  }

  async syncProjectSheets(input: unknown): Promise<SheetSyncResult> {
    const projectId = parseSheetSync(input)
    this.calls.push(`syncProjectSheets ${projectId ?? 'all'}`)
    if (projectId) this.checkProject(projectId)
    return { checked: 1, problems: [] }
  }

  async setUpProjectData(): Promise<ProjectDataSetUp> {
    this.calls.push('setUpProjectData')
    return { created: 1, folders: 0 }
  }
}
