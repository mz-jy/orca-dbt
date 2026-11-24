// The Environment dialog: where query variables come from (every .env from the workspace root
// down, or one chosen file), what they set (values masked until revealed), what the dbt profile
// reads with env_var() and whether it is set, and a form that saves into the env file.
import type { EnvState } from '../src/protocol'
import { el, errorMessage, fill } from './dom'

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
  }

  /** Opens the dialog, ready to add `key` when given (a variable dbt said was missing). */
  async open(key = ''): Promise<void> {
    this.draft = { key, value: '' }
    this.error = null
    if (!this.dialog.open) this.dialog.showModal()
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
    const close = el('button', { type: 'button', class: 'close', title: 'Close' }, '×')
    close.addEventListener('click', () => this.dialog.close())
    if (!state) {
      fill(this.dialog, el('div', { class: 'env-head' }, el('h2', {}, 'Query environment'), close), el('p', { class: 'muted' }, this.error ?? 'Reading…'))
      return
    }
    const setInFiles = new Map(state.vars.map((entry) => [entry.key, entry]))
    fill(
      this.dialog,
      el('div', { class: 'env-head' }, el('h2', {}, 'Query environment'), close),
      el(
        'p',
        { class: 'muted small' },
        "dbt runs with Orca's own environment plus these variables (Orca's wins on a clash), not your shell's. profiles.yml reads them with env_var()."
      ),
      this.sourcePicker(state),
      el(
        'p',
        { class: 'muted small' },
        state.files.length > 0 ? `Reading ${state.files.join(', ')}. ` : 'No env file yet. ',
        `Saving to ${state.target}.`
      ),
      this.error ? el('pre', { class: 'error' }, this.error) : null,
      state.required.length > 0 ? this.requiredList(state) : null,
      el('h3', {}, `Variables (${state.vars.length})`),
      state.vars.length > 0
        ? el(
            'div',
            { class: 'table-wrap' },
            el(
              'table',
              { class: 'env-table' },
              el('tbody', {}, ...state.vars.map((entry) => this.varRow(entry.key, entry.value, entry.file)))
            )
          )
        : el('p', { class: 'muted' }, 'None yet.'),
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
    const use = el('button', { type: 'button', class: 'primary', hidden: true }, 'Use')
    const choose = (file: string) => void this.run(() => orca.plugin.request('env.choose', { file }))
    select.addEventListener('change', () => {
      const other = select.value === OTHER_FILE
      path.hidden = use.hidden = !other
      if (other) path.focus()
      else choose(select.value)
    })
    use.addEventListener('click', () => path.value.trim() && choose(path.value.trim()))
    path.addEventListener('keydown', (event) => event.key === 'Enter' && path.value.trim() && choose(path.value.trim()))
    return el('div', { class: 'env-source' }, el('label', {}, 'Variables from ', select), path, use)
  }

  private requiredList(state: EnvState): HTMLElement {
    return el(
      'div',
      {},
      el('h3', {}, `Profile ${state.profile || '?'} reads`),
      state.profilesFile ? el('p', { class: 'muted small' }, `From ${state.profilesFile} and dbt_project.yml.`) : null,
      el(
        'ul',
        { class: 'env-required' },
        ...state.required.map((entry) => {
          const status =
            entry.setBy === 'file'
              ? el('span', { class: 'pill ok' }, 'set')
              : entry.setBy === 'orca'
                ? el('span', { class: 'pill ok', title: "Set in Orca's own environment" }, 'set by Orca')
                : entry.hasDefault
                  ? el('span', { class: 'pill', title: 'env_var() gives a default' }, 'default')
                  : el('span', { class: 'pill missing' }, 'missing')
          const add = entry.setBy ? null : el('button', { type: 'button' }, 'Add')
          add?.addEventListener('click', () => {
            this.draft = { key: entry.key, value: '' }
            this.render()
            this.dialog.querySelector<HTMLInputElement>('#env-value')?.focus()
          })
          return el('li', {}, el('code', {}, entry.key), status, add)
        })
      )
    )
  }

  private varRow(key: string, value: string, file: string): HTMLTableRowElement {
    const shown = this.revealed.has(key)
    const reveal = el('button', { type: 'button', title: shown ? 'Hide' : 'Show' }, shown ? 'Hide' : 'Show')
    reveal.addEventListener('click', () => {
      if (shown) this.revealed.delete(key)
      else this.revealed.add(key)
      this.render()
    })
    const edit = el('button', { type: 'button' }, 'Edit')
    edit.addEventListener('click', () => {
      this.draft = { key, value }
      this.render()
      this.dialog.querySelector<HTMLInputElement>('#env-value')?.focus()
    })
    const confirming = this.confirmingDelete === key
    const remove = el('button', { type: 'button', class: confirming ? 'danger' : '', title: `Remove ${key} from ${file}` }, confirming ? 'Delete?' : '✕')
    remove.addEventListener('click', () => {
      if (!confirming) {
        this.confirmingDelete = key
        this.render()
        return
      }
      this.confirmingDelete = null
      void this.run(() => orca.plugin.request('env.delete', { key }))
    })
    return el(
      'tr',
      {},
      el('td', {}, el('code', {}, key)),
      el('td', { class: 'value' }, el('code', {}, shown ? value || '(empty)' : value ? '••••••••' : '(empty)')),
      el('td', { class: 'muted small' }, file),
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
    const save = el('button', { type: 'button', class: 'primary' }, replacing ? 'Update' : 'Add')
    const submit = () => {
      const name = key.value.trim()
      if (!name) return key.focus()
      this.draft = { key: '', value: '' }
      void this.run(() => orca.plugin.request('env.set', { key: name, value: value.value }))
    }
    key.addEventListener('input', () => (this.draft.key = key.value))
    value.addEventListener('input', () => (this.draft.value = value.value))
    save.addEventListener('click', submit)
    for (const input of [key, value]) input.addEventListener('keydown', (event) => event.key === 'Enter' && submit())
    return el(
      'div',
      { class: 'env-form' },
      el('h3', {}, replacing ? `Update ${this.draft.key}` : 'Add a variable'),
      el('div', { class: 'env-form-row' }, key, el('span', {}, '='), value, el('label', { class: 'muted small' }, show, ' show'), save)
    )
  }
}
