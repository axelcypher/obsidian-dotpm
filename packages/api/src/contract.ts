import type {
  CustomFieldDef,
  Participant,
  PriorityConfig,
  ProjectDataField,
  ProjectDataRow,
  ProjectDataValue,
  ProjectLabelConfig,
  Recurrence,
  StatusConfig,
  TaskType,
  TimeLog,
  TimesheetEntry
} from '@dotpm/core'

/** What a listing shows for a project, cheap enough to serve without loading it. */
export interface ProjectSummary {
  id: string
  path: string
  title: string
  icon: string
  color: string
  parentId: string | null
  /** Set on the project itself or inherited from an archived ancestor. */
  archived: boolean
  taskCount: number
  doneCount: number
  /** The id of the project's status preset, or the value as written when no preset names it. */
  status: string | null
  /** The ids of the project's types, in the order its note lists them. */
  types: string[]
  /** The project note's own tags, without `#`. */
  tags: string[]
}

export interface ProjectResource extends ProjectSummary {
  description: string
  teamMembers: string[]
  customFields: CustomFieldDef[]
  statuses: StatusConfig[]
  priorities: PriorityConfig[]
  /** The status presets a project can be in, in list order: what `status` takes. */
  projectStatuses: ProjectLabelConfig[]
  /** The type presets a project can carry: what `types` takes. */
  projectTypes: ProjectLabelConfig[]
  createdAt: string
  updatedAt: string
}

/** The project's data note: one row per field, the project folder first. */
export interface ProjectDataResource {
  projectId: string
  /** The project's folder outside the vault, empty without one. */
  folder: string
  rows: ProjectDataRow[]
  /** The spreadsheet kept in step with the note, when the sync is on and the sheet can be reached. */
  sheet: { path: string; ok: boolean; message: string } | null
}

/** What every project picks its status, types and data fields from. Order matters: it is the order shown. */
export interface PresetsResource {
  projectStatuses: ProjectLabelConfig[]
  projectTypes: ProjectLabelConfig[]
  projectDataFields: ProjectDataField[]
}

export interface SheetSyncResult {
  /** Projects whose data note and spreadsheet were compared. */
  checked: number
  problems: { projectId: string; title: string; message: string }[]
}

export interface ProjectDataSetUp {
  /** Data notes that didn't exist before. */
  created: number
  /** Project folders taken from a "Projektordner:" line of a description. */
  folders: number
}

/** Values to write into the data note, by property; null empties one. */
export interface ProjectDataWrite {
  values: Record<string, ProjectDataValue>
}

export interface MeetingResource {
  path: string
  /** `YYYY-MM-DD` from the note's name, empty without one. */
  date: string
  title: string
  /** The note's Markdown, without its properties. */
  content: string
}

export interface MeetingCreate {
  title: string
  /** `YYYY-MM-DD`; today when left out. */
  date?: string
  content?: string
}

export interface TimesheetResource {
  projectId: string
  entries: TimesheetEntry[]
  total: number
  byPerson: { person: string; hours: number }[]
}

export interface TimeEntryCreate {
  hours: number
  /** `YYYY-MM-DD`; today when left out. */
  date?: string
  person?: string
  activity?: string
}

export interface TaskResource {
  id: string
  projectId: string
  parentId: string | null
  /** Index among its siblings. */
  position: number
  path: string
  title: string
  description: string
  type: TaskType
  status: string
  priority: string
  start: string
  due: string
  completed: string
  progress: number
  assignees: string[]
  tags: string[]
  dependencies: string[]
  recurrence: Recurrence | null
  timeEstimate: number | null
  timeLogs: TimeLog[]
  customFields: Record<string, unknown>
  archived: boolean
  createdAt: string
  updatedAt: string
}

/** The fields a client may write. Everything else is derived or owned by the host. */
export interface TaskWrite {
  title?: string
  description?: string
  type?: TaskType
  status?: string
  priority?: string
  start?: string
  due?: string
  progress?: number
  assignees?: string[]
  tags?: string[]
  dependencies?: string[]
  recurrence?: Recurrence | null
  timeEstimate?: number | null
  customFields?: Record<string, unknown>
}

export interface TaskCreate extends TaskWrite {
  title: string
  parentId?: string | null
}

export interface TaskMove {
  parentId?: string | null
  projectId?: string
  before?: string
  after?: string
}

/** What a client sends to create a project; the host picks the folder from `parentId` or its settings. */
export interface ProjectCreate {
  title: string
  description?: string
  icon?: string
  color?: string
  teamMembers?: string[]
  parentId?: string | null
}

export interface TaskSearch {
  query?: string
  projectId?: string
  status?: string
  assignee?: string
  includeArchived?: boolean
  limit?: number
}

export interface Change {
  seq: number
  at: string
  /** Project files carry the note's path as their id. */
  kind: 'project' | 'task' | 'data' | 'participants' | 'meeting' | 'timesheet'
  op: 'upsert' | 'delete'
  id: string
  projectId: string
}

export interface ChangePage {
  cursor: number
  changes: Change[]
  /** The cursor asked for is older than what is kept; refetch instead of applying. */
  reset: boolean
}

export type ApiErrorCode = 'invalid' | 'unauthorized' | 'not_found' | 'conflict' | 'unavailable'

export class ApiRequestError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ApiRequestError'
  }
}

export const ERROR_STATUS: Record<ApiErrorCode, number> = {
  invalid: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 412,
  unavailable: 503
}

/**
 * The contract every host implements: the plugin over the vault today, a server later.
 * Ids are the only identity; paths are attributes. Writes take the raw client input
 * (`TaskCreate`, `TaskWrite`, `TaskMove` shaped) and validate it against the project,
 * since only the host knows a project's statuses. Every client mistake rejects with an
 * `ApiRequestError`.
 */
export interface DomainApi {
  listProjects(includeArchived?: boolean): Promise<ProjectSummary[]>
  getProject(projectId: string): Promise<ProjectResource>
  createProject(input: unknown): Promise<ProjectResource>
  /** Archiving a project archives everything under it; only the project flagged itself can be brought back. */
  archiveProject(projectId: string, archived: boolean): Promise<ProjectResource>
  listTasks(projectId: string, includeArchived?: boolean): Promise<TaskResource[]>
  getTask(taskId: string): Promise<TaskResource>
  searchTasks(search: TaskSearch): Promise<TaskResource[]>
  createTask(projectId: string, input: unknown): Promise<TaskResource>
  /** `expectedUpdatedAt` makes the write conditional: a mismatch rejects with `conflict`. */
  updateTask(taskId: string, input: unknown, expectedUpdatedAt?: string): Promise<TaskResource>
  moveTask(taskId: string, input: unknown): Promise<TaskResource>
  archiveTask(taskId: string, archived: boolean): Promise<TaskResource>
  deleteTask(taskId: string): Promise<void>
  changes(since: number | null): Promise<ChangePage>
  /** Puts the project in a status preset, by id or label, or clears it with null. */
  setProjectStatus(projectId: string, input: unknown): Promise<ProjectResource>
  /** Replaces the project's types with the presets given, by id or label. */
  setProjectTypes(projectId: string, input: unknown): Promise<ProjectResource>
  getProjectData(projectId: string): Promise<ProjectDataResource>
  /** Writes the values given into the data note, creating it when needed; others stay. */
  updateProjectData(projectId: string, input: unknown): Promise<ProjectDataResource>
  listParticipants(projectId: string): Promise<Participant[]>
  /** Adds a row to the participants table and returns them all. */
  addParticipant(projectId: string, input: unknown): Promise<Participant[]>
  /** Meeting notes, newest first. */
  listMeetings(projectId: string): Promise<MeetingResource[]>
  createMeeting(projectId: string, input: unknown): Promise<MeetingResource>
  getTimesheet(projectId: string): Promise<TimesheetResource>
  /** Books an entry into the timesheet and returns the whole sheet. */
  logTime(projectId: string, input: unknown): Promise<TimesheetResource>
  /** Replaces the project note's tags. */
  setProjectTags(projectId: string, input: unknown): Promise<ProjectResource>
  /** Changes a meeting note, by its path: its minutes, and through a rename its title and date. */
  updateMeeting(projectId: string, input: unknown): Promise<MeetingResource>
  /** Moves a meeting note, by its path, to the trash. */
  deleteMeeting(projectId: string, input: unknown): Promise<void>
  /** Changes the participant at an index of `listParticipants`; a name to expect guards against a list that moved. */
  updateParticipant(projectId: string, input: unknown): Promise<Participant[]>
  removeParticipant(projectId: string, input: unknown): Promise<Participant[]>
  /** Changes the entry at an index of the timesheet's entries; date and hours to expect guard against a sheet that moved. */
  updateTimeEntry(projectId: string, input: unknown): Promise<TimesheetResource>
  removeTimeEntry(projectId: string, input: unknown): Promise<TimesheetResource>
  getPresets(): Promise<PresetsResource>
  /** Replaces the lists given; lists left out stay. */
  updatePresets(input: unknown): Promise<PresetsResource>
  /** Syncs one project's spreadsheet, or every project's without a projectId. */
  syncProjectSheets(input: unknown): Promise<SheetSyncResult>
  /** Gives every project a data note, taking project folders from descriptions, then syncs the spreadsheets. */
  setUpProjectData(): Promise<ProjectDataSetUp>
}
