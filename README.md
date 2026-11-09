# dotpm (Revamped)

> **Private revamp.** This is a personal rewrite of [dotpm](https://github.com/dotpm/obsidian-pm) by
> [Stepan Kropachev](https://github.com/StepanKropachev) and the [dotpm contributors](https://github.com/dotpm/obsidian-pm/graphs/contributors), maintained by [axelcypher](https://github.com/axelcypher)
> for my own use. It is not published in the Obsidian community plugin directory.
> All credit for the original plugin goes to its authors. Please report issues with this
> version here, not upstream.

**Project management inside Obsidian. Table, Gantt timeline and Kanban board views over plain Markdown notes.**

## What's different in this revamp

- **Project statuses:** a project can be put in a status preset such as *Active*, *Planned*, *On hold* or *Done*. The status is switched with quick actions: the status chip in the project list, the project's context menu, and the chip next to the title on the project overview.
- **Colored project list:** a project in a status is tinted in the preset's color, with a stripe down the row; sub-projects on a project overview get the same highlight.
- **Status order:** the project list puts projects in the order of the presets (projects without a status last) and applies its own sort within each status. Sub-projects are ordered the same way under their parent. Can be turned off in the settings.
- **Group by status:** the project list's *Group* menu has a *Status* option with one group per preset.
- **Predefined presets:** *Settings → Project statuses* holds the presets with name, color, icon and order (drag to reorder). The order of the presets is the order of the list.
- **Plain Markdown:** the status is a property of the project note (`status` by default, configurable), for example `status: active`. A hand-typed preset name such as `status: Active` is recognized too. A preset's id follows its name until a project uses it, so new presets get readable values.
- **Project types:** say what a project is about, such as *New build*, *Conversion*, *Extension*, *Existing building* or *Listed building* (in German *Neubau*, *Umbau*, *Anbau*, *Bauen im Bestand*, *Denkmal*). A project can have several. They are toggled from the type column of the project list and from the project overview, and kept as a list in the project note (`projectType` by default, configurable), for example `projectType: [umbau, denkmal]`. Types only label a project: they don't tint or reorder the list. The presets live in *Settings → Project types*.
- **Tags column:** the project list can show the project note's own tags as a column.
- **More columns:** status, type and tags are columns of the project list that the *Fields* menu shows, hides and reorders like the others.
- **Project files:** each project keeps a folder of meeting notes, a participants note, a project data note and a timesheet in its own folder. The project overview shows the meetings as running text between description and milestones, and the data, participants and booked hours in its side column.
- **Project data in Excel:** each project's data note is kept in step with a spreadsheet (`.xlsx`) both ways, in the project folder outside the vault (for example on a network drive) or beside the note.
- **Local API and MCP:** everything the revamp adds can be read and changed over HTTP and MCP too: project status, types and tags; project data; participants, meetings and timesheet entries (add, change, remove); the presets; and the spreadsheet sync. See [docs/api.md](docs/api.md).
- **Quick time entries:** *Log time* (command, project overview, project context menu) books date, hours, person and activity into the project's timesheet in one dialog.
- **Plugin identity:** own plugin ID `axlc-dotpm-revamped` and name *dotpm (Revamped)*.
- **Release workflow:** streamlined build & release workflow shared with my other revamps (upstream CI, CodeQL, package publishing and issue templates were removed). Builds run with pnpm on Node 24, also on Windows.

## Installation

- **Revamp Manager:** installed and updated automatically by my [Revamp Manager](https://github.com/axelcypher/obsidian-revamp-manager).
- **Manual:** download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/axelcypher/obsidian-dotpm/releases/latest) into `<vault>/.obsidian/plugins/axlc-dotpm-revamped/`, then reload Obsidian and enable *dotpm (Revamped)*.
- **BRAT:** choose **Add beta plugin** and enter `axelcypher/obsidian-dotpm`.

Needs Obsidian 1.13 or newer. Works on desktop and mobile.

**Coming from the original dotpm?** The new ID makes this a separate plugin for Obsidian. Disable *dotpm*, copy `data.json` from `.obsidian/plugins/project-manager/` to `.obsidian/plugins/axlc-dotpm-revamped/`, enable *dotpm (Revamped)* and remove the original. Projects and tasks are notes and need no migration.

## Project statuses

1. Open **Settings → dotpm (Revamped) → Project statuses** and adjust the presets: name, color, icon, order.
2. In the project list, click a project's status chip (or right-click the project) and pick a status.
3. The row takes the status color and moves to its place in the list.

Under the same heading you choose the note property the status is kept in and whether the list is ordered by status. Changing the property reads statuses from the new property; values already written under the old one stay where they are.

## Project types

1. Open **Settings → dotpm (Revamped) → Project types** and adjust the presets: name, color, icon, order.
2. In the project list, click a project's type chip (or *No type*) and tick a type. Each pick adds or removes one type; open the menu again for the next one. *Remove all types* clears them.
3. On a project overview, the types are the first row under *Properties* and open the same menu.

Status and types need different properties. Types written by hand as text, such as `projectType: Umbau, Denkmal`, are read too and become a list on the next change.

## Columns of the project list

**Fields** in the header of the project list shows, hides and reorders the columns: *Status*, *Type*, *Progress*, *Tasks*, *Members*, *Due* and *Tags*. The tags column shows the project note's own `tags`, the first three as chips and the rest as a count.

## Project files

Each project keeps these notes in its own folder, next to its note and its `_tasks/` folder. They are created when first needed, from the project overview or a command; their names are set in *Settings → Project files*.

```
Projects/
  Website relaunch/
    Website relaunch.md      the project note
    _tasks/                  one note per task
    Meetings/                one note per meeting, named "2026-11-09 Meeting"
    Participants.md          table: Name | Role | Company | Email | Phone
    Project data.md          properties: client, plot, zoning plan …
    Timesheet.md             table: Date | Hours | Booked by | Activity
```

In a German vault the defaults are `Abgleiche/`, `Projektbeteiligte`, `Projektdaten` and `Stundenzettel`.

- **Meetings:** *New meeting* (command, `+` in the overview's *Meetings* section, project context menu) asks for a title and creates `<today> <title>.md`. The overview renders every meeting note, newest first: the latest one open, older ones folded under their date and title.
- **Participants:** a Markdown table, matched to its columns by the headings (*Name, Role, Company, Email, Phone*, also in German). The overview's side column only counts them; *Show all* (also a command and in the project context menu) opens a searchable window with everyone's role, company, email and phone.
- **Project data:** the note's properties, flat and plain YAML, so other programs can read them, for example `grundstueck-flurstueck: 123/4`. *Settings → Project files → Project data fields* sets the fields with group, label and property name; the overview shows the filled ones grouped in that order as a compact two-column list, and properties no field names under *Other details*. Long values fold after three lines and open on a click. A new data note starts with every field as an empty property, to fill in from the properties panel.
- **Timesheet:** a Markdown table with one row per entry. *Log time* adds a row (date, hours as `1,5`, `1.5` or `1:30`, who, what); the person is remembered for the next entry. The overview shows the total, the hours per person and the latest entries. Rows can also be edited by hand.

### Project data in Excel

Each project's data note has a spreadsheet twin, `Project data.xlsx` (in German `Projektdaten.xlsx`), kept in step both ways:

- **Where:** in the project's folder outside the vault when the data note names one in `projektordner` (for example `Z:\Projekte\HVO Vogelsang`), otherwise beside the data note in the vault. Folders outside the vault need the desktop app.
- **Sheets:** *Project data* is formatted for reading: each group as a grey band with its name in column A, then one row per field with the label in bold (B), the key (C) and the value (D), in Arial, the project folder first and empty fields included. This is the sheet that is read back, by the key in column C. *Mail merge* has the keys as headings over one row of values, for Word mail merges and other programs.
- **Sync:** a change to the data note writes the spreadsheet a moment later. A change saved in Excel comes into the note when Obsidian starts, gets the focus back, every five minutes, and when the project's overview opens. When both changed since the last sync, the newer file wins. A spreadsheet that is open in Excel can't be written; the overview says so, and it syncs once Excel has closed it.
- **Setting up:** *Create project data and spreadsheets for all projects* gives every project a data note and takes the project folder from a `Projektordner:` line of its description (a `file:///` link or a plain path). New projects get their data note when they are created.
- The overview's *Project data* section shows the project folder (click to open it) and opens the spreadsheet with the sheet button. *Settings → Project files* turns the sync off and names the folder property.

## About dotpm

<img width="1422" alt="dotpm dashboard" src="https://github.com/user-attachments/assets/ca6bc67f-e656-45be-b93a-17410555ec1a" />

Project tools keep the plan in one app and the thinking about it in another. dotpm keeps both in the vault. A project is a note, a task is a note, and the table, the timeline and the board are three ways of looking at the same files.

- Scheduling, not checkboxes. Tasks have start and due dates, dependencies drawn as arrows, and a Gantt timeline that moves dependents when a blocker slips.
- Tasks are full notes. Each has a body, backlinks, tags and properties, so search, the graph, templates and Dataview all work on them.
- Agents and scripts can work the board. A local HTTP and MCP server and a command line client edit the same notes the views do, so a coding agent can pick up a task, update it and close it.
- Nothing to sign up for. Projects sync with whatever already syncs the vault, and a project folder can be diffed and reviewed in git like any other code.
- Runs on desktop and mobile, and any view exports to one HTML file that opens without Obsidian.

### Quick start

1. Click the timeline icon in the ribbon, or run **dotpm (Revamped): Open projects pane**.
2. Click **New project**, give it a name, and open it.
3. Click **Add task**. Set a status, a due date, an assignee, whatever you need.
4. Switch between **Table**, **Timeline** and **Board** from the last part of the path at the top of the view.
5. Look in your vault. There is a `Projects/Your project.md` note and a `Projects/Your project_tasks/` folder with one note per task.

Already have notes you want as tasks? Run **dotpm (Revamped): Import notes as tasks**. To turn an existing note into a project, add `pm-project: true` to its properties and run **dotpm (Revamped): Open current file as project**.

## Views

### Table

Rows sort, filter and edit inline. A multi-row selection changes status, priority, assignee, tags, due date or parent for all of them at once. A filter and sort combination can be saved as a named view.

<video src="https://github.com/user-attachments/assets/104bd993-d4c1-42e7-9d6a-ae46fd7ce6a8" autoplay loop muted playsinline width="600"></video>

### Timeline

Dragging a bar reschedules the task, dragging its edge changes the duration, and dragging from one bar to another adds a dependency. The scale zooms from days to years and is kept per view. Milestones are diamonds and a line marks today.

<video src="https://github.com/user-attachments/assets/916f7100-44ef-401c-abb3-e003a0f7720a" autoplay loop muted playsinline width="600"></video>

### Board

One column per status, or per priority, assignee, tag, type or custom field. Dragging a card to another column changes that value, and columns can be reordered or hidden. Cards show priority, assignees, tags and due date.

<video src="https://github.com/user-attachments/assets/316fc43b-6915-499a-a6ad-0680c462d014" autoplay loop muted playsinline width="600"></video>

## Features

**Tasks**

- Subtasks to any depth
- Dependencies, within a project or across projects, and milestones
- Start and due dates, progress, assignees, tags
- Recurring tasks
- Time estimates and time logs
- Custom fields: text, number, date, select, multi-select, person, checkbox, URL
- A Markdown body on every task

**Planning**

- Auto-scheduling: dependents move when a blocker moves
- Due date reminders
- Archive, by hand or automatically after a set number of days
- Undo and redo

**Organizing**

- Sub-projects, with an overview page per project: progress, milestones, sub-projects, properties
- One view over a project, its subtree, a folder, the whole vault, or projects picked by hand
- Archive a project that is done or no longer relevant; its sub-projects go with it
- Filters on any field, custom fields included: is, is not, contains, between, date buckets and ranges
- Saved views: named filter and sort combinations, one of them starred as the view a project opens with
- Sort by up to three keys in the table and on the board
- Bulk edit from the table
- A project list you can search, filter by progress or tag, sort, group by folder or tag, and save views of
- People notes for assignees, with a per-person task list and an avatar color set by the note's `color` property

**Customizing**

- Statuses and priorities with label, color and icon, global or per project
- Project statuses with label, color, icon and order, switched from the project list (revamp)
- Project types, several per project, toggled from the project list (revamp)
- Meeting notes, participants, project data and a timesheet per project, shown on its overview (revamp)
- Per-project overrides for default view, scheduling and archiving
- Team members, global and per project

## File format

A task looks like this. Open it in Obsidian, edit it in any text editor, or diff it in git.

```yaml
---
pm-task: true
projectId: '[[Website redesign]]'
title: 'Write the launch post'
type: 'task'
status: 'in-progress'
priority: 'high'
start: '2026-09-01'
due: '2026-09-20'
progress: 40
assignees: ['[[Alice]]']
tags: ['marketing']
dependencies: ['[[Design the homepage]]']
---
Draft, review with the team, publish on launch day.
```

Sync works the way it does for any other note. Obsidian Sync, iCloud, Syncthing and git all carry projects along. Two people editing the same task at the same moment produce an ordinary sync conflict, and there is no real-time collaboration beyond that.

## Outside Obsidian

**Share a view.** **dotpm (Revamped): Export current view as HTML** writes the open table, timeline or board to a single file that opens in any browser, with the tasks, the filter and the icons inside it.

**Local API and MCP.** Turn on **Settings > Local API** and the desktop app serves the vault's projects on `127.0.0.1` with a bearer token. Scripts use plain HTTP; coding agents connect over the Model Context Protocol:

```sh
claude mcp add --transport http dotpm http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"
```

**Command line.** `npm install -g @dotpm/cli` installs the `dotpm` command. Run inside the vault folder, it finds the server on its own.

```sh
dotpm projects
dotpm create <projectId> --title "Write the release notes" --due 2026-09-20
dotpm search release --status todo
```

Everything a client changes goes through the same code the views use and shows up in Obsidian at once. See [docs/api.md](docs/api.md) and [docs/cli.md](docs/cli.md).

**TaskNotes.** dotpm imports TaskNotes tasks with their dates, dependencies and hierarchy, and can share statuses and priorities with it. See [docs/tasknotes.md](docs/tasknotes.md).

## Development

The repo is a pnpm workspace on Node 24. `pnpm dev` builds into the vault named by `VAULT_PATH`; `pnpm check` and `pnpm test` run the linters, the type check and the tests. Releases are built by `.github/workflows/release.yml` when a version tag is pushed.

## License

[MIT](LICENSE)
