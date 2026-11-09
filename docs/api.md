# Local API and MCP

dotpm can serve the projects and tasks of an open vault to other programs on the same computer. Three clients talk to one server:

- HTTP with JSON bodies at `http://127.0.0.1:<port>/v1/...`
- The Model Context Protocol (MCP) over Streamable HTTP at `http://127.0.0.1:<port>/mcp`, for coding agents and chat clients
- The `dotpm` command from npm, for terminals and scripts, documented in [cli.md](cli.md)

All three read and write the same notes the views use, through the same code. A change made by a client shows in Obsidian at once, and an edit in Obsidian is visible to the next request.

## Turning it on

Settings > Local API > Serve projects to other apps. The server is off by default and exists only in the desktop app.

It listens on `127.0.0.1`, so nothing outside this computer can connect. Every request except the health check needs the bearer token shown in settings. Regenerating the token cuts off every client at once.

Each vault gets its own port, derived from the vault name so two open vaults do not collide. It can be changed in settings.

## MCP

Claude Code:

```sh
claude mcp add --transport http dotpm http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"
```

Cursor, Claude Desktop and other clients that take a JSON config:

```json
{
  "mcpServers": {
    "dotpm": {
      "url": "http://127.0.0.1:<port>/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

A client that can only launch a command, or cannot send a header, can use `dotpm mcp` from the command line package instead. It bridges stdio to this endpoint and finds the token itself. See [cli.md](cli.md).

Tools: `list_projects`, `get_project`, `archive_project`, `create_project`, `list_tasks`, `get_task`, `search_tasks`, `create_task`, `update_task`, `move_task`, `archive_task`, `delete_task`, `list_changes`.

Project status, types, tags and files (revamp):

- Labels: `set_project_status`, `set_project_types`, `set_project_tags`
- Project data: `get_project_data`, `update_project_data`
- Participants: `list_participants`, `add_participant`, `update_participant`, `remove_participant`
- Meetings: `list_meetings`, `create_meeting`, `update_meeting`, `delete_meeting`
- Timesheet: `get_timesheet`, `log_time`, `update_time_entry`, `delete_time_entry`
- Presets: `get_presets`, `update_presets` (status and type presets, project data fields)
- Spreadsheets: `sync_project_sheets`, `set_up_project_data`

Participants and timesheet entries have no ids: they are addressed by their index in the list as last read. Pass `expectedName` (participants) or `expectedDate` and `expectedHours` (entries) and a row that moved since is refused with `conflict` instead of changing the wrong one. Meetings are addressed by the `path` `list_meetings` gives.

Resources: `dotpm://projects/{id}` (the project with its tasks) and `dotpm://tasks/{id}`.

Read a project before writing tasks into it. Its `statuses` and `priorities` list the ids a task may carry, and a write with any other value is refused. Likewise its `projectStatuses` and `projectTypes` list what `set_project_status` and `set_project_types` take, by id or label.

[`skills/dotpm`](https://github.com/dotpm/cli/blob/main/skills/dotpm/SKILL.md) in the command line repository is a skill for agents that use these tools. Copy the folder into the agent's skills directory, `~/.claude/skills/` for Claude Code.

Protocol details:

- Stateless. Every request stands alone, there is no session, and the server pushes nothing.
- A POST that asks for `text/event-stream` gets its reply as one event, then the stream closes. The standalone `GET /mcp` stream and `DELETE /mcp` need a session, so both answer `405`.
- Protocol versions `2025-06-18` and `2025-03-26`.
- One message per request. JSON-RPC batches are refused.

## HTTP

Send `Authorization: Bearer <token>` with every request except `GET /v1/health`.

| Method and path | What it does |
| --- | --- |
| `GET /v1/health` | `{ ok, name, version }`, no token needed |
| `GET /v1/projects` | Every project: id, path, title, icon, color, parentId, archived, taskCount, doneCount; `?includeArchived=true` adds archived ones |
| `GET /v1/projects/{id}` | One project with description, team, custom fields, statuses and priorities |
| `POST /v1/projects` | Create a project from `title`, `description`, `icon`, `color`, `teamMembers` and an optional `parentId`; answers `201` |
| `POST /v1/projects/{id}/archive` | Body `{ "archived": true }` (the default) or `false`; sub-projects follow their parent |
| `GET /v1/projects/{id}/tasks` | Its tasks in tree order; `?includeArchived=true` adds archived ones |
| `POST /v1/projects/{id}/tasks` | Create a task from the fields below plus an optional `parentId`; answers `201` |
| `GET /v1/tasks/{id}` | One task |
| `PATCH /v1/tasks/{id}` | Change the fields in the body; `If-Match: <updatedAt>` refuses with `412` if the task changed since, as does a `title` whose note name another note holds |
| `POST /v1/tasks/{id}/move` | Body: `parentId` (null for top level), `projectId`, and `before` or `after` naming a sibling |
| `POST /v1/tasks/{id}/archive` | Body `{ "archived": true }` (the default) or `false` |
| `DELETE /v1/tasks/{id}` | Delete the task and its subtasks |
| `GET /v1/search` | `q` (title text), `projectId`, `status`, `assignee`, `includeArchived`, `limit` (default 50) |
| `GET /v1/changes?since=<cursor>` | What changed after a cursor, see below |
| `PUT /v1/projects/{id}/status` | Body `{ "status": "<id or label>" }` or `{ "status": null }` to clear; answers with the project |
| `PUT /v1/projects/{id}/types` | Body `{ "types": ["<id or label>", …] }`, replacing the current types; `[]` clears them |
| `GET /v1/projects/{id}/data` | The project data note: `{ projectId, folder, rows }`, each row `{ group, label, key, value }`, the project folder first |
| `PATCH /v1/projects/{id}/data` | Body `{ "values": { "<key>": <text, number, true/false or null> } }`; keys left out stay, null empties one; creates the note when needed |
| `GET /v1/projects/{id}/participants` | `[{ name, role, company, email, phone }]` from the participants table |
| `POST /v1/projects/{id}/participants` | Add a row from `name` and optional `role`, `company`, `email`, `phone`; answers `201` with everyone |
| `GET /v1/projects/{id}/meetings` | Meeting notes newest first: `{ path, date, title, content }` |
| `POST /v1/projects/{id}/meetings` | Create a meeting note from `title`, optional `date` (`YYYY-MM-DD`, today by default) and `content` (Markdown); answers `201` |
| `GET /v1/projects/{id}/timesheet` | `{ projectId, entries, total, byPerson }`, each entry `{ date, hours, person, activity }` |
| `POST /v1/projects/{id}/timesheet` | Book `hours` (more than 0, at most 24) with optional `date`, `person` (the one set in settings by default) and `activity`; answers `201` with the sheet |
| `PATCH /v1/projects/{id}/timesheet` | Body `{ index, expectedDate?, expectedHours?, date?, hours?, person?, activity? }`; changes the entry at `index` |
| `DELETE /v1/projects/{id}/timesheet` | Body `{ index, expectedDate?, expectedHours? }`; deletes the entry, answers with the sheet |
| `PATCH /v1/projects/{id}/participants` | Body `{ index, expectedName?, name?, role?, company?, email?, phone? }`; changes the participant at `index` |
| `DELETE /v1/projects/{id}/participants` | Body `{ index, expectedName? }`; removes the participant, answers with the rest |
| `PATCH /v1/projects/{id}/meetings` | Body `{ path, title?, date?, content? }`; `content` replaces the minutes, `title` and `date` rename the note |
| `DELETE /v1/projects/{id}/meetings` | Body `{ path }`; moves the note to the trash, answers `204` |
| `PUT /v1/projects/{id}/tags` | Body `{ "tags": ["…"] }`, replacing the project note's tags; `[]` clears them |
| `GET /v1/presets` | `{ projectStatuses, projectTypes, projectDataFields }` |
| `PATCH /v1/presets` | Replace any of those lists, each whole; ids and keys are derived from labels when left out |
| `POST /v1/sheets/sync` | Body `{ projectId? }`: sync one project's spreadsheet or all; answers `{ checked, problems }` |
| `POST /v1/sheets/setup` | Give every project a data note, take folders from descriptions, sync the spreadsheets; answers `{ created, folders }` |

A project in a listing also carries `status` (a preset id, the value as written when no preset names it, or null), `types` (ids) and `tags` (the project note's own, without `#`). The project data note is kept in step with its spreadsheet; a write through the API reaches the spreadsheet like an edit in Obsidian.

Fields a client may write: `title`, `description`, `type` (`task`, `milestone`, `subtask`), `status`, `priority`, `start`, `due` (`YYYY-MM-DD` or empty), `progress` (0 to 100), `assignees`, `tags`, `dependencies` (task ids), `recurrence` (`{ interval, every, endDate? }` or null), `timeEstimate` (hours or null), `customFields` (an object keyed by field id).

A new project goes in the projects folder from settings, or inside its parent's folder when `parentId` is given. It starts with the global statuses and priorities; its palettes, custom fields and other settings are changed in Obsidian.

Every task also carries `id`, `projectId`, `parentId`, `position` (its index among siblings), `path`, `archived`, `completed`, `timeLogs`, `createdAt` and `updatedAt`. Ids are stable for the life of a task. Paths change when a task is renamed or archived. A new task's note is named after its title, with a number appended when a note of that name is already there, so two tasks may share a title.

Errors come back as `{ "error": { "code", "message" } }`:

| Status | Code |
| --- | --- |
| 400 | `invalid` |
| 401 | `unauthorized` |
| 404 | `not_found` |
| 412 | `conflict` |

## Change feed

`GET /v1/changes` without `since` returns the current cursor and nothing else. Polling with that cursor returns everything that changed after it, oldest first, plus a new `cursor` for the next poll. Each entry is `{ seq, at, kind, op: "upsert" | "delete", id, projectId }`. `kind` is `project` or `task` with the id of one, or `data`, `participants`, `meeting` or `timesheet` for a project file, with the note's path as `id`.

The server keeps about the last thousand changes. A response with `reset: true` means the cursor is older than that. List what you need again instead of applying changes.

The feed covers projects loaded during this Obsidian session: any project a client has read through the API and any project open in a view. A project nobody has opened yet is not tracked until it is.

## Limits

- Desktop only. The mobile app has no server to run.
- Only this computer can connect. There is no option to bind another interface.
- One token, shared by every client.
- Task bodies are loaded when a task is first read, so the first read of a large project is slower than the rest.
