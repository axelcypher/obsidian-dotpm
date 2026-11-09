import { MarkdownView, Notice, Platform, Plugin, TFile, WorkspaceLeaf, type ViewState } from 'obsidian'
import {
  DEFAULT_PALETTE_COLOR,
  DEFAULT_SETTINGS,
  defaultPriorities,
  defaultProjectDataFields,
  defaultProjectFileNames,
  defaultProjectStatuses,
  defaultProjectTypes,
  defaultStatuses,
  makeDefaultFilter,
  makeDefaultGroup,
  makeDefaultSort,
  hydrateFilter,
  hydrateSort,
  legacyBoardFields,
  type PMSettings,
  type Project,
  type Task,
  flattenTasks,
  dedupePeople,
  displayName,
  localApiPortFor,
  formatHours,
  locale,
  parseParticipants,
  projectLabelValues,
  projectStatusProperty,
  projectTypeProperty,
  readColor,
  toggleProjectLabel,
  compareVersions,
  releaseNotesSince,
  setDateFormat,
  t,
  tn
} from '@dotpm/core'
import {
  matchPersonNotes,
  personLink,
  ProjectStore,
  scopeKey,
  VaultIndex,
  type ProjectRef,
  type TaskSource
} from './store'
import { tokenMatches } from '@dotpm/api'
import { safeAsync } from '@dotpm/ui'
import { around } from 'monkey-around'
import { installObsidianPlatform } from './platform'
import { PMSettingTab } from './settings'
import { ProjectView, PM_PROJECT_VIEW_TYPE } from './views/ProjectView'
import { ProjectOverviewView, PM_PROJECT_OVERVIEW_VIEW_TYPE } from './views/ProjectOverviewView'
import { ProjectEditView, PM_PROJECT_EDIT_VIEW_TYPE } from './views/ProjectEditView'
import { DashboardView, PM_DASHBOARD_VIEW_TYPE } from './views/DashboardView'
import { TaskView, PM_TASK_VIEW_TYPE } from './views/TaskView'
import { RELEASES, ReleaseNotesView, PM_RELEASE_NOTES_VIEW_TYPE } from './views/ReleaseNotesView'
import { registerStyleguide } from './views/styleguide/StyleguideView'
import { PMViewRouter } from './views/PMViewRouter'
import {
  openTaskModal,
  openProjectCreate,
  openPersonLookup,
  openProjectPicker,
  openTaskPicker,
  openImportModal,
  confirmDialog,
  promptText
} from './ui/ModalFactory'
import { Notifier } from './components/Notifier'
import { AutoArchiver } from './components/AutoArchiver'
import { IdRepair } from './components/IdRepair'
import { ProjectFiles, type ProjectFileKind } from './components/ProjectFiles'
import { ProjectDataSync } from './components/ProjectDataSync'
import { TimesheetEntryModal } from './modals/TimesheetEntryModal'
import { ParticipantsModal } from './modals/ParticipantsModal'
import { migrateBoardCardConfig, migrateProjects, migrateProjectLayout, migrateTaskRefs } from './migration'
import { LocalApi } from './api/LocalApi'
import { exportViewAsHtml } from './export/exportView'
import { generateToken, LocalApiServer } from './api/LocalApiServer'

export default class PMPlugin extends Plugin {
  settings: PMSettings = { ...DEFAULT_SETTINGS }
  store!: TaskSource
  index!: VaultIndex
  notifier!: Notifier
  autoArchiver!: AutoArchiver
  idRepair!: IdRepair
  router!: PMViewRouter
  projectFiles!: ProjectFiles
  projectDataSync!: ProjectDataSync
  localApi!: LocalApiServer
  /** Leaves sent to the markdown editor for a note, which the swap leaves alone while they show it. */
  private markdownEscapes = new WeakMap<WorkspaceLeaf, string>()
  private viewRefreshScheduled = false
  undoStack: Array<{ undo: () => Promise<void>; redo: () => Promise<void> }> = []
  redoStack: Array<{ undo: () => Promise<void>; redo: () => Promise<void> }> = []

  pushUndo(entry: { undo: () => Promise<void>; redo: () => Promise<void> }): void {
    this.undoStack.push(entry)
    if (this.undoStack.length > 20) this.undoStack.shift()
    this.redoStack = []
  }

  async undoLastAction(): Promise<void> {
    const entry = this.undoStack.pop()
    if (entry) {
      await entry.undo()
      this.redoStack.push(entry)
    }
  }

  async redoLastAction(): Promise<void> {
    const entry = this.redoStack.pop()
    if (entry) {
      await entry.redo()
      this.undoStack.push(entry)
    }
  }

  async onload(): Promise<void> {
    installObsidianPlatform()
    await this.loadSettings()
    setDateFormat(this.settings.dateFormat)
    this.index = new VaultIndex(this.app, () => this.settings)
    // The first sweep can run against a half-filled metadata cache, so it runs again once
    // the index has caught up. Everything in it is safe to repeat.
    this.index.register(this, () => {
      void this.startupSweep()
      // Sheets changed while Obsidian was closed come in once every project is known.
      void this.projectDataSync.syncAll()
    })
    this.store = new ProjectStore(this.app, () => this.settings, this.index)
    this.store.registerVaultSync(this)
    this.notifier = new Notifier(this)
    this.autoArchiver = new AutoArchiver(this)
    this.idRepair = new IdRepair(this)
    this.router = new PMViewRouter(this)
    this.projectFiles = new ProjectFiles(this.app, () => this.settings)
    this.projectDataSync = new ProjectDataSync(this)
    this.projectDataSync.register()
    const api = new LocalApi(this)
    this.register(api.attach())
    this.localApi = new LocalApiServer(
      {
        info: { name: 'dotpm', version: this.manifest.version },
        authorize: (token) => (tokenMatches(token, this.settings.localApiToken) ? api : null)
      },
      () => this.settings.localApiPort
    )

    this.registerView(PM_PROJECT_VIEW_TYPE, (leaf) => new ProjectView(leaf, this))
    this.registerView(PM_PROJECT_OVERVIEW_VIEW_TYPE, (leaf) => new ProjectOverviewView(leaf, this))
    this.registerView(PM_PROJECT_EDIT_VIEW_TYPE, (leaf) => new ProjectEditView(leaf, this))
    this.registerView(PM_DASHBOARD_VIEW_TYPE, (leaf) => new DashboardView(leaf, this))
    this.registerView(PM_TASK_VIEW_TYPE, (leaf) => new TaskView(leaf, this))
    this.registerView(PM_RELEASE_NOTES_VIEW_TYPE, (leaf) => new ReleaseNotesView(leaf, this))
    this.registerNoteSwap()
    if (__STYLEGUIDE__) registerStyleguide(this)

    this.app.workspace.onLayoutReady(
      safeAsync(async () => {
        await this.openReleaseNotesAfterUpdate()
        this.index.build()
        await this.startupSweep()
        await this.syncLocalApi()
      })
    )

    this.addRibbonIcon('chart-gantt', t('ribbon.openProjects'), async () => {
      await this.router.openDashboard()
    })

    this.addCommand({
      id: 'open-projects',
      name: t('commands.openProjects'),
      callback: () => {
        void this.router.openDashboard()
      }
    })

    this.addCommand({
      id: 'show-release-notes',
      name: t('commands.showReleaseNotes'),
      callback: () => {
        void this.router.openReleaseNotes()
      }
    })

    this.addCommand({
      id: 'new-project',
      name: t('commands.newProject'),
      callback: () => {
        openProjectCreate(this)
      }
    })

    this.addCommand({
      id: 'new-task',
      name: t('commands.newTask'),
      callback: () => {
        this.pickProjectThenCreateTask(null)
      }
    })

    this.addCommand({
      id: 'new-subtask',
      name: t('commands.newSubtask'),
      callback: () => {
        this.pickProjectThenCreateTask('pick-parent')
      }
    })

    this.addCommand({
      id: 'new-meeting',
      name: t('commands.newMeeting'),
      callback: () => this.withProjectPath(safeAsync((path: string) => this.newMeetingFlow(path)))
    })

    this.addCommand({
      id: 'log-time',
      name: t('commands.logTime'),
      callback: () => this.withProjectPath((path) => this.logTimeFlow(path))
    })

    this.addCommand({
      id: 'set-up-project-data',
      name: t('commands.setUpProjectData'),
      callback: safeAsync(() => this.projectDataSync.setUpAllProjects())
    })

    this.addCommand({
      id: 'sync-project-sheets',
      name: t('commands.syncProjectSheets'),
      callback: safeAsync(async () => {
        await this.projectDataSync.syncAll()
        this.showNotice(t('sheet.syncDone'))
      })
    })

    this.addCommand({
      id: 'show-participants',
      name: t('commands.showParticipants'),
      callback: () => this.withProjectPath(safeAsync((path: string) => this.showParticipants(path)))
    })

    this.addCommand({
      id: 'duplicate-project',
      name: t('commands.duplicateProject'),
      callback: () => {
        this.pickProject(
          safeAsync((project) => this.duplicateProjectFlow(project)),
          false
        )
      }
    })

    this.addCommand({
      id: 'undo-last-action',
      name: t('commands.undo'),
      callback: () => {
        void this.undoLastAction()
      }
    })

    this.addCommand({
      id: 'redo-last-action',
      name: t('commands.redo'),
      callback: () => {
        void this.redoLastAction()
      }
    })

    this.addCommand({
      id: 'open-all-projects',
      name: t('commands.openAllProjects'),
      callback: () => {
        void this.router.openScope({ kind: 'vault' })
      }
    })

    this.addCommand({
      id: 'rebuild-project-index',
      name: t('commands.rebuildIndex'),
      callback: () => {
        this.index.build()
        this.showNotice(tn('commands.rebuildIndexDone', this.index.projectRefs(true).length))
      }
    })

    this.addCommand({
      id: 'archive-completed-tasks',
      name: t('commands.archiveCompleted'),
      callback: () => {
        void this.archiveCompletedTasks()
      }
    })

    this.addCommand({
      id: 'import-notes-as-tasks',
      name: t('commands.importNotes'),
      callback: () => {
        this.importNotes()
      }
    })

    this.addCommand({
      id: 'create-task-from-selection',
      name: t('commands.taskFromSelection'),
      editorCheckCallback: (checking, editor) => {
        const selection = editor.getSelection().trim()
        if (!selection) return false
        if (checking) return true
        this.createTaskFromText(selection)
        return true
      }
    })

    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor) => {
        const selection = editor.getSelection().trim()
        if (!selection) return
        menu.addItem((item) =>
          item
            .setTitle(t('commands.taskFromSelection'))
            .setIcon('list-plus')
            .onClick(() => this.createTaskFromText(selection))
        )
      })
    )

    this.addCommand({
      id: 'export-view-html',
      name: t('commands.exportViewHtml'),
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(ProjectView)
        if (!view?.projectScope?.primary) return false
        if (checking) return true
        safeAsync(async () => {
          await exportViewAsHtml(this, view)
        })()
        return true
      }
    })

    this.addCommand({
      id: 'open-current-as-project',
      name: t('commands.openCurrentAsProject'),
      checkCallback: (checking: boolean) => {
        const md = this.app.workspace.getActiveViewOfType(MarkdownView)
        const file = md?.file
        if (!file) return false
        const cache = this.app.metadataCache.getFileCache(file)
        if (cache?.frontmatter?.['pm-project'] !== true) return false
        if (checking) return true
        void this.router.openProjectLink(file.path, md.leaf)
        return true
      }
    })

    this.addCommand({
      id: 'person-tasks',
      name: t('commands.personTasks'),
      callback: () => {
        openPersonLookup(
          this,
          this.index.allAssignees(),
          safeAsync((value) => this.showTasksForPerson(value))
        )
      }
    })

    this.addCommand({
      id: 'person-tasks-this-note',
      name: t('commands.personTasksThisNote'),
      checkCallback: (checking: boolean) => {
        const md = this.app.workspace.getActiveViewOfType(MarkdownView)
        const file = md?.file
        if (!file) return false
        const cache = this.app.metadataCache.getFileCache(file)
        if (cache?.frontmatter?.['pm-task'] === true || cache?.frontmatter?.['pm-project'] === true) return false
        if (checking) return true
        void this.showTasksForPerson(personLink(this.app, file, ''))
        return true
      }
    })

    this.addCommand({
      id: 'link-people-to-notes',
      name: t('commands.linkPeople'),
      callback: () => {
        void this.linkPeopleToNotes()
      }
    })

    this.addSettingTab(new PMSettingTab(this.app, this))
    this.notifier.start()
    this.autoArchiver.start()
    this.idRepair.start()
  }

  onunload(): void {
    this.notifier.stop()
    void this.localApi.stop()
  }

  /** Brings the local API in line with the settings. Mobile has nothing to run. */
  async syncLocalApi(): Promise<void> {
    if (!Platform.isDesktopApp) return
    if (!this.settings.localApiEnabled) {
      await this.localApi.stop()
      return
    }
    try {
      await this.localApi.restart()
    } catch (err: unknown) {
      console.error('[PM] local API failed to start', err)
      new Notice(t('localApi.listenFailed', { port: this.settings.localApiPort }))
    }
  }

  /** Records the running version, and after an update opens the notes for every release since the last run. */
  private async openReleaseNotesAfterUpdate(): Promise<void> {
    const previous = this.settings.lastSeenVersion
    const current = this.manifest.version
    if (previous === current) return
    this.settings.lastSeenVersion = current
    await this.saveSettings()
    if (!this.settings.showReleaseNotes || (previous && compareVersions(previous, current) > 0)) return
    if (releaseNotesSince(RELEASES, current, previous).length === 0) return
    await this.router.openReleaseNotes(previous)
  }

  /** Opens a note in Obsidian's own editor, in a new tab unless given a leaf, where the swap leaves it alone. */
  async openAsMarkdown(path: string, leaf?: WorkspaceLeaf): Promise<void> {
    const file = this.app.vault.getFileByPath(path)
    if (!file) return
    const target = leaf ?? this.app.workspace.getLeaf('tab')
    this.markdownEscapes.set(target, path)
    await target.openFile(file)
  }

  /** Opens project notes, and task notes when tasks open in a tab, in our views before a markdown view is built. */
  private registerNoteSwap(): void {
    const swapped = (leaf: WorkspaceLeaf, viewState: ViewState): ViewState => this.swappedViewState(leaf, viewState)
    this.register(
      around(WorkspaceLeaf.prototype, {
        setViewState: (next) =>
          function (this: WorkspaceLeaf, viewState: ViewState, eState?: unknown) {
            return next.call(this, swapped(this, viewState), eState)
          }
      })
    )
  }

  private swappedViewState(leaf: WorkspaceLeaf, viewState: ViewState): ViewState {
    const path = viewState.state?.file
    if (viewState.type !== 'markdown' || typeof path !== 'string') return viewState
    const escaped = this.markdownEscapes.get(leaf)
    if (escaped === path) return viewState
    if (escaped) this.markdownEscapes.delete(leaf)
    const file = this.app.vault.getFileByPath(path)
    const frontmatter = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined
    if (this.settings.taskEditorSurface === 'tab' && frontmatter?.['pm-task'] === true) {
      return { ...viewState, type: PM_TASK_VIEW_TYPE, state: { filePath: path } }
    }
    if (frontmatter?.['pm-project'] === true) return { ...viewState, ...this.router.projectLinkViewState(path) }
    return viewState
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<PMSettings> | null
    // Cloned: a shallow merge would hand the live settings the very arrays and objects
    // DEFAULT_SETTINGS holds, and the first edit would write into the defaults.
    this.settings = Object.assign(structuredClone(DEFAULT_SETTINGS), saved ?? {})
    if (!saved?.statuses?.length) this.settings.statuses = defaultStatuses()
    if (!saved?.priorities?.length) this.settings.priorities = defaultPriorities()
    // Unlike task statuses, a vault may clear its project statuses on purpose.
    if (!Array.isArray(saved?.projectStatuses)) this.settings.projectStatuses = defaultProjectStatuses()
    if (!Array.isArray(saved?.projectTypes)) this.settings.projectTypes = defaultProjectTypes()
    if (!Array.isArray(saved?.projectDataFields)) this.settings.projectDataFields = defaultProjectDataFields()
    // File names a vault never set start in its language and then stay, so notes keep being found.
    for (const [key, name] of Object.entries(defaultProjectFileNames()) as [
      keyof ReturnType<typeof defaultProjectFileNames>,
      string
    ][]) {
      if (typeof saved?.[key] !== 'string') this.settings[key] = name
    }
    if (!this.settings.projectFilters) this.settings.projectFilters = {}
    if (!this.settings.scopeViews) this.settings.scopeViews = {}
    if (!this.settings.collapsedTasks) this.settings.collapsedTasks = {}
    if (!this.settings.collapsedProjects) this.settings.collapsedProjects = []
    if (!this.settings.excludedFolders) this.settings.excludedFolders = []

    let migrated = false
    // Filters were keyed by project path before a view could cover several projects.
    for (const key of Object.keys(this.settings.projectFilters)) {
      if (key.includes(':')) continue
      this.settings.projectFilters[`project:${key}`] = this.settings.projectFilters[key]
      Reflect.deleteProperty(this.settings.projectFilters, key)
      migrated = true
    }

    // Sort was held by the table alone and had one key, the timeline scale was one setting
    // for every view, a filter was a fixed set of facets before it became conditions, and
    // what a board card shows was two settings.
    const legacyBoard = (saved ?? {}) as { kanbanShowSubtasks?: boolean; kanbanShowDescriptionPreview?: boolean }
    const legacyBoardKeys = ['kanbanShowSubtasks', 'kanbanShowDescriptionPreview']
    if (legacyBoardKeys.some((key) => key in this.settings)) {
      this.settings.defaultFields = legacyBoardFields(
        !!legacyBoard.kanbanShowSubtasks,
        !!legacyBoard.kanbanShowDescriptionPreview
      )
      for (const key of legacyBoardKeys) Reflect.deleteProperty(this.settings, key)
      migrated = true
    }
    for (const entry of Object.values(this.settings.projectFilters)) {
      if (!Array.isArray(entry.filter.conditions)) {
        entry.filter = hydrateFilter(entry.filter)
        migrated = true
      }
      if (!Array.isArray(entry.sort)) {
        entry.sort = hydrateSort(entry as unknown as Record<string, unknown>)
        Reflect.deleteProperty(entry, 'sortKey')
        Reflect.deleteProperty(entry, 'sortDir')
        migrated = true
      }
      if (!entry.group) {
        entry.group = makeDefaultGroup()
        migrated = true
      }
      if (!entry.fields) {
        entry.fields = structuredClone(this.settings.defaultFields)
        migrated = true
      }
      if (!entry.ganttGranularity) {
        entry.ganttGranularity = this.settings.ganttGranularity
        migrated = true
      }
      if (!entry.nonWorkingDays) {
        entry.nonWorkingDays = {}
        migrated = true
      }
    }

    for (const view of Object.values(this.settings.scopeViews).flat()) {
      if (!Array.isArray(view.filter.conditions)) {
        view.filter = hydrateFilter(view.filter)
        migrated = true
      }
      if (!Array.isArray(view.sort)) {
        view.sort = hydrateSort(view as unknown as Record<string, unknown>)
        Reflect.deleteProperty(view, 'sortKey')
        Reflect.deleteProperty(view, 'sortDir')
        migrated = true
      }
    }

    for (const s of this.settings.statuses) {
      if (s.complete === undefined) {
        s.complete = s.id === 'done' || s.id === 'cancelled'
        migrated = true
      }
    }

    for (const entry of [...this.settings.statuses, ...this.settings.priorities]) {
      const color = readColor(entry.color) ?? DEFAULT_PALETTE_COLOR
      if (color === entry.color) continue
      entry.color = color
      migrated = true
    }

    // ganttHideDone was a global toggle, now expressed as a per-project status filter.
    const legacy = (saved ?? {}) as { ganttHideDone?: boolean }
    if (legacy.ganttHideDone === true) {
      const nonTerminal = this.settings.statuses.filter((s) => !s.complete).map((s) => s.id)
      for (const entry of Object.values(this.settings.projectFilters)) {
        if (!entry.filter.conditions.some((condition) => condition.field === 'status')) {
          entry.filter.conditions.push({ field: 'status', op: 'any', value: nonTerminal })
        }
      }
      migrated = true
    }

    if (saved?.localApiPort === undefined) {
      this.settings.localApiPort = localApiPortFor(this.app.vault.getName())
      migrated = true
    }

    if (!this.settings.localApiToken) {
      this.settings.localApiToken = generateToken()
      migrated = true
    }

    // A fresh install has no update to announce.
    if (!saved) {
      this.settings.lastSeenVersion = this.manifest.version
      migrated = true
    }

    if (migrated) await this.saveSettings()
  }

  /**
   * A scope key is `vault`, or a kind and a path. Only the path-bearing ones can go
   * stale, and a key that names no path at all is kept rather than guessed at.
   */
  private scopeKeyResolves(key: string): boolean {
    const separator = key.indexOf(':')
    if (separator === -1) return true
    return key
      .slice(separator + 1)
      .split('|')
      .every((path) => path === '' || this.app.vault.getAbstractFileByPath(path) !== null)
  }

  /** Flags the note; sub-projects follow it without a write of their own. */
  async setProjectArchived(path: string, archived: boolean): Promise<void> {
    const project = await this.store.loadProjectByPath(path)
    if (!project) return
    await this.store.updateProject(project, { archived: archived || undefined })
    this.showNotice(t(archived ? 'project.archived' : 'project.unarchived', { title: project.title }))
  }

  /**
   * Writes the status into the project note's properties, or removes it for null. The index
   * picks the change up from the note like any other edit, and every list follows.
   */
  async setProjectStatus(path: string, status: string | null): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) return
    const key = projectStatusProperty(this.settings)
    await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      if (status) frontmatter[key] = status
      else Reflect.deleteProperty(frontmatter, key)
    })
  }

  /** Adds the type to the project note's types, or takes it out when the note already has it. */
  async toggleProjectType(path: string, id: string): Promise<void> {
    await this.writeProjectTypes(path, (values) => toggleProjectLabel(this.settings.projectTypes, values, id))
  }

  async clearProjectTypes(path: string): Promise<void> {
    await this.writeProjectTypes(path, () => [])
  }

  /** Replaces the project note's types with the ids given. */
  async setProjectTypes(path: string, ids: string[]): Promise<void> {
    await this.writeProjectTypes(path, () => ids)
  }

  /** Works on the note's current values rather than the index's, so two quick toggles both land. */
  private async writeProjectTypes(path: string, change: (values: string[]) => string[]): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) return
    const key = projectTypeProperty(this.settings)
    await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      const next = change(projectLabelValues(frontmatter[key]))
      if (next.length) frontmatter[key] = next
      else Reflect.deleteProperty(frontmatter, key)
    })
  }

  /** Asks for a title, creates the note for today's meeting in the project's folder, and opens it. */
  async newMeetingFlow(projectPath: string): Promise<void> {
    const title = await promptText(this.app, t('meetings.titlePrompt'), '', t('meetings.defaultTitle'))
    if (!title) return
    const file = await this.projectFiles.createMeeting(projectPath, title)
    await this.app.workspace.getLeaf('tab').openFile(file)
  }

  /** Opens the form for a timesheet entry and books it into the project's timesheet. */
  logTimeFlow(projectPath: string): void {
    const ref = this.index.projectRef(projectPath)
    const people = dedupePeople(
      [...this.settings.globalTeamMembers, ...(ref?.teamMembers ?? [])].map(displayName).filter(Boolean),
      (name) => name.toLowerCase()
    )
    new TimesheetEntryModal(this.app, {
      projectTitle: ref?.title ?? projectPath,
      person: this.settings.timesheetPerson,
      people,
      onSubmit: async (entry) => {
        await this.projectFiles.addTimesheetEntry(projectPath, entry)
        if (entry.person && entry.person !== this.settings.timesheetPerson) {
          this.settings.timesheetPerson = entry.person
          await this.saveSettings()
        }
        this.showNotice(
          t('timesheet.logged', { hours: formatHours(entry.hours, locale()), project: ref?.title ?? projectPath })
        )
      }
    }).open()
  }

  /** Lists the project's participants in a window, read from its participants note. */
  async showParticipants(projectPath: string): Promise<void> {
    const file = this.projectFiles.file(projectPath, 'participants')
    const participants = file ? parseParticipants(await this.app.vault.cachedRead(file)) : []
    new ParticipantsModal(this.app, {
      projectTitle: this.index.projectRef(projectPath)?.title ?? projectPath,
      participants,
      hasNote: !!file,
      onEdit: () => this.openProjectFile(projectPath, 'participants')
    }).open()
  }

  /** Opens one of the project's files in a new tab, creating it from its template first if needed. */
  async openProjectFile(projectPath: string, kind: ProjectFileKind): Promise<void> {
    const file = await this.projectFiles.ensure(projectPath, kind)
    await this.app.workspace.getLeaf('tab').openFile(file)
  }

  /**
   * The project a command acts on: the one the active tab shows or a note of it is open
   * in, and failing that one picked from the list.
   */
  private withProjectPath(onChoose: (path: string) => void): void {
    const active = this.activeProjectPath()
    if (active) {
      onChoose(active)
      return
    }
    const refs = this.index.projectRefs()
    if (!refs.length) {
      this.showNotice(this.index.ready ? t('picker.noProjects') : t('picker.indexing'))
      return
    }
    openProjectPicker(this, refs, (ref) => onChoose(ref.path))
  }

  private activeProjectPath(): string | null {
    const { workspace } = this.app
    const shown =
      workspace.getActiveViewOfType(ProjectOverviewView)?.getState().filePath ??
      workspace.getActiveViewOfType(ProjectEditView)?.getState().filePath ??
      workspace.getActiveViewOfType(ProjectView)?.project?.filePath
    if (shown) return shown
    const file = workspace.getActiveFile()
    if (!file) return null
    const refs = this.index.projectRefs(true)
    const owner =
      refs.find((ref) => ref.path === file.path) ??
      refs.find((ref) => file.path.startsWith(`${this.projectFiles.folder(ref.path)}/`))
    return owner?.path ?? null
  }

  /** Prompts for a title, copies the project with fresh task ids, and opens the copy. */
  async duplicateProjectFlow(source: Project): Promise<void> {
    const title = await promptText(
      this.app,
      t('project.duplicatePrompt', { title: source.title }),
      t('project.namePlaceholder'),
      t('project.duplicateDefaultTitle', { title: source.title })
    )
    if (!title) return
    let copy: Project
    try {
      copy = await this.store.duplicateProject(source, title)
    } catch (e) {
      this.showNotice(e instanceof Error ? e.message : String(e))
      return
    }
    await this.router.openProjectOverview(copy.filePath)
  }

  /** A project with no window of its own archives everything it has finished. */
  private async archiveCompletedTasks(): Promise<void> {
    const scoped = this.app.workspace.getActiveViewOfType(ProjectView)?.projectScope?.projects.map((p) => p.filePath)
    const plans = await this.autoArchiver.plan(scoped?.length ? scoped : this.index.projectPaths(), true)
    const tasks = plans.reduce((sum, plan) => sum + plan.tasks, 0)
    if (!tasks) {
      this.showNotice(t('archive.nothingReady'))
      return
    }
    const ok = await confirmDialog(
      this.app,
      tn('archive.confirm', tasks, { projects: tn('count.projects', plans.length) }),
      t('archive.confirmButton')
    )
    if (!ok) return
    await this.autoArchiver.apply(plans)
    this.showNotice(tn('archive.done', tasks))
  }

  /** The startup work that reads the index: migration, pruning, and the first due and archive sweeps. */
  private async startupSweep(): Promise<void> {
    await migrateProjects(this)
    await migrateProjectLayout(this)
    await migrateTaskRefs(this)
    await migrateBoardCardConfig(this)
    await this.idRepair.check()
    await this.cleanupStaleProjectFilters()
    this.notifier.check()
    await this.autoArchiver.check()
  }

  async cleanupStaleProjectFilters(): Promise<void> {
    const filters = this.settings.projectFilters
    const cleaned: typeof filters = {}
    let dirty = false
    for (const [key, entry] of Object.entries(filters)) {
      if (this.scopeKeyResolves(key)) {
        cleaned[key] = entry
      } else {
        dirty = true
      }
    }
    const cleanedScopeViews: typeof this.settings.scopeViews = {}
    for (const [key, views] of Object.entries(this.settings.scopeViews)) {
      if (this.scopeKeyResolves(key)) {
        cleanedScopeViews[key] = views
      } else {
        dirty = true
      }
    }
    const cleanedCollapsed: typeof this.settings.collapsedTasks = {}
    for (const [path, ids] of Object.entries(this.settings.collapsedTasks)) {
      if (!this.app.vault.getAbstractFileByPath(path)) {
        dirty = true
        continue
      }
      // Only a project the index has tasks for can show that a collapsed id is gone.
      const known = this.index.taskRefs(path)
      if (!known.length) {
        cleanedCollapsed[path] = ids
        continue
      }
      const live = new Set(known.map((ref) => ref.id))
      const kept = ids.filter((id) => live.has(id))
      if (kept.length !== ids.length) dirty = true
      cleanedCollapsed[path] = kept
    }
    const collapsedProjects = this.settings.collapsedProjects.filter((path) =>
      this.app.vault.getAbstractFileByPath(path)
    )
    if (collapsedProjects.length !== this.settings.collapsedProjects.length) dirty = true
    if (dirty) {
      this.settings.projectFilters = cleaned
      this.settings.scopeViews = cleanedScopeViews
      this.settings.collapsedTasks = cleanedCollapsed
      this.settings.collapsedProjects = collapsedProjects
      await this.saveSettings()
    }
  }

  isProjectCollapsed(path: string): boolean {
    return this.settings.collapsedProjects.includes(path)
  }

  async toggleProjectCollapsed(path: string): Promise<void> {
    const collapsed = this.settings.collapsedProjects
    const at = collapsed.indexOf(path)
    if (at === -1) collapsed.push(path)
    else collapsed.splice(at, 1)
    await this.saveSettings()
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }

  showNotice(msg: string, duration = 3000): void {
    new Notice(msg, duration)
  }

  /**
   * A settings edit changed a palette or how a view draws itself. Nothing in the vault
   * moved, so the store's own change events say nothing about it. Coalesced, because a
   * list editor persists on every keystroke.
   */
  refreshViews(): void {
    if (this.viewRefreshScheduled) return
    this.viewRefreshScheduled = true
    window.setTimeout(() => {
      this.viewRefreshScheduled = false
      for (const leaf of this.app.workspace.getLeavesOfType(PM_PROJECT_VIEW_TYPE)) {
        if (leaf.view instanceof ProjectView) leaf.view.redraw()
      }
      for (const leaf of this.app.workspace.getLeavesOfType(PM_DASHBOARD_VIEW_TYPE)) {
        if (leaf.view instanceof DashboardView) leaf.view.render()
      }
    }, 0)
  }

  /**
   * Offers every project in the vault, loading only the one chosen. `autoSelectSingle`
   * skips a picker that would have exactly one entry.
   */
  private pickProject(onChoose: (project: Project) => void, autoSelectSingle: boolean): void {
    const refs = this.index.projectRefs()
    if (!refs.length) {
      this.showNotice(this.index.ready ? t('picker.noProjects') : t('picker.indexing'))
      return
    }
    const choose = (ref: ProjectRef): void => {
      void (async () => {
        const project = await this.store.loadProjectByPath(ref.path)
        if (!project) {
          this.showNotice(t('picker.openFailed', { title: ref.title }))
          return
        }
        onChoose(project)
      })()
    }
    if (autoSelectSingle && refs.length === 1) choose(refs[0])
    else openProjectPicker(this, refs, choose)
  }

  /**
   * Rewrites plain-text assignees and members as links to the notes of the same name, so
   * existing vaults get the graph edges without retyping every task. Names matching no note,
   * or more than one, are left alone and reported.
   */
  private async linkPeopleToNotes(): Promise<void> {
    const plain: string[] = []
    for (const ref of this.index.allTaskRefs()) plain.push(...ref.assignees)
    for (const ref of this.index.projectRefs(true)) plain.push(...ref.teamMembers)
    const names = dedupePeople(plain.filter((value) => !value.trim().startsWith('[[')))
    if (names.length === 0) {
      this.showNotice(t('linkPeople.allLinked'))
      return
    }

    const matches = matchPersonNotes(this.app, this.settings.peopleFolder, names)
    const linkable = matches.filter((match) => match.link !== null)
    const ambiguous = matches.filter((match) => match.ambiguous)
    if (linkable.length === 0) {
      this.showNotice(tn('linkPeople.noMatches', names.length))
      return
    }

    const linkFor = new Map<string, string>()
    for (const match of linkable) if (match.link) linkFor.set(match.name.trim().toLowerCase(), match.link)
    const mapValue = (value: string): string =>
      value.trim().startsWith('[[') ? value : (linkFor.get(value.trim().toLowerCase()) ?? value)

    const preview = linkable
      .slice(0, 5)
      .map((match) => match.name)
      .join(', ')
    const listed = linkable.length > 5 ? tn('linkPeople.namesMore', linkable.length - 5, { names: preview }) : preview
    const question = tn('linkPeople.confirm', linkable.length, { names: listed })
    const warn = ambiguous.length ? ` ${tn('linkPeople.ambiguous', ambiguous.length)}` : ''
    const ok = await confirmDialog(this.app, question + warn, t('linkPeople.confirmButton'))
    if (!ok) return

    let tasksChanged = 0
    let projectsChanged = 0
    const byProject = new Map<string, string[]>()
    for (const ref of this.index.allTaskRefs()) {
      if (!ref.projectPath) continue
      if (!ref.assignees.some((value) => linkFor.has(value.trim().toLowerCase()))) continue
      const bucket = byProject.get(ref.projectPath)
      if (bucket) bucket.push(ref.id)
      else byProject.set(ref.projectPath, [ref.id])
    }

    for (const [path, taskIds] of byProject) {
      const project = await this.store.loadProjectByPath(path)
      if (!project) continue
      await this.store.updateTasks(project, taskIds, (task) => ({ assignees: task.assignees.map(mapValue) }))
      tasksChanged += taskIds.length
    }

    for (const ref of this.index.projectRefs(true)) {
      if (!ref.teamMembers.some((value) => linkFor.has(value.trim().toLowerCase()))) continue
      const project = await this.store.loadProjectByPath(ref.path)
      if (!project) continue
      await this.store.updateProject(project, { teamMembers: project.teamMembers.map(mapValue) })
      projectsChanged++
    }

    this.refreshViews()
    this.showNotice(
      t('linkPeople.done', { tasks: tn('count.tasks', tasksChanged), projects: tn('count.projects', projectsChanged) })
    )
  }

  /** Opens the whole vault filtered to one person, the way the assignee filter would. */
  private async showTasksForPerson(person: string): Promise<void> {
    const name = displayName(person)
    if (this.index.tasksForPerson(person).length === 0) {
      new Notice(t('personTasks.none', { name }))
      return
    }
    this.settings.projectFilters[scopeKey({ kind: 'vault' })] = {
      filter: { ...makeDefaultFilter(), conditions: [{ field: 'assignee', op: 'any', value: [person] }] },
      activeSavedViewId: null,
      sort: makeDefaultSort(),
      group: makeDefaultGroup(),
      fields: structuredClone(this.settings.defaultFields),
      ganttGranularity: this.settings.ganttGranularity,
      nonWorkingDays: {}
    }
    await this.saveSettings()
    await this.router.openScope({ kind: 'vault' })
  }

  /** Picks a project, then a parent when creating a subtask, before opening the editor. */
  private pickProjectThenCreateTask(mode: null | 'pick-parent'): void {
    this.pickProject((project) => {
      if (mode === 'pick-parent') {
        const flat = flattenTasks(project.tasks)
        if (!flat.length) {
          this.showNotice(t('picker.noTasks'))
          return
        }
        openTaskPicker(
          this,
          flat.map((f) => f.task),
          (parentTask) => {
            this.openTaskModalForProject(project, parentTask.id)
          }
        )
      } else {
        this.openTaskModalForProject(project, null)
      }
    }, false)
  }

  private openTaskModalForProject(project: Project, parentId: string | null, defaults?: Partial<Task>): void {
    openTaskModal(this, project, {
      parentId,
      defaults,
      onSave: async () => {
        await this.store.saveProject(project)
        await this.router.openProjectByPath(project.filePath)
      }
    })
  }

  /** Open the task modal pre-filled from selected text, targeting a chosen project. */
  private createTaskFromText(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return

    const newlineIdx = trimmed.indexOf('\n')
    const defaults: Partial<Task> =
      newlineIdx === -1
        ? { title: trimmed }
        : { title: trimmed.slice(0, newlineIdx).trim(), description: trimmed.slice(newlineIdx + 1).trim() }

    this.pickProject((project) => {
      this.openTaskModalForProject(project, null, defaults)
    }, true)
  }

  private importNotes(): void {
    const activeLeaves = this.app.workspace.getLeavesOfType(PM_PROJECT_VIEW_TYPE)
    let activeProject: Project | null = null

    for (const leaf of activeLeaves) {
      if (!(leaf.view instanceof ProjectView)) continue
      if (leaf.view.project) {
        activeProject = leaf.view.project
        break
      }
    }

    if (activeProject) {
      const project = activeProject
      const onImportComplete = async () => {
        await this.router.openProjectByPath(project.filePath)
      }
      openImportModal(this, activeProject, onImportComplete)
      return
    }

    this.pickProject((project) => {
      const onImportComplete = async () => {
        await this.router.openProjectByPath(project.filePath)
      }
      openImportModal(this, project, onImportComplete)
    }, false)
  }
}
