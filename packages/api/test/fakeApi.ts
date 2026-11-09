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
  type ProjectDataValue,
  type TimesheetEntry
} from '@dotpm/core'
import type {
  Change,
  ChangePage,
  DomainApi,
  MeetingResource,
  ProjectDataResource,
  ProjectResource,
  ProjectSummary,
  TaskResource,
  TaskSearch,
  TimesheetResource
} from '../src/contract'
import { ApiRequestError } from '../src/contract'
import {
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
      types: [...this.types]
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
      rows: Object.entries(this.data).map(([key, value]) => ({ group: '', label: key, key, value }))
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
}
