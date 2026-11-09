import { FileSystemAdapter, Notice, Platform, TFile } from 'obsidian'
import type PMPlugin from '#main'
import {
  type ProjectDataRow,
  changedValues,
  projectDataHash,
  projectDataRows,
  projectFolderFromText,
  rowValues,
  sheetSyncAction,
  t,
  tn
} from '@dotpm/core'
import {
  readProjectDataWorkbook,
  writeProjectDataWorkbook,
  type ProjectDataSheetLabels
} from '../integrations/projectDataXlsx'

type NodeFs = typeof import('node:fs')
type NodePath = typeof import('node:path')
type Electron = { shell: { openPath(path: string): Promise<string> } }

/** Node and Electron exist only in the desktop app; on mobile the sheet stays inside the vault. */
function desktopModule<T>(id: string): T | null {
  if (!Platform.isDesktopApp) return null
  const nodeRequire = (window as Window & { require?: (id: string) => unknown }).require
  return nodeRequire ? (nodeRequire(id) as T) : null
}

/** Where a project's spreadsheet is: in its folder outside the vault, or beside its data note. */
type SheetLocation = { external: true; path: string; folder: string } | { external: false; path: string }

export interface SheetStatus {
  ok: boolean
  message: string
}

/** A data note being typed in saves every few seconds; one write covers a burst of them. */
const WRITE_DELAY_MS = 1500
/** Excel saves without telling anyone, so every sheet is looked at this often. */
const FULL_SYNC_INTERVAL_MS = 5 * 60_000
/** Coming back to Obsidian checks every sheet, but not on every flick between windows. */
const FOCUS_THROTTLE_MS = 10_000

function errorCode(e: unknown): string {
  return typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string' ? e.code : ''
}

/**
 * Keeps each project's data note and its spreadsheet in step, both ways. The note is
 * watched through Obsidian; the sheet, often on a network drive, is looked at on start,
 * whenever Obsidian gets the focus back, every few minutes, and when an overview opens.
 */
export class ProjectDataSync {
  private timers = new Map<string, number>()
  private queues = new Map<string, Promise<void>>()
  private statuses = new Map<string, SheetStatus>()
  private statusHandlers = new Set<(projectPath: string) => void>()
  private lastFocusSync = 0

  constructor(private plugin: PMPlugin) {}

  register(): void {
    const { plugin } = this
    plugin.registerEvent(
      plugin.app.metadataCache.on('changed', (file) => {
        const project = this.projectOfDataNote(file.path)
        if (project) this.schedule(project)
      })
    )
    plugin.registerDomEvent(window, 'focus', () => {
      if (Date.now() - this.lastFocusSync < FOCUS_THROTTLE_MS) return
      this.lastFocusSync = Date.now()
      void this.syncAll()
    })
    plugin.registerInterval(
      window.setInterval(() => {
        void this.syncAll()
      }, FULL_SYNC_INTERVAL_MS)
    )
    plugin.register(() => {
      for (const timer of this.timers.values()) window.clearTimeout(timer)
      this.timers.clear()
    })
  }

  onStatusChange(handler: (projectPath: string) => void): () => void {
    this.statusHandlers.add(handler)
    return () => this.statusHandlers.delete(handler)
  }

  status(projectPath: string): SheetStatus | undefined {
    return this.statuses.get(projectPath)
  }

  /** The folder outside the vault the data note names, or empty. */
  externalFolder(projectPath: string): string {
    const note = this.plugin.projectFiles.file(projectPath, 'data')
    const raw: unknown = note
      ? this.plugin.app.metadataCache.getFileCache(note)?.frontmatter?.[this.plugin.settings.projectFolderProperty]
      : undefined
    return typeof raw === 'string' ? raw.trim() : ''
  }

  location(projectPath: string): SheetLocation | null {
    const files = this.plugin.projectFiles
    const folder = this.externalFolder(projectPath)
    if (folder) {
      const path = desktopModule<NodePath>('path')
      return path ? { external: true, folder, path: path.join(folder, files.sheetName()) } : null
    }
    return { external: false, path: files.path(projectPath, 'data').replace(/\.md$/, '.xlsx') }
  }

  /** Checks every project with a data note, one after another. */
  async syncAll(): Promise<void> {
    if (!this.plugin.settings.projectDataSheetSync) return
    for (const ref of this.plugin.index.projectRefs(true)) {
      if (this.plugin.projectFiles.file(ref.path, 'data')) await this.sync(ref.path)
    }
  }

  /** Syncs one project, after any sync of it still running. */
  sync(projectPath: string): Promise<void> {
    const previous = this.queues.get(projectPath) ?? Promise.resolve()
    const next = previous.then(() => this.syncNow(projectPath)).catch((e: unknown) => this.fail(projectPath, e))
    this.queues.set(projectPath, next)
    void next.finally(() => {
      if (this.queues.get(projectPath) === next) this.queues.delete(projectPath)
    })
    return next
  }

  /** Opens the spreadsheet in the program the system opens .xlsx files with. */
  async openSheet(projectPath: string): Promise<void> {
    if (!this.plugin.projectFiles.file(projectPath, 'data')) await this.plugin.projectFiles.ensure(projectPath, 'data')
    await this.sync(projectPath)
    const location = this.location(projectPath)
    if (location) await this.openPath(location.external ? location.path : this.vaultFullPath(location.path))
  }

  /** Opens the project folder outside the vault in the file manager. */
  async openFolder(projectPath: string): Promise<void> {
    const folder = this.externalFolder(projectPath)
    if (folder) await this.openPath(folder)
  }

  /**
   * Gives every project a data note, taking the project folder from a "Projektordner:"
   * line of its description where the note has none yet, then syncs every sheet.
   */
  async setUpAllProjects(): Promise<void> {
    const { plugin } = this
    const key = plugin.settings.projectFolderProperty
    let created = 0
    let folders = 0
    for (const ref of plugin.index.projectRefs(true)) {
      if (!plugin.projectFiles.file(ref.path, 'data')) created++
      const note = await plugin.projectFiles.ensure(ref.path, 'data')
      if (this.externalFolder(ref.path)) continue
      const projectNote = plugin.app.vault.getAbstractFileByPath(ref.path)
      if (!(projectNote instanceof TFile)) continue
      const folder = projectFolderFromText(await plugin.app.vault.cachedRead(projectNote))
      if (!folder) continue
      await plugin.app.fileManager.processFrontMatter(note, (frontmatter: Record<string, unknown>) => {
        frontmatter[key] = folder
      })
      folders++
    }
    plugin.showNotice(
      t('sheet.setUpDone', { created: tn('sheet.notes', created), folders: tn('sheet.folders', folders) }),
      6000
    )
    // The notes just written reach the metadata cache a moment later.
    window.setTimeout(() => {
      void this.syncAll()
    }, WRITE_DELAY_MS)
  }

  private projectOfDataNote(path: string): string | null {
    const files = this.plugin.projectFiles
    if (!files.isDataNoteName(path)) return null
    return this.plugin.index.projectRefs(true).find((ref) => files.path(ref.path, 'data') === path)?.path ?? null
  }

  private schedule(projectPath: string): void {
    const pending = this.timers.get(projectPath)
    if (pending !== undefined) window.clearTimeout(pending)
    this.timers.set(
      projectPath,
      window.setTimeout(() => {
        this.timers.delete(projectPath)
        void this.sync(projectPath)
      }, WRITE_DELAY_MS)
    )
  }

  private rows(frontmatter: Record<string, unknown>): ProjectDataRow[] {
    const { settings } = this.plugin
    return projectDataRows(
      settings.projectDataFields,
      frontmatter,
      { key: settings.projectFolderProperty, label: t('sheet.folderLabel'), group: t('sheet.folderGroup') },
      t('projectData.more')
    )
  }

  private labels(): ProjectDataSheetLabels {
    return {
      sheet: t('sheet.name'),
      mailMerge: t('sheet.mailMerge'),
      group: t('sheet.group'),
      label: t('sheet.label'),
      key: t('sheet.key'),
      value: t('sheet.value')
    }
  }

  private async syncNow(projectPath: string): Promise<void> {
    const { plugin } = this
    if (!plugin.settings.projectDataSheetSync) return
    const note = plugin.projectFiles.file(projectPath, 'data')
    const location = this.location(projectPath)
    if (!note || !location) return
    if (location.external && !(await this.exists(location.folder))) {
      this.setStatus(projectPath, { ok: false, message: t('sheet.folderMissing', { folder: location.folder }) })
      return
    }
    const rows = this.rows(plugin.app.metadataCache.getFileCache(note)?.frontmatter ?? {})
    const noteValues = rowValues(rows)
    const noteHash = projectDataHash(noteValues)
    const sheetMtime = await this.mtime(location)
    const state = plugin.settings.projectDataSheets[projectPath]
    const action = sheetSyncAction({ state, path: location.path, noteHash, noteMtime: note.stat.mtime, sheetMtime })

    if (action === 'write-sheet') {
      await this.write(location, writeProjectDataWorkbook(rows, this.labels()))
      await this.saveState(projectPath, {
        path: location.path,
        mtime: (await this.mtime(location)) ?? Date.now(),
        hash: noteHash
      })
      if (state && state.path !== location.path) await this.dropVaultCopy(state.path)
    } else if (action === 'read-sheet' && sheetMtime !== null) {
      const changes = changedValues(noteValues, readProjectDataWorkbook(await this.read(location), this.labels()))
      let hash = noteHash
      if (Object.keys(changes).length) {
        await plugin.app.fileManager.processFrontMatter(note, (frontmatter: Record<string, unknown>) => {
          Object.assign(frontmatter, changes)
          // What the note will hold once saved, so its change event finds nothing left to write.
          hash = projectDataHash(rowValues(this.rows(frontmatter)))
        })
      }
      await this.saveState(projectPath, { path: location.path, mtime: sheetMtime, hash })
    }
    this.setStatus(projectPath, { ok: true, message: '' })
  }

  /** A sheet the plugin wrote into the vault before the project got a folder outside it. */
  private async dropVaultCopy(path: string): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path)
    if (file instanceof TFile && file.extension === 'xlsx') await this.plugin.app.fileManager.trashFile(file)
  }

  private async saveState(projectPath: string, state: { path: string; mtime: number; hash: string }): Promise<void> {
    this.plugin.settings.projectDataSheets[projectPath] = state
    await this.plugin.saveSettings()
  }

  private setStatus(projectPath: string, status: SheetStatus): void {
    const previous = this.statuses.get(projectPath)
    this.statuses.set(projectPath, status)
    if (previous?.ok === status.ok && previous.message === status.message) return
    for (const handler of this.statusHandlers) handler(projectPath)
  }

  /** A sheet open in Excel can't be written; that settles itself once it is closed. */
  private fail(projectPath: string, e: unknown): void {
    const code = errorCode(e)
    const locked = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
    const message = locked
      ? t('sheet.locked')
      : t('sheet.failed', { error: e instanceof Error ? e.message : String(e) })
    const wasOk = this.statuses.get(projectPath)?.ok !== false
    this.setStatus(projectPath, { ok: false, message })
    if (wasOk) new Notice(`${this.plugin.index.projectRef(projectPath)?.title ?? projectPath}: ${message}`)
    if (!locked) console.error('[PM] Project data sheet sync failed:', e)
  }

  private fs(): NodeFs['promises'] {
    const fs = desktopModule<NodeFs>('fs')
    if (!fs) throw new Error(t('sheet.desktopOnly'))
    return fs.promises
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await this.fs().stat(path)
      return true
    } catch {
      return false
    }
  }

  private async mtime(location: SheetLocation): Promise<number | null> {
    if (!location.external) return (await this.plugin.app.vault.adapter.stat(location.path))?.mtime ?? null
    try {
      return (await this.fs().stat(location.path)).mtimeMs
    } catch (e) {
      if (errorCode(e) === 'ENOENT') return null
      throw e
    }
  }

  private async read(location: SheetLocation): Promise<ArrayBuffer | Uint8Array> {
    if (!location.external) return this.plugin.app.vault.adapter.readBinary(location.path)
    return this.fs().readFile(location.path)
  }

  private async write(location: SheetLocation, data: Uint8Array): Promise<void> {
    if (location.external) {
      await this.fs().writeFile(location.path, data)
      return
    }
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    await this.plugin.app.vault.adapter.writeBinary(location.path, buffer)
  }

  private vaultFullPath(path: string): string {
    const adapter = this.plugin.app.vault.adapter
    return adapter instanceof FileSystemAdapter ? adapter.getFullPath(path) : path
  }

  private async openPath(path: string): Promise<void> {
    const electron = desktopModule<Electron>('electron')
    if (!electron) {
      this.plugin.showNotice(t('sheet.desktopOnly'))
      return
    }
    const error = await electron.shell.openPath(path)
    if (error) this.plugin.showNotice(error)
  }
}
