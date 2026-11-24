// The Environment dialog: where query variables come from (every .env from the workspace root
// down, or one chosen file), what they set (values masked until revealed), what the dbt profile
// reads with env_var() and whether it is set, and a form that saves into the env file.
import type { EnvState } from '../src/protocol'
import { button, el, errorMessage, fill, sectionHead } from './dom'
import { icon } from './icons'

/** The source select's values that are not a file. */
const EVERY_ENV = ''
const OTHER_FILE = '\u0000other'

export class EnvView {
  private state: EnvState | null = null
  private error: string | null = null
  private revealed = new Set<string>()
  /** A delete waits for a second click. */
  private confirmingDelete: string | null = null
  private draft = { key: '', value: '' }

  constructor(
    private readonly dialog: HTMLDialogElement,
    private readonly changed: (state: EnvState) => void
  ) {
    dialog.addEventListener('close', () => (this.confirmingDelete = null))
    // A click on the backdrop closes it.
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close()
    })
  }

  /** Opens the dialog, ready to add `key` when given (a variable dbt said was missing). */
  async open(key = ''): Promise<void> {
    this.draft = { key, value: '' }
    this.error = null
    if (!this.dialog.open) this.dialog.showModal()
    this.render()
    await this.run(() => orca.plugin.request('env.read'))
    this.dialog.querySelector<HTMLInputElement>(key ? '#env-value' : '#env-key')?.focus()
  }

  /** Runs a request that answers the new state, then redraws. */
  private async run(request: () => Promise<EnvState>): Promise<void> {
    try {
      this.state = await request()
      this.error = null
      this.changed(this.state)
    } catch (cause) {
      this.error = errorMessage(cause)
    }
    this.render()
  }

  private render(): void {
    const state = this.state
    const head = el(
      'header',
      { class: 'dialog-head' },
      el('div', {}, el('h2', {}, 'Query environment'), el('p', {}, "Variables dbt runs with, on top of Orca's own environment (Orca's win on a clash). profiles.yml reads them with env_var().")),
      button('', () => this.dialog.close(), { variant: 'ghost', icon: 'close', title: 'Close (Esc)' })
    )
    if (!state) {
      fill(this.dialog, head, el('div', { class: 'dialog-body' }, el('p', { class: 'pane-note' }, this.error ?? 'Reading…')))
      return
    }
    const setInFiles = new Map(state.vars.map((entry) => [entry.key, entry]))
    fill(
      this.dialog,
      head,
      el(
        'div',
        { class: 'dialog-body' },
        this.sourcePicker(state),
        el(
          'p',
          { class: 'pane-note' },
          state.files.length > 0 ? `Reading ${state.files.join(', ')}. ` : 'No env file yet. ',
          'Saving to ',
          el('code', {}, state.target),
          '.'
        ),
        this.error ? el('div', { class: 'callout danger' }, icon('alert', 14), el('pre', {}, this.error)) : null,
        state.required.length > 0 ? this.requiredList(state) : null,
        el(
          'section',
          { class: 'block' },
          sectionHead('Variables', state.vars.length),
          state.vars.length > 0
            ? el('div', { class: 'table-wrap' }, el('table', { class: 'env-table' }, el('tbody', {}, ...state.vars.map((entry) => this.varRow(entry.key, entry.value, entry.file)))))
            : el('p', { class: 'pane-note' }, 'None yet.')
        )
      ),
      this.form(setInFiles.has(this.draft.key))
    )
  }

  private sourcePicker(state: EnvState): HTMLElement {
    const select = el('select', { title: 'Where variables come from' }, new Option('Every .env from the workspace root down to the project', EVERY_ENV))
    for (const file of state.candidates) select.append(new Option(file, file))
    if (state.configured && !state.candidates.includes(state.configured)) select.append(new Option(state.configured, state.configured))
    select.append(new Option('Another file…', OTHER_FILE))
    select.value = state.configured
    const path = el('input', { type: 'text', title: 'Path, relative to the workspace root or absolute', hidden: true }) as HTMLInputElement
    path.placeholder = 'secrets/prod.env'
    const choose = (file: string) => void this.run(() => orca.plugin.request('env.choose', { file }))
    const use = button('Use', () => path.value.trim() && choose(path.value.trim()), { variant: 'primary', small: true })
    use.hidden = true
    select.addEventListener('change', () => {
      const other = select.value === OTHER_FILE
      path.hidden = use.hidden = !other
      if (other) path.focus()
      else choose(select.value)
    })
    path.addEventListener('keydown', (event) => event.key === 'Enter' && path.value.trim() && choose(path.value.trim()))
    return el('div', { class: 'field' }, el('label', {}, 'Read variables from'), el('div', { class: 'field-row' }, select, path, use))
  }

  private requiredList(state: EnvState): HTMLElement {
    return el(
      'section',
      { class: 'block' },
      sectionHead(`Profile ${state.profile || '?'} reads`, state.required.length),
      state.profilesFile ? el('p', { class: 'pane-note' }, `From ${state.profilesFile} and dbt_project.yml.`) : null,
      el(
        'ul',
        { class: 'env-required' },
        ...state.required.map((entry) => {
          const status =
            entry.setBy === 'file'
              ? el('span', { class: 'pill status-pass' }, 'set')
              : entry.setBy === 'orca'
                ? el('span', { class: 'pill status-pass', title: "Set in Orca's own environment" }, 'set by Orca')
                : entry.hasDefault
                  ? el('span', { class: 'pill', title: 'env_var() gives a default' }, 'default')
                  : el('span', { class: 'pill status-fail' }, 'missing')
          const add = entry.setBy
            ? null
            : button('Set', () => {
                this.draft = { key: entry.key, value: '' }
                this.render()
                this.dialog.querySelector<HTMLInputElement>('#env-value')?.focus()
              }, { small: true, variant: 'ghost', icon: 'plus' })
          return el('li', {}, el('code', {}, entry.key), el('span', { class: 'spacer' }), status, add)
        })
      )
    )
  }

  private varRow(key: string, value: string, file: string): HTMLTableRowElement {
    const shown = this.revealed.has(key)
    const reveal = button('', () => {
      if (shown) this.revealed.delete(key)
      else this.revealed.add(key)
      this.render()
    }, { variant: 'ghost', small: true, icon: shown ? 'eyeOff' : 'eye', title: shown ? 'Hide the value' : 'Show the value' })
    const edit = button('', () => {
      this.draft = { key, value }
      this.render()
      this.dialog.querySelector<HTMLInputElement>('#env-value')?.focus()
    }, { variant: 'ghost', small: true, icon: 'pencil', title: `Edit ${key}` })
    const confirming = this.confirmingDelete === key
    const remove = button(confirming ? 'Delete?' : '', () => {
      if (!confirming) {
        this.confirmingDelete = key
        this.render()
        return
      }
      this.confirmingDelete = null
      void this.run(() => orca.plugin.request('env.delete', { key }))
    }, { variant: confirming ? 'danger' : 'ghost', small: true, icon: confirming ? undefined : 'trash', title: `Remove ${key} from ${file}` })
    return el(
      'tr',
      {},
      el('td', {}, el('code', { class: 'env-key' }, key)),
      el('td', { class: 'value' }, el('code', { class: value ? '' : 'muted' }, shown ? value || '(empty)' : value ? '••••••••' : '(empty)')),
      el('td', { class: 'env-file', title: file }, file),
      el('td', { class: 'actions-cell' }, reveal, edit, remove)
    )
  }

  private form(replacing: boolean): HTMLElement {
    const key = el('input', { type: 'text', title: 'Variable name' }) as HTMLInputElement
    key.id = 'env-key'
    key.placeholder = 'NAME'
    key.value = this.draft.key
    key.spellcheck = false
    const value = el('input', { type: 'password', title: 'Value' }) as HTMLInputElement
    value.id = 'env-value'
    value.placeholder = 'value'
    value.value = this.draft.value
    const show = el('input', { type: 'checkbox', title: 'Show the value' }) as HTMLInputElement
    show.addEventListener('change', () => (value.type = show.checked ? 'text' : 'password'))
    const submit = () => {
      const name = key.value.trim()
      if (!name) return key.focus()
      this.draft = { key: '', value: '' }
      void this.run(() => orca.plugin.request('env.set', { key: name, value: value.value }))
    }
    key.addEventListener('input', () => (this.draft.key = key.value))
    value.addEventListener('input', () => (this.draft.value = value.value))
    for (const input of [key, value]) input.addEventListener('keydown', (event) => event.key === 'Enter' && submit())
    return el(
      'footer',
      { class: 'dialog-foot' },
      el('div', { class: 'field' }, el('label', {}, replacing ? `Update ${this.draft.key}` : 'Add a variable')),
      el(
        'div',
        { class: 'env-form-row' },
        key,
        el('span', { class: 'muted' }, '='),
        value,
        el('label', { class: 'check' }, show, 'show'),
        button(replacing ? 'Update' : 'Add', submit, { variant: 'primary', small: true })
      )
    )
  }
}
