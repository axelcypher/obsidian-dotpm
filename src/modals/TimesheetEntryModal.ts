import { type App, ButtonComponent, Modal } from 'obsidian'
import { type TimesheetEntry, parseHours, parsePlainDate, t, today } from '@dotpm/core'

export interface TimesheetEntryOpts {
  projectTitle: string
  /** Who the entry is booked for unless changed. */
  person: string
  /** Names offered while typing who booked the time. */
  people: string[]
  onSubmit: (entry: TimesheetEntry) => Promise<void>
}

/** Date, hours, who and what, then Enter: a timesheet entry in one go. */
export class TimesheetEntryModal extends Modal {
  private busy = false

  constructor(
    app: App,
    private opts: TimesheetEntryOpts
  ) {
    super(app)
  }

  onOpen(): void {
    const { contentEl } = this
    this.modalEl.addClass('pm-prompt-modal', 'pm-timesheet-modal')
    this.titleEl.setText(t('timesheet.modalTitle', { project: this.opts.projectTitle }))

    const form = contentEl.createDiv('pm-timesheet-form')
    const field = (label: string, input: HTMLInputElement): HTMLInputElement => {
      const row = form.createEl('label', { cls: 'pm-timesheet-field' })
      row.createSpan({ cls: 'pm-timesheet-label', text: label })
      row.appendChild(input)
      input.addClass('pm-prompt-input')
      return input
    }

    const date = field(t('timesheet.date'), createEl('input', { type: 'date' }))
    date.value = today().toString()
    const hours = field(
      t('timesheet.hours'),
      createEl('input', { type: 'text', attr: { inputmode: 'decimal', placeholder: '1,5' } })
    )
    const listId = `pm-timesheet-people-${Date.now()}`
    const person = field(t('timesheet.person'), createEl('input', { type: 'text', attr: { list: listId } }))
    person.value = this.opts.person
    const people = form.createEl('datalist', { attr: { id: listId } })
    for (const name of this.opts.people) people.createEl('option', { attr: { value: name } })
    const activity = field(
      t('timesheet.activity'),
      createEl('input', { type: 'text', attr: { placeholder: t('timesheet.activityPlaceholder') } })
    )

    const error = contentEl.createDiv('pm-timesheet-error')
    const buttons = contentEl.createDiv('pm-modal-btn-row')
    new ButtonComponent(buttons).setButtonText(t('common.cancel')).onClick(() => this.close())

    const submit = async (): Promise<void> => {
      if (this.busy) return
      const value = parseHours(hours.value)
      if (value === null || value <= 0) {
        error.setText(t('timesheet.invalidHours'))
        hours.focus()
        return
      }
      this.busy = true
      try {
        await this.opts.onSubmit({
          date: parsePlainDate(date.value)?.toString() ?? today().toString(),
          hours: value,
          person: person.value.trim(),
          activity: activity.value.trim()
        })
        this.close()
      } finally {
        this.busy = false
      }
    }
    new ButtonComponent(buttons)
      .setButtonText(t('common.ok'))
      .setCta()
      .onClick(() => {
        void submit()
      })
    contentEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault()
        void submit()
      }
    })
    window.setTimeout(() => hours.focus(), 0)
  }

  onClose(): void {
    this.contentEl.empty()
  }
}
