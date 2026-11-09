import type {
  Participant,
  Project,
  ProjectDataField,
  ProjectDataValue,
  ProjectLabelConfig,
  ResolvedProjectConfig,
  Task,
  TimesheetEntry
} from '@dotpm/core'
import {
  DEFAULT_PALETTE_COLOR,
  HEX_COLOR,
  isValidDataKey,
  makeTask,
  parsePlainDate,
  projectDataKeyFor,
  projectLabelIdFor
} from '@dotpm/core'
import * as v from 'valibot'
import {
  ApiRequestError,
  type PresetsResource,
  type MeetingCreate,
  type TimeEntryCreate,
  type ProjectCreate,
  type ProjectResource,
  type ProjectSummary,
  type TaskCreate,
  type TaskMove,
  type TaskResource,
  type TaskSearch,
  type TaskWrite
} from './contract'

const TASK_TYPES = ['task', 'milestone', 'subtask'] as const
const RECURRENCE_INTERVALS = ['daily', 'weekly', 'monthly', 'yearly'] as const

export function invalid(message: string): never {
  throw new ApiRequestError('invalid', message)
}

/**
 * Every schema below carries its own message, so a client reads the same words whether it
 * came in over HTTP, where this runs, or over MCP, where the transport validates first.
 */
function parse<S extends v.GenericSchema>(schema: S, input: unknown): v.InferOutput<S> {
  const result = v.safeParse(schema, input)
  if (!result.success) invalid(result.issues[0].message)
  return result.output
}

/** An object reports both a wrong type and a key it is missing, so it names the key itself. */
function missingKey(wrongType: string, prefix = ''): (issue: v.ObjectIssue) => string {
  return (issue) => {
    const key = issue.path?.[0]?.key
    return typeof key === 'string' ? `${prefix}${key} is required` : wrongType
  }
}

export function toTaskResource(task: Task, projectId: string, parentId: string | null, position: number): TaskResource {
  return {
    id: task.id,
    projectId,
    parentId,
    position,
    path: task.filePath ?? '',
    title: task.title,
    description: task.description,
    type: task.type,
    status: task.status,
    priority: task.priority,
    start: task.start,
    due: task.due,
    completed: task.completed,
    progress: task.progress,
    assignees: [...task.assignees],
    tags: [...task.tags],
    dependencies: [...task.dependencies],
    recurrence: task.recurrence ? { ...task.recurrence } : null,
    timeEstimate: task.timeEstimate ?? null,
    timeLogs: (task.timeLogs ?? []).map((log) => ({ ...log })),
    customFields: { ...task.customFields },
    archived: task.archived === true,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  }
}

/** Every task of a project in tree order, positions counted among siblings. */
export function taskResources(project: Project, projectId: string, includeArchived: boolean): TaskResource[] {
  const out: TaskResource[] = []
  const walk = (tasks: Task[], parentId: string | null): void => {
    tasks.forEach((task, position) => {
      if (task.archived && !includeArchived) return
      out.push(toTaskResource(task, projectId, parentId, position))
      walk(task.subtasks, task.id)
    })
  }
  walk(project.tasks, null)
  return out
}

/** The presets a project's status and types are picked from, which only the host knows. */
export interface ProjectLabelPresets {
  projectStatuses: readonly ProjectLabelConfig[]
  projectTypes: readonly ProjectLabelConfig[]
}

export function toProjectResource(
  project: Project,
  config: ResolvedProjectConfig,
  summary: ProjectSummary,
  presets: ProjectLabelPresets = { projectStatuses: [], projectTypes: [] }
): ProjectResource {
  return {
    ...summary,
    description: project.description,
    teamMembers: [...project.teamMembers],
    customFields: config.customFields.map((field) => ({ ...field })),
    statuses: config.statuses.map((status) => ({ ...status })),
    priorities: config.priorities.map((priority) => ({ ...priority })),
    projectStatuses: presets.projectStatuses.map((status) => ({ ...status })),
    projectTypes: presets.projectTypes.map((type) => ({ ...type })),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  }
}

function isCalendarDate(value: string): boolean {
  return value === '' || (/^\d{4}-\d{2}-\d{2}$/.test(value) && parsePlainDate(value) !== null)
}

function stringField(name: string, description: string): v.GenericSchema<string, string> {
  return v.pipe(v.string(`${name} must be a string`), v.description(description))
}

function dateField(name: string): v.GenericSchema<string, string> {
  return v.pipe(
    v.string(`${name} must be a string`),
    v.check(isCalendarDate, `${name} must be YYYY-MM-DD or empty`),
    v.description('YYYY-MM-DD, or empty to clear')
  )
}

function listField(name: string, description: string): v.GenericSchema<string[], string[]> {
  const message = `${name} must be a list of strings`
  return v.pipe(v.array(v.string(message), message), v.description(description))
}

function integerField(name: string, min: number, max: number): v.GenericSchema<number, number> {
  const message = `${name} must be an integer from ${min} to ${max}`
  return v.pipe(v.number(message), v.integer(message), v.minValue(min, message), v.maxValue(max, message))
}

const RECURRENCE = v.object(
  {
    interval: v.picklist(RECURRENCE_INTERVALS, `recurrence.interval must be one of ${RECURRENCE_INTERVALS.join(', ')}`),
    every: v.pipe(
      v.number('recurrence.every must be a positive integer'),
      v.integer('recurrence.every must be a positive integer'),
      v.minValue(1, 'recurrence.every must be a positive integer')
    ),
    endDate: v.optional(dateField('recurrence.endDate'))
  },
  missingKey('recurrence must be an object or null', 'recurrence.')
)

/** The fields a client may write, defining both what is accepted and what MCP advertises. */
export const TASK_FIELDS = {
  title: v.optional(
    v.pipe(
      v.string('title must be a string'),
      v.check((title) => title.trim() !== '', 'title must not be empty')
    )
  ),
  description: v.optional(stringField('description', 'Markdown body of the task note')),
  type: v.optional(v.picklist(TASK_TYPES, `type must be one of ${TASK_TYPES.join(', ')}`)),
  status: v.optional(stringField('status', "One of the project's status ids (see get_project)")),
  priority: v.optional(stringField('priority', "One of the project's priority ids (see get_project)")),
  start: v.optional(dateField('start')),
  due: v.optional(dateField('due')),
  progress: v.optional(integerField('progress', 0, 100)),
  assignees: v.optional(listField('assignees', 'Names or wikilinks of the people on the task')),
  tags: v.optional(listField('tags', 'Tags without the leading hash')),
  dependencies: v.optional(listField('dependencies', 'Ids of tasks this one waits for')),
  recurrence: v.optional(v.nullable(RECURRENCE)),
  timeEstimate: v.optional(
    v.nullable(
      v.pipe(
        v.number('timeEstimate must be a non-negative number or null'),
        v.minValue(0, 'timeEstimate must be a non-negative number or null'),
        v.description('Hours')
      )
    )
  ),
  customFields: v.optional(v.record(v.string(), v.unknown(), 'customFields must be an object'))
}

/** `title` is what separates a create from a patch, so only here is it required. */
export const CREATE_FIELDS = {
  ...TASK_FIELDS,
  title: v.pipe(
    v.string('title must be a string'),
    v.check((title) => title.trim() !== '', 'title must not be empty')
  ),
  parentId: v.optional(v.nullable(v.string('parentId must be a string or null')), null)
}

export const MOVE_FIELDS = {
  parentId: v.optional(v.nullable(v.string('parentId must be a string or null'))),
  projectId: v.optional(stringField('projectId', 'Move the task to this project')),
  before: v.optional(stringField('before', 'Id of the sibling to sit in front of')),
  after: v.optional(stringField('after', 'Id of the sibling to sit behind'))
}

export const SEARCH_FIELDS = {
  query: v.optional(stringField('query', 'Case-insensitive match on the title')),
  projectId: v.optional(stringField('projectId', 'Only tasks of this project')),
  status: v.optional(stringField('status', 'Only tasks with this status id')),
  assignee: v.optional(stringField('assignee', 'Only tasks this person is on')),
  includeArchived: v.optional(v.boolean('includeArchived must be true or false')),
  limit: v.optional(integerField('limit', 1, 500))
}

/** The fields a client may give a new project. Palettes and custom fields stay with the host. */
export const PROJECT_CREATE_FIELDS = {
  title: v.pipe(
    v.string('title must be a string'),
    v.check((title) => title.trim() !== '', 'title must not be empty')
  ),
  description: v.optional(stringField('description', 'Markdown body of the project note')),
  icon: v.optional(
    v.pipe(
      v.string('icon must be a string'),
      v.check((icon) => icon.trim() !== '', 'icon must not be empty'),
      v.description('An emoji')
    )
  ),
  color: v.optional(
    v.pipe(
      v.string('color must be a hex color like #8b72be'),
      v.regex(HEX_COLOR, 'color must be a hex color like #8b72be')
    )
  ),
  teamMembers: v.optional(listField('teamMembers', 'Names or wikilinks of the people on the project')),
  parentId: v.optional(
    v.nullable(
      v.pipe(
        v.string('parentId must be a string or null'),
        v.description('Id of the parent project, from list_projects')
      )
    )
  )
}

const PROJECT_CREATE = v.object(PROJECT_CREATE_FIELDS, missingKey('expected an object'))

const TASK_WRITE = v.object(TASK_FIELDS, missingKey('expected an object'))
const TASK_CREATE = v.object(CREATE_FIELDS, missingKey('expected an object'))

const TASK_MOVE = v.pipe(
  v.object(MOVE_FIELDS, missingKey('expected an object')),
  v.check((move) => move.before === undefined || move.after === undefined, 'pass before or after, not both'),
  v.check(
    (move) => move.parentId !== undefined || move.projectId !== undefined || Boolean(move.before || move.after),
    'nothing to move: pass parentId, projectId, before or after'
  )
)

const TASK_SEARCH = v.object(SEARCH_FIELDS, missingKey('expected an object'))

/** Only the project knows which status and priority ids its tasks may carry. */
function checkAgainstConfig(write: TaskWrite, config: ResolvedProjectConfig): void {
  if (write.status !== undefined && !config.statuses.some((status) => status.id === write.status)) {
    invalid(`status must be one of ${config.statuses.map((status) => status.id).join(', ')}`)
  }
  if (write.priority !== undefined && !config.priorities.some((priority) => priority.id === write.priority)) {
    invalid(`priority must be one of ${config.priorities.map((priority) => priority.id).join(', ')}`)
  }
}

export function parseTaskWrite(input: unknown, config: ResolvedProjectConfig): TaskWrite {
  const write = parse(TASK_WRITE, input)
  checkAgainstConfig(write, config)
  return write
}

export function parseTaskCreate(input: unknown, config: ResolvedProjectConfig): TaskCreate {
  const create = parse(TASK_CREATE, input)
  checkAgainstConfig(create, config)
  return create
}

export function parseProjectCreate(input: unknown): ProjectCreate {
  return parse(PROJECT_CREATE, input)
}

export function parseTaskMove(input: unknown): TaskMove {
  return parse(TASK_MOVE, input)
}

function requiredText(name: string, description: string): v.GenericSchema<string, string> {
  return v.pipe(
    v.string(`${name} must be a string`),
    v.check((value) => value.trim() !== '', `${name} must not be empty`),
    v.description(description)
  )
}

export const PROJECT_STATUS_FIELDS = {
  status: v.pipe(
    v.nullable(v.string('status must be a status id or null')),
    v.description('Id or label of one of the projectStatuses get_project lists, or null to clear')
  )
}

export const PROJECT_TYPES_FIELDS = {
  types: listField('types', 'Ids or labels of projectTypes from get_project; they replace the current ones')
}

const DATA_VALUE_MESSAGE = 'each value must be text, a number, true or false, or null'

export const PROJECT_DATA_FIELDS = {
  values: v.pipe(
    v.record(
      v.pipe(
        v.string(),
        v.check(isValidDataKey, 'property names start with a letter or digit and hold only letters, digits, - and _')
      ),
      v.nullable(v.union([v.string(), v.number(), v.boolean()], DATA_VALUE_MESSAGE)),
      'values must be an object of property names to values'
    ),
    v.description('Property name to value, as get_project_data lists them by key; null empties a property')
  )
}

export const PARTICIPANT_FIELDS = {
  name: requiredText('name', 'Name of the person'),
  role: v.optional(stringField('role', 'Their role on the project')),
  company: v.optional(stringField('company', 'Company or institution')),
  email: v.optional(stringField('email', 'Email address')),
  phone: v.optional(stringField('phone', 'Phone number'))
}

export const MEETING_FIELDS = {
  title: requiredText('title', 'Title of the meeting; the note is named "<date> <title>"'),
  date: v.optional(dateField('date')),
  content: v.optional(stringField('content', 'Markdown of the minutes'))
}

export const TIME_ENTRY_FIELDS = {
  hours: v.pipe(
    v.number('hours must be a number'),
    v.check((hours) => hours > 0 && hours <= 24, 'hours must be more than 0 and at most 24'),
    v.description('Hours worked, decimals allowed')
  ),
  date: v.optional(dateField('date')),
  person: v.optional(stringField('person', 'Who did the work')),
  activity: v.optional(stringField('activity', 'What was done'))
}

const PROJECT_STATUS = v.object(PROJECT_STATUS_FIELDS, missingKey('expected an object'))
const PROJECT_TYPES = v.object(PROJECT_TYPES_FIELDS, missingKey('expected an object'))
const PROJECT_DATA = v.object(PROJECT_DATA_FIELDS, missingKey('expected an object'))
const PARTICIPANT = v.object(PARTICIPANT_FIELDS, missingKey('expected an object'))
const MEETING = v.object(MEETING_FIELDS, missingKey('expected an object'))
const TIME_ENTRY = v.object(TIME_ENTRY_FIELDS, missingKey('expected an object'))

export function parseProjectStatus(input: unknown): string | null {
  const status = parse(PROJECT_STATUS, input).status
  return status === null || status.trim() === '' ? null : status.trim()
}

export function parseProjectTypes(input: unknown): string[] {
  return parse(PROJECT_TYPES, input)
    .types.map((type) => type.trim())
    .filter(Boolean)
}

export function parseProjectDataWrite(input: unknown): Record<string, ProjectDataValue> {
  return parse(PROJECT_DATA, input).values
}

export function parseParticipant(input: unknown): Participant {
  const person = parse(PARTICIPANT, input)
  return {
    name: person.name.trim(),
    role: person.role?.trim() ?? '',
    company: person.company?.trim() ?? '',
    email: person.email?.trim() ?? '',
    phone: person.phone?.trim() ?? ''
  }
}

export function parseMeetingCreate(input: unknown): MeetingCreate {
  const meeting = parse(MEETING, input)
  return { ...meeting, title: meeting.title.trim(), date: meeting.date || undefined }
}

export function parseTimeEntry(input: unknown): TimeEntryCreate {
  const entry = parse(TIME_ENTRY, input)
  return { ...entry, date: entry.date || undefined }
}

export function parseTaskSearch(input: unknown): TaskSearch {
  const search = parse(TASK_SEARCH, input)
  for (const key of ['query', 'projectId', 'status', 'assignee'] as const) {
    if (search[key] === '') search[key] = undefined
  }
  return search
}

/** The store's patch shape: absent fields untouched, null meaning cleared. */
export function taskPatch(write: TaskWrite): Partial<Task> {
  const patch: Partial<Task> = {}
  if (write.title !== undefined) patch.title = write.title
  if (write.description !== undefined) patch.description = write.description
  if (write.type !== undefined) patch.type = write.type
  if (write.status !== undefined) patch.status = write.status
  if (write.priority !== undefined) patch.priority = write.priority
  if (write.start !== undefined) patch.start = write.start
  if (write.due !== undefined) patch.due = write.due
  if (write.progress !== undefined) patch.progress = write.progress
  if (write.assignees !== undefined) patch.assignees = write.assignees
  if (write.tags !== undefined) patch.tags = write.tags
  if (write.dependencies !== undefined) patch.dependencies = write.dependencies
  if (write.recurrence !== undefined) patch.recurrence = write.recurrence ?? undefined
  if (write.timeEstimate !== undefined) patch.timeEstimate = write.timeEstimate ?? undefined
  if (write.customFields !== undefined) patch.customFields = write.customFields
  return patch
}

/** Rebuilds the task tree a project holds from its flat resources, siblings in position order. */
export function tasksFromResources(resources: TaskResource[]): Task[] {
  const byId = new Map<string, Task>()
  for (const r of resources) {
    byId.set(
      r.id,
      makeTask({
        id: r.id,
        title: r.title,
        description: r.description,
        type: r.type,
        status: r.status,
        priority: r.priority,
        start: r.start,
        due: r.due,
        completed: r.completed,
        progress: r.progress,
        assignees: [...r.assignees],
        tags: [...r.tags],
        dependencies: [...r.dependencies],
        recurrence: r.recurrence ?? undefined,
        timeEstimate: r.timeEstimate ?? undefined,
        timeLogs: r.timeLogs.map((log) => ({ ...log })),
        customFields: { ...r.customFields },
        archived: r.archived,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        filePath: r.path || undefined
      })
    )
  }
  const roots: Task[] = []
  const sorted = [...resources].sort((a, b) => a.position - b.position)
  for (const r of sorted) {
    const task = byId.get(r.id)
    if (!task) continue
    const parent = r.parentId ? byId.get(r.parentId) : undefined
    if (parent) parent.subtasks.push(task)
    else roots.push(task)
  }
  return roots
}

const INDEX = v.pipe(
  integerField('index', 0, 1_000_000),
  v.description('Position in the list as last read, starting at 0')
)

function hoursField(name: string): v.GenericSchema<number, number> {
  return v.pipe(
    v.number(`${name} must be a number`),
    v.check((hours) => hours > 0 && hours <= 24, `${name} must be more than 0 and at most 24`)
  )
}

export const PROJECT_TAGS_FIELDS = {
  tags: listField('tags', 'Tags without #; they replace the current ones, [] clears them')
}

const MEETING_PATH = requiredText('path', 'Path of the meeting note, from list_meetings')

export const MEETING_UPDATE_FIELDS = {
  path: MEETING_PATH,
  title: v.optional(requiredText('title', 'New title; renames the note')),
  date: v.optional(dateField('date')),
  content: v.optional(stringField('content', 'New Markdown of the minutes, replacing the old'))
}

export const MEETING_REF_FIELDS = { path: MEETING_PATH }

const EXPECTED_NAME = v.optional(
  stringField('expectedName', 'The name list_participants showed at that index; a different one refuses the change')
)

export const PARTICIPANT_UPDATE_FIELDS = {
  index: INDEX,
  expectedName: EXPECTED_NAME,
  name: v.optional(requiredText('name', 'New name')),
  role: v.optional(stringField('role', 'New role')),
  company: v.optional(stringField('company', 'New company')),
  email: v.optional(stringField('email', 'New email address')),
  phone: v.optional(stringField('phone', 'New phone number'))
}

export const PARTICIPANT_REF_FIELDS = { index: INDEX, expectedName: EXPECTED_NAME }

const EXPECTED_ENTRY = {
  expectedDate: v.optional(dateField('expectedDate')),
  expectedHours: v.optional(
    v.pipe(v.number('expectedHours must be a number'), v.description('The hours get_timesheet showed at that index'))
  )
}

export const TIME_ENTRY_UPDATE_FIELDS = {
  index: INDEX,
  ...EXPECTED_ENTRY,
  date: v.optional(dateField('date')),
  hours: v.optional(hoursField('hours')),
  person: v.optional(stringField('person', 'Who did the work')),
  activity: v.optional(stringField('activity', 'What was done'))
}

export const TIME_ENTRY_REF_FIELDS = { index: INDEX, ...EXPECTED_ENTRY }

const LABEL_PRESET = v.object(
  {
    id: v.optional(stringField('id', 'The value written into notes; derived from the label when left out')),
    label: requiredText('label', 'Name shown in Obsidian'),
    color: v.optional(
      v.pipe(
        v.string('color must be a hex color like #8b72be'),
        v.regex(HEX_COLOR, 'color must be a hex color like #8b72be')
      )
    ),
    icon: v.optional(stringField('icon', 'An emoji or a Lucide icon name'))
  },
  missingKey('each preset must be an object', 'preset ')
)

const DATA_FIELD = v.object(
  {
    key: v.optional(
      v.pipe(
        v.string('key must be a string'),
        v.check(isValidDataKey, 'property names start with a letter or digit and hold only letters, digits, - and _')
      )
    ),
    label: requiredText('label', 'Name shown on the overview'),
    group: v.optional(stringField('group', 'Fields with the same group show together'))
  },
  missingKey('each field must be an object', 'field ')
)

export const PRESETS_FIELDS = {
  projectStatuses: v.optional(
    v.pipe(
      v.array(LABEL_PRESET, 'projectStatuses must be a list'),
      v.description('Every status preset in list order; replaces the current list')
    )
  ),
  projectTypes: v.optional(
    v.pipe(
      v.array(LABEL_PRESET, 'projectTypes must be a list'),
      v.description('Every type preset; replaces the current list')
    )
  ),
  projectDataFields: v.optional(
    v.pipe(
      v.array(DATA_FIELD, 'projectDataFields must be a list'),
      v.description('Every project data field in overview order; replaces the current list')
    )
  )
}

export const SHEET_SYNC_FIELDS = {
  projectId: v.optional(stringField('projectId', 'One project to sync; every project when left out'))
}

const PROJECT_TAGS = v.object(PROJECT_TAGS_FIELDS, missingKey('expected an object'))
const MEETING_UPDATE = v.object(MEETING_UPDATE_FIELDS, missingKey('expected an object'))
const MEETING_REF = v.object(MEETING_REF_FIELDS, missingKey('expected an object'))
const PARTICIPANT_UPDATE = v.object(PARTICIPANT_UPDATE_FIELDS, missingKey('expected an object'))
const PARTICIPANT_REF = v.object(PARTICIPANT_REF_FIELDS, missingKey('expected an object'))
const TIME_ENTRY_UPDATE = v.object(TIME_ENTRY_UPDATE_FIELDS, missingKey('expected an object'))
const TIME_ENTRY_REF = v.object(TIME_ENTRY_REF_FIELDS, missingKey('expected an object'))
const PRESETS = v.object(PRESETS_FIELDS, missingKey('expected an object'))
const SHEET_SYNC = v.object(SHEET_SYNC_FIELDS, missingKey('expected an object'))

export function parseProjectTags(input: unknown): string[] {
  const tags = parse(PROJECT_TAGS, input)
    .tags.map((tag) => tag.trim().replace(/^#/, ''))
    .filter(Boolean)
  return [...new Set(tags)]
}

export interface MeetingUpdate {
  path: string
  title?: string
  date?: string
  content?: string
}

export function parseMeetingUpdate(input: unknown): MeetingUpdate {
  const update = parse(MEETING_UPDATE, input)
  return { ...update, title: update.title?.trim(), date: update.date || undefined }
}

export function parseMeetingRef(input: unknown): string {
  return parse(MEETING_REF, input).path
}

export interface RowRef {
  index: number
  expectedName?: string
  expectedDate?: string
  expectedHours?: number
}

export function parseParticipantUpdate(input: unknown): RowRef & { patch: Partial<Participant> } {
  const { index, expectedName, ...patch } = parse(PARTICIPANT_UPDATE, input)
  const trimmed = Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value?.trim()]))
  return { index, expectedName, patch: trimmed }
}

export function parseParticipantRef(input: unknown): RowRef {
  return parse(PARTICIPANT_REF, input)
}

export function parseTimeEntryUpdate(input: unknown): RowRef & { patch: Partial<TimesheetEntry> } {
  const { index, expectedDate, expectedHours, ...patch } = parse(TIME_ENTRY_UPDATE, input)
  if (patch.date === '') delete patch.date
  return { index, expectedDate: expectedDate || undefined, expectedHours, patch }
}

export function parseTimeEntryRef(input: unknown): RowRef {
  const ref = parse(TIME_ENTRY_REF, input)
  return { ...ref, expectedDate: ref.expectedDate || undefined }
}

function labelPresets(entries: v.InferOutput<typeof LABEL_PRESET>[], what: string): ProjectLabelConfig[] {
  const taken: string[] = []
  return entries.map((entry) => {
    const id = entry.id?.trim() || projectLabelIdFor(entry.label, taken) || `${what}-${taken.length + 1}`
    if (taken.includes(id)) invalid(`two ${what} presets share the id "${id}"`)
    taken.push(id)
    return { id, label: entry.label.trim(), color: entry.color ?? DEFAULT_PALETTE_COLOR, icon: entry.icon ?? '' }
  })
}

function dataFields(entries: v.InferOutput<typeof DATA_FIELD>[]): ProjectDataField[] {
  const taken: string[] = []
  return entries.map((entry) => {
    const group = entry.group?.trim() ?? ''
    const label = entry.label.trim()
    const key = entry.key?.trim() || projectDataKeyFor(group, label, taken)
    if (taken.includes(key)) invalid(`two project data fields share the key "${key}"`)
    taken.push(key)
    return { key, label, group }
  })
}

/** The lists given, with ids and keys filled in from labels where a client left them out. */
export function parsePresets(input: unknown): Partial<PresetsResource> {
  const presets = parse(PRESETS, input)
  const out: Partial<PresetsResource> = {}
  if (presets.projectStatuses) out.projectStatuses = labelPresets(presets.projectStatuses, 'status')
  if (presets.projectTypes) out.projectTypes = labelPresets(presets.projectTypes, 'type')
  if (presets.projectDataFields) out.projectDataFields = dataFields(presets.projectDataFields)
  return out
}

export function parseSheetSync(input: unknown): string | undefined {
  return parse(SHEET_SYNC, input ?? {}).projectId?.trim() || undefined
}
