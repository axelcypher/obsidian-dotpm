import { type App, ButtonComponent, Modal } from 'obsidian'
import { type Participant, filterParticipants, t } from '@dotpm/core'

export interface ParticipantsModalOpts {
  projectTitle: string
  participants: Participant[]
  /** Whether the project has a participants note yet, which decides the button's label. */
  hasNote: boolean
  /** Opens the participants note, creating it when the project has none. */
  onEdit: () => Promise<void>
}

/** Everyone on a project with role, company and how to reach them, searchable. */
export class ParticipantsModal extends Modal {
  constructor(
    app: App,
    private opts: ParticipantsModalOpts
  ) {
    super(app)
  }

  onOpen(): void {
    const { contentEl, opts } = this
    this.modalEl.addClass('pm-participants-modal')
    this.titleEl.setText(t('participants.modalTitle', { project: opts.projectTitle }))

    const search = contentEl.createEl('input', {
      type: 'search',
      cls: 'pm-prompt-input pm-participants-search',
      attr: { placeholder: t('participants.search'), 'aria-label': t('participants.search') }
    })
    if (opts.participants.length < 2) search.hide()
    const list = contentEl.createDiv('pm-participants-table')
    const draw = (): void => {
      list.empty()
      const shown = filterParticipants(opts.participants, search.value)
      if (!opts.participants.length || !shown.length) {
        list.createDiv({
          cls: 'pm-overview-muted',
          text: opts.participants.length ? t('participants.noMatch') : t('participants.empty')
        })
        return
      }
      const head = list.createDiv('pm-participants-row pm-participants-head')
      for (const key of ['name', 'role', 'company', 'email', 'phone'] as const) {
        head.createSpan({ text: t(`participants.${key}`) })
      }
      for (const person of shown) this.renderRow(list, person)
    }
    search.addEventListener('input', draw)
    draw()

    const buttons = contentEl.createDiv('pm-modal-btn-row')
    new ButtonComponent(buttons)
      .setButtonText(opts.hasNote ? t('projectFiles.edit') : t('participants.create'))
      .onClick(async () => {
        this.close()
        await opts.onEdit()
      })
    new ButtonComponent(buttons)
      .setButtonText(t('common.close'))
      .setCta()
      .onClick(() => this.close())
    if (search.isShown()) window.setTimeout(() => search.focus(), 0)
  }

  private renderRow(list: HTMLElement, person: Participant): void {
    const row = list.createDiv('pm-participants-row')
    row.createSpan({ cls: 'pm-participant-name', text: person.name })
    row.createSpan({ cls: 'pm-participant-role', text: person.role })
    row.createSpan({ cls: 'pm-participant-company', text: person.company })
    const email = row.createSpan({ cls: 'pm-participant-email' })
    if (person.email) email.createEl('a', { text: person.email, href: `mailto:${person.email}` })
    const phone = row.createSpan({ cls: 'pm-participant-phone' })
    if (person.phone) phone.createEl('a', { text: person.phone, href: `tel:${person.phone.replace(/[^\d+]/g, '')}` })
  }

  onClose(): void {
    this.contentEl.empty()
  }
}
