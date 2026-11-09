import { toJsonSchema } from '@valibot/to-json-schema'
import {
  JSON_RPC_ERROR_CODES,
  McpServer,
  RpcError,
  StreamableHttpTransport,
  type JsonRpcError,
  type ToolCallResult
} from 'mcp-lite'
import * as v from 'valibot'
import { ApiRequestError, type DomainApi } from './contract'
import {
  CREATE_FIELDS,
  MEETING_FIELDS,
  MEETING_REF_FIELDS,
  MEETING_UPDATE_FIELDS,
  PARTICIPANT_REF_FIELDS,
  PARTICIPANT_UPDATE_FIELDS,
  PRESETS_FIELDS,
  PROJECT_TAGS_FIELDS,
  SHEET_SYNC_FIELDS,
  TIME_ENTRY_REF_FIELDS,
  TIME_ENTRY_UPDATE_FIELDS,
  MOVE_FIELDS,
  PARTICIPANT_FIELDS,
  parseTaskSearch,
  PROJECT_CREATE_FIELDS,
  PROJECT_DATA_FIELDS,
  PROJECT_STATUS_FIELDS,
  PROJECT_TYPES_FIELDS,
  SEARCH_FIELDS,
  TASK_FIELDS,
  TIME_ENTRY_FIELDS
} from './resources'

export interface ServerInfo {
  name: string
  version: string
}

const SERVER_ERROR = -32000

const INSTRUCTIONS =
  'Projects hold tasks in a tree. Read a project first to learn its status and priority ids before writing tasks. ' +
  'A project also has a status and types picked from the projectStatuses and projectTypes get_project lists, and ' +
  'keeps notes beside it: project data (key facts such as client and plot, also mirrored to a spreadsheet), ' +
  'participants, one note per meeting, and a timesheet.'

const PROJECT_TEMPLATE = 'dotpm://projects/{projectId}'
const TASK_TEMPLATE = 'dotpm://tasks/{taskId}'

function idField(name: string, description: string): v.GenericSchema<string, string> {
  return v.pipe(v.string(`${name} is required`), v.description(description))
}

const projectId = idField('projectId', 'Id of the project, from list_projects')
const taskId = idField('taskId', 'Id of the task, from list_tasks or search_tasks')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** What a tool advertises. The two root keys the conversion adds are noise to a client. */
function jsonSchema(schema: v.GenericSchema): Record<string, unknown> {
  const converted = toJsonSchema(schema, { errorMode: 'ignore', typeMode: 'input' }) as Record<string, unknown>
  delete converted['$schema']
  delete converted['default']
  return converted
}

function text(value: unknown): ToolCallResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

function jsonContents(
  uri: string,
  value: unknown
): { contents: [{ uri: string; type: 'text'; mimeType: string; text: string }] } {
  return { contents: [{ uri, type: 'text', mimeType: 'application/json', text: JSON.stringify(value, null, 2) }] }
}

/**
 * Registers one tool. The schema both checks the arguments, through the transport, and
 * becomes the JSON Schema clients read. A call may leave `arguments` out entirely, which
 * stands for an empty object; a value the vault refuses comes back as a tool result
 * marked `isError` rather than a protocol error.
 */
function tool<S extends v.GenericSchema>(
  server: McpServer,
  name: string,
  def: { description: string; inputSchema: S; run: (args: v.InferOutput<S>) => Promise<unknown> }
): void {
  server.tool<v.InferOutput<S>>(name, {
    description: def.description,
    inputSchema: v.optional(def.inputSchema, () => ({}) as v.InferInput<S>),
    handler: async (args) => {
      try {
        return text(await def.run(args))
      } catch (err: unknown) {
        if (err instanceof ApiRequestError) return { ...text({ error: err.code, message: err.message }), isError: true }
        throw err
      }
    }
  })
}

function registerTools(server: McpServer, api: DomainApi): void {
  tool(server, 'list_projects', {
    description:
      'Every project in the vault with its id, title, parent and task counts. Archived ones only when asked.',
    inputSchema: v.object({ includeArchived: v.optional(v.boolean(), false) }),
    run: (args) => api.listProjects(args.includeArchived)
  })

  tool(server, 'get_project', {
    description: 'One project with its description, team, custom fields and the status and priority ids its tasks use.',
    inputSchema: v.object({ projectId }),
    run: (args) => api.getProject(args.projectId)
  })

  tool(server, 'archive_project', {
    description: 'Archive a project and its sub-projects, or bring it back with archived: false.',
    inputSchema: v.object({ projectId, archived: v.optional(v.boolean('archived must be true or false'), true) }),
    run: (args) => api.archiveProject(args.projectId, args.archived)
  })

  tool(server, 'create_project', {
    description:
      'Create a project, at the root or under parentId. It starts with the global statuses and priorities; read it back with get_project before adding tasks.',
    inputSchema: v.object(PROJECT_CREATE_FIELDS),
    run: (args) => api.createProject(args)
  })

  tool(server, 'list_tasks', {
    description: 'All tasks of a project in tree order. Each carries parentId and position.',
    inputSchema: v.object({ projectId, includeArchived: v.optional(v.boolean(), false) }),
    run: (args) => api.listTasks(args.projectId, args.includeArchived)
  })

  tool(server, 'get_task', {
    description: 'One task by id, including its description.',
    inputSchema: v.object({ taskId }),
    run: (args) => api.getTask(args.taskId)
  })

  tool(server, 'search_tasks', {
    description: 'Find tasks across every project by title text, project, status or assignee.',
    inputSchema: v.object(SEARCH_FIELDS),
    run: (args) => api.searchTasks(parseTaskSearch(args))
  })

  tool(server, 'create_task', {
    description: 'Create a task in a project, at the top level or under parentId.',
    inputSchema: v.object({ projectId, ...CREATE_FIELDS }),
    run: ({ projectId: project, ...create }) => api.createTask(project, create)
  })

  tool(server, 'update_task', {
    description:
      'Change fields of a task. Only the fields passed change. Pass expectedUpdatedAt from a previous read to refuse the write when the task changed since.',
    inputSchema: v.object({
      taskId,
      expectedUpdatedAt: v.optional(
        v.pipe(v.string('expectedUpdatedAt must be a string'), v.description('updatedAt from an earlier read'))
      ),
      ...TASK_FIELDS
    }),
    run: ({ taskId: task, expectedUpdatedAt, ...write }) => api.updateTask(task, write, expectedUpdatedAt)
  })

  tool(server, 'move_task', {
    description:
      'Re-parent a task (parentId, null for top level), move it to another project (projectId), or reorder it among its siblings (before or after a sibling id).',
    inputSchema: v.object({ taskId, ...MOVE_FIELDS }),
    run: ({ taskId: task, ...move }) => api.moveTask(task, move)
  })

  tool(server, 'archive_task', {
    description: 'Archive a task and its subtasks, or bring them back with archived: false.',
    inputSchema: v.object({ taskId, archived: v.optional(v.boolean('archived must be true or false'), true) }),
    run: (args) => api.archiveTask(args.taskId, args.archived)
  })

  tool(server, 'delete_task', {
    description: 'Delete a task and its subtasks. Cannot be undone.',
    inputSchema: v.object({ taskId }),
    run: async (args) => {
      await api.deleteTask(args.taskId)
      return { deleted: true }
    }
  })

  tool(server, 'set_project_status', {
    description:
      'Put a project in one of the projectStatuses get_project lists, by id or label, or clear it with null.',
    inputSchema: v.object({ projectId, ...PROJECT_STATUS_FIELDS }),
    run: ({ projectId: project, ...status }) => api.setProjectStatus(project, status)
  })

  tool(server, 'set_project_types', {
    description:
      'Set what a project is about: the projectTypes get_project lists, by id or label. The list replaces the current types; pass [] to clear.',
    inputSchema: v.object({ projectId, ...PROJECT_TYPES_FIELDS }),
    run: ({ projectId: project, ...types }) => api.setProjectTypes(project, types)
  })

  tool(server, 'get_project_data', {
    description:
      'The project data note: key facts such as the client, the plot and the zoning plan, one row per field with group, label, key and value, the project folder first.',
    inputSchema: v.object({ projectId }),
    run: (args) => api.getProjectData(args.projectId)
  })

  tool(server, 'update_project_data', {
    description:
      'Write values into the project data note by key, as get_project_data lists them. Keys left out stay; null empties one. The spreadsheet copy follows.',
    inputSchema: v.object({ projectId, ...PROJECT_DATA_FIELDS }),
    run: ({ projectId: project, ...write }) => api.updateProjectData(project, write)
  })

  tool(server, 'list_participants', {
    description: 'Everyone on a project with role, company, email and phone.',
    inputSchema: v.object({ projectId }),
    run: (args) => api.listParticipants(args.projectId)
  })

  tool(server, 'add_participant', {
    description: 'Add a person to the project participants. Returns the whole list.',
    inputSchema: v.object({ projectId, ...PARTICIPANT_FIELDS }),
    run: ({ projectId: project, ...person }) => api.addParticipant(project, person)
  })

  tool(server, 'list_meetings', {
    description: 'The project meeting notes, newest first, each with date, title and its Markdown.',
    inputSchema: v.object({ projectId }),
    run: (args) => api.listMeetings(args.projectId)
  })

  tool(server, 'create_meeting', {
    description: 'Create a meeting note for a project, dated today unless date is given, with the minutes as Markdown.',
    inputSchema: v.object({ projectId, ...MEETING_FIELDS }),
    run: ({ projectId: project, ...meeting }) => api.createMeeting(project, meeting)
  })

  tool(server, 'get_timesheet', {
    description: 'The hours booked on a project: every entry, the total and the hours per person.',
    inputSchema: v.object({ projectId }),
    run: (args) => api.getTimesheet(args.projectId)
  })

  tool(server, 'log_time', {
    description: 'Book hours on a project, dated today unless date is given. Returns the whole timesheet.',
    inputSchema: v.object({ projectId, ...TIME_ENTRY_FIELDS }),
    run: ({ projectId: project, ...entry }) => api.logTime(project, entry)
  })

  tool(server, 'set_project_tags', {
    description: "Replace a project note's tags (without #); [] clears them. list_projects shows each project's tags.",
    inputSchema: v.object({ projectId, ...PROJECT_TAGS_FIELDS }),
    run: ({ projectId: project, ...tags }) => api.setProjectTags(project, tags)
  })

  tool(server, 'update_meeting', {
    description:
      'Change a meeting note by its path from list_meetings: content replaces the minutes, title and date rename the note.',
    inputSchema: v.object({ projectId, ...MEETING_UPDATE_FIELDS }),
    run: ({ projectId: project, ...update }) => api.updateMeeting(project, update)
  })

  tool(server, 'delete_meeting', {
    description: 'Move a meeting note, by its path from list_meetings, to the trash.',
    inputSchema: v.object({ projectId, ...MEETING_REF_FIELDS }),
    run: async ({ projectId: project, ...ref }) => {
      await api.deleteMeeting(project, ref)
      return { deleted: true }
    }
  })

  tool(server, 'update_participant', {
    description:
      'Change the participant at an index of list_participants; only the fields passed change. Pass expectedName to refuse the change when the list moved.',
    inputSchema: v.object({ projectId, ...PARTICIPANT_UPDATE_FIELDS }),
    run: ({ projectId: project, ...update }) => api.updateParticipant(project, update)
  })

  tool(server, 'remove_participant', {
    description:
      'Remove the participant at an index of list_participants. Pass expectedName to guard it. Returns the rest.',
    inputSchema: v.object({ projectId, ...PARTICIPANT_REF_FIELDS }),
    run: ({ projectId: project, ...ref }) => api.removeParticipant(project, ref)
  })

  tool(server, 'update_time_entry', {
    description:
      'Correct the timesheet entry at an index of get_timesheet entries; only the fields passed change. Pass expectedDate and expectedHours to refuse the change when the sheet moved.',
    inputSchema: v.object({ projectId, ...TIME_ENTRY_UPDATE_FIELDS }),
    run: ({ projectId: project, ...update }) => api.updateTimeEntry(project, update)
  })

  tool(server, 'delete_time_entry', {
    description: 'Delete the timesheet entry at an index of get_timesheet entries, guarded like update_time_entry.',
    inputSchema: v.object({ projectId, ...TIME_ENTRY_REF_FIELDS }),
    run: ({ projectId: project, ...ref }) => api.removeTimeEntry(project, ref)
  })

  tool(server, 'get_presets', {
    description:
      'The vault-wide lists projects pick from: status presets (in list order), type presets and the project data fields.',
    inputSchema: v.object({}),
    run: () => api.getPresets()
  })

  tool(server, 'update_presets', {
    description:
      'Replace any of the lists get_presets returns. Pass a whole list: entries left out are removed. Ids and keys are derived from labels when left out. Changing an id leaves notes holding the old one unmatched.',
    inputSchema: v.object(PRESETS_FIELDS),
    run: (args) => api.updatePresets(args)
  })

  tool(server, 'sync_project_sheets', {
    description:
      "Sync project data notes with their spreadsheets now, for one project or all. Reports what couldn't be synced, such as a spreadsheet open in Excel.",
    inputSchema: v.object(SHEET_SYNC_FIELDS),
    run: (args) => api.syncProjectSheets(args)
  })

  tool(server, 'set_up_project_data', {
    description:
      'Give every project a project data note, take project folders from "Projektordner:" lines of descriptions, and sync the spreadsheets.',
    inputSchema: v.object({}),
    run: () => api.setUpProjectData()
  })

  tool(server, 'list_changes', {
    description:
      'Projects and tasks changed since a cursor, oldest first. Omit since for the current cursor only. A reset of true means the cursor was too old: refetch.',
    inputSchema: v.object({
      since: v.optional(
        v.pipe(v.number('since must be an integer cursor'), v.integer('since must be an integer cursor'))
      )
    }),
    run: (args) => api.changes(args.since ?? null)
  })
}

function registerResources(server: McpServer, api: DomainApi): void {
  server.resource(PROJECT_TEMPLATE, { name: 'Project with tasks', mimeType: 'application/json' }, async (uri, vars) => {
    const project = String(vars['projectId'])
    const [resource, tasks] = await Promise.all([api.getProject(project), api.listTasks(project)])
    return jsonContents(uri.href, { ...resource, tasks })
  })

  server.resource(TASK_TEMPLATE, { name: 'Task', mimeType: 'application/json' }, async (uri, vars) =>
    jsonContents(uri.href, await api.getTask(String(vars['taskId'])))
  )
}

/**
 * Two results mcp-lite has no hook for: `initialize` carries no instructions, and
 * `resources/list` knows only what was registered, never one entry per project.
 */
function completeResults(server: McpServer, api: DomainApi): void {
  server.use(async (ctx, next) => {
    await next()
    const result = ctx.response?.result
    if (!isRecord(result)) return
    if (ctx.request.method === 'initialize') result['instructions'] = INSTRUCTIONS
    if (ctx.request.method === 'resources/list') {
      const projects = await api.listProjects()
      result['resources'] = projects.map((project) => ({
        uri: `dotpm://projects/${project.id}`,
        name: project.title,
        description: `${project.taskCount} tasks, ${project.doneCount} done`,
        mimeType: 'application/json'
      }))
    }
  })
}

/** Anything the protocol itself raised already says what went wrong and passes through. */
function toRpcError(err: unknown): JsonRpcError | undefined {
  if (err instanceof ApiRequestError) {
    return { code: err.code === 'invalid' ? JSON_RPC_ERROR_CODES.INVALID_PARAMS : SERVER_ERROR, message: err.message }
  }
  if (err instanceof RpcError) return undefined
  console.error('[PM] mcp request failed', err)
  return { code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR, message: 'request failed; see the developer console' }
}

/**
 * MCP over Streamable HTTP in its stateless form: one POST carries one message, and the
 * reply is JSON unless the client asked for an event stream. There is no session, so a
 * client that wants the standalone `GET` stream is told the method is not allowed.
 */
export function createMcpHandler(api: DomainApi, info: ServerInfo): (request: Request) => Promise<Response> {
  const server = new McpServer({
    name: info.name,
    version: info.version,
    schemaAdapter: (schema) => jsonSchema(schema as v.GenericSchema)
  })
  server.onError(toRpcError)
  completeResults(server, api)
  registerTools(server, api)
  registerResources(server, api)
  return new StreamableHttpTransport().bind(server)
}
