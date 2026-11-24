// The model sheet: a node's docs, tags, owner, columns and tests, its direct neighbours, and its
// data, queried through the project's own dbt (the worker runs `dbt show`).
import { previewSql } from '../src/graph'
import type { ChangedNode, DbtEngine, EnvState, NodeDetail, NodeFocus, NodeSummary, QueryResult } from '../src/protocol'
import { CHANGE_LABELS, changeTag, el, errorMessage, fill, swatch } from './dom'
import { renderMarkdown } from './markdown'

export type ModelViewEvents = {
  /** Draw the lineage around this node. */
  focus(id: string): void
  /** Show this node here (a neighbour was clicked). */
  select(id: string): void
  openFile(id: string): void
  selectTag(tag: string): void
  /** Open the Environment dialog, ready to add `key` when given. */
  openEnv(key?: string): void
}

const ROW_LIMITS = ['10', '20', '50', '100', '500']

export class ModelView {
  private shown: NodeFocus | null = null
  private isGraphFocus = false
  /** How the current branch changed the shown node, when it did. */
  private change: ChangedNode | null = null
  private engine: DbtEngine | null = null
  private job: { jobId: string; sql: string } | null = null
  private result: QueryResult | null = null
  private failure: string | null = null
  private sqlDraft = ''
  private rowLimit = localStorage.getItem('rowLimit') ?? '20'
  private dataSection: HTMLElement | null = null
  /** The variables queries run with, for the line under the engine. */
  private env: EnvState | null = null

  constructor(
    private readonly root: HTMLElement,
    private readonly events: ModelViewEvents
  ) {
    orca.plugin.on('query.done', (done) => {
      if (done.jobId !== this.job?.jobId) return
      this.job = null
      this.result = done
      this.renderData()
    })
  }

  get nodeId(): string | null {
    return this.shown?.node.id ?? null
  }

  /** Whether the shown node is the one the graph is drawn around (it hides "Focus in graph"). */
  setGraphFocus(isGraphFocus: boolean): void {
    if (isGraphFocus === this.isGraphFocus || !this.shown) return
    this.isGraphFocus = isGraphFocus
    this.render()
  }

  setEnv(env: EnvState): void {
    this.env = env
    this.renderData()
  }

  setEngine(engine: DbtEngine): void {
    this.engine = engine
    this.renderData()
  }

  /**
   * Shows `focus` (null: the empty state); `isGraphFocus` hides the "Focus in graph" button;
   * `change` says how the branch changed it.
   */
  show(focus: NodeFocus | null, isGraphFocus: boolean, change: ChangedNode | null = null): void {
    if (focus?.node.id !== this.shown?.node.id) {
      if (this.job) void orca.plugin.request('query.cancel', { jobId: this.job.jobId }).catch(() => {})
      this.job = null
      this.result = null
      this.failure = null
      this.sqlDraft = focus ? this.previewFor(focus.node) : ''
    }
    this.shown = focus
    this.isGraphFocus = isGraphFocus
    this.change = change
    this.render()
  }

  private previewFor(node: NodeDetail): string {
    const sql = previewSql(node.id, node.type, node.name, node.packageName)
    return sql ? `${sql}\nlimit ${this.rowLimit}` : ''
  }

  private render(): void {
    const focus = this.shown
    if (!focus) {
      this.dataSection = null
      this.root.replaceChildren(
        el('div', { class: 'message muted' }, el('p', {}, 'Click a node in the graph or the catalog to see its docs, columns and data.'))
      )
      return
    }
    const { node, parents, children } = focus
    const description = el('div', { class: 'description' })
    if (node.description) description.innerHTML = renderMarkdown(node.description)
    else description.append(el('p', { class: 'muted' }, 'No description.'))

    const facts: [string, string | null, boolean?][] = [
      ['Materialized', node.materialized],
      ['Relation', node.relation, true],
      ['Owner', node.owner],
      ['Rows', node.rowCount === null ? null : node.rowCount.toLocaleString()],
      ['Tests', node.tests.length > 0 ? node.tests.join(', ') : null],
      ['File', node.file, true],
      ['Package', node.packageName]
    ]
    const actions = el(
      'div',
      { class: 'actions' },
      this.isGraphFocus ? null : button('Focus in graph', () => this.events.focus(node.id), 'primary'),
      node.file ? button('Open file', () => this.events.openFile(node.id)) : null
    )

    this.dataSection = el('div', { class: 'data' })
    fill(
      this.root,
      el('div', { class: 'model-head' }, swatch(node.type), el('h2', {}, node.name), el('span', { class: 'badge' }, node.type)),
      this.change
        ? el(
            'div',
            { class: 'change-note' },
            changeTag(this.change.change),
            ` Changed in this branch: ${CHANGE_LABELS[this.change.change]}`,
            el('div', { class: 'files' }, ...this.change.files.map((file) => el('code', {}, file)))
          )
        : null,
      node.tags.length > 0
        ? el('div', { class: 'tags' }, ...node.tags.map((tag) => button(`#${tag}`, () => this.events.selectTag(tag), 'tag')))
        : null,
      description,
      el(
        'dl',
        { class: 'facts' },
        ...facts.flatMap(([label, value, code]) =>
          value ? [el('dt', {}, label), el('dd', {}, code ? el('code', {}, value) : value)] : []
        )
      ),
      actions,
      section(`Columns (${node.columns.length})`, true, this.columnsList(node)),
      node.meta.length > 0
        ? section(
            `Meta (${node.meta.length})`,
            false,
            el('dl', { class: 'facts' }, ...node.meta.flatMap((entry) => [el('dt', {}, entry.key), el('dd', {}, entry.value)]))
          )
        : null,
      section(
        `Lineage (${parents.length} up · ${children.length} down)`,
        false,
        this.neighbours('Upstream', parents),
        this.neighbours('Downstream', children)
      ),
      section('Data', true, this.dataSection)
    )
    this.renderData()
  }

  /** One entry per column: name, type and tests on a line, the description under it. */
  private columnsList(node: NodeDetail): HTMLElement {
    if (node.columns.length === 0) {
      return el('p', { class: 'muted' }, "No columns documented. `dbt docs generate` writes the warehouse's own columns to target/catalog.json.")
    }
    return el(
      'ul',
      { class: 'columns' },
      ...node.columns.map((column) =>
        el(
          'li',
          {},
          el(
            'div',
            { class: 'column-head' },
            el('code', {}, column.name),
            column.type ? el('span', { class: 'muted' }, column.type) : null,
            ...column.tests.map((test) => el('span', { class: 'pill' }, test))
          ),
          column.description ? el('div', { class: 'column-description' }, column.description) : null
        )
      )
    )
  }

  private neighbours(title: string, list: readonly NodeSummary[]): HTMLElement {
    return el(
      'div',
      { class: 'neighbours' },
      el('div', { class: 'muted' }, title),
      list.length === 0
        ? el('p', { class: 'muted' }, 'None.')
        : el(
            'div',
            { class: 'chips' },
            ...list.map((neighbour) => {
              const chip = button('', () => this.events.select(neighbour.id), 'chip')
              chip.append(swatch(neighbour.type), neighbour.name)
              chip.title = neighbour.id
              return chip
            })
          )
    )
  }

  private renderData(): void {
    const container = this.dataSection
    const node = this.shown?.node
    if (!container || !node) return
    const engine = this.engine
    const running = this.job !== null
    const flavor = engine?.flavor === 'fusion' ? 'dbt Fusion (v2)' : engine?.flavor === 'core' ? 'dbt-core (v1)' : 'dbt'
    const limit = el('select', { title: 'Rows to fetch' }, ...ROW_LIMITS.map((value) => new Option(`${value} rows`, value)))
    limit.value = this.rowLimit
    limit.addEventListener('change', () => {
      this.rowLimit = limit.value
      localStorage.setItem('rowLimit', limit.value)
    })
    const sql = el('textarea', { title: "SQL: Jinja and {{ ref('…') }} work" }) as HTMLTextAreaElement
    sql.rows = 4
    sql.spellcheck = false
    sql.value = this.sqlDraft
    sql.placeholder = "select * from {{ ref('my_model') }}"
    sql.addEventListener('input', () => (this.sqlDraft = sql.value))
    sql.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void this.run({ sql: sql.value })
    })
    const preview = previewSql(node.id, node.type, node.name, node.packageName)
    const result = this.result

    const env = this.env
    const missing = env ? env.required.filter((entry) => !entry.setBy && !entry.hasDefault).map((entry) => entry.key) : []
    const error = result && !result.ok ? result.error : ''
    // dbt-core: "Env var required but not provided: 'X'"; otherwise a quoted name after "env var".
    const missingVar = (
      /Env var required but not provided: '([^']+)'/.exec(error) ??
      /env(?:ironment)?[ _-]?var(?:iable)?[^'"`\n]*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]/i.exec(error)
    )?.[1]

    fill(
      container,
      el(
        'p',
        { class: 'muted small' },
        engine
          ? `Runs ${flavor}${engine.version ? ` ${engine.version}` : ''} from ${engine.command}, with the project's profile.`
          : "Runs the project's own dbt with its profile."
      ),
      el(
        'div',
        { class: 'env-line' },
        el(
          'span',
          { class: missing.length > 0 ? 'small missing-vars' : 'muted small' },
          env
            ? `Variables from ${env.files.length > 0 ? env.files.join(', ') : 'no env file yet'} · ${env.vars.length} set${missing.length > 0 ? ` · missing ${missing.join(', ')}` : ''}`
            : 'Variables from .env'
        ),
        button('Environment…', () => this.events.openEnv(), missing.length > 0 ? 'primary' : '')
      ),
      el(
        'div',
        { class: 'actions' },
        limit,
        preview ? button('▶ Preview', () => void this.run({ id: node.id }), 'primary', running) : null,
        button('Run SQL (⌘↵)', () => void this.run({ sql: sql.value }), '', running || !sql.value.trim()),
        running ? button('Cancel', () => void this.cancel()) : null
      ),
      sql,
      running ? el('p', { class: 'muted running' }, 'Querying the warehouse… (an SSO sign-in may open in your browser)') : null,
      this.failure ? el('pre', { class: 'error' }, this.failure) : null,
      error ? el('pre', { class: 'error' }, error) : null,
      missingVar ? button(`Set ${missingVar}…`, () => this.events.openEnv(missingVar), 'primary') : null,
      result && result.ok ? this.resultTable(result) : null
    )
  }

  private resultTable(result: Extract<QueryResult, { ok: true }>): HTMLElement {
    return el(
      'div',
      {},
      el(
        'p',
        { class: 'muted small' },
        `${result.rows.length} row${result.rows.length === 1 ? '' : 's'} in ${(result.ms / 1000).toFixed(1)} s${result.truncated ? ' (cut short to fit)' : ''}`
      ),
      el(
        'div',
        { class: 'table-wrap results' },
        el(
          'table',
          {},
          el('thead', {}, el('tr', {}, ...result.columns.map((column) => el('th', {}, column)))),
          el(
            'tbody',
            {},
            ...result.rows.map((row) =>
              el('tr', {}, ...row.map((value) => el('td', { class: value === null ? 'null' : '' }, value === null ? 'null' : String(value))))
            )
          )
        )
      )
    )
  }

  private async run(input: { id?: string; sql?: string }): Promise<void> {
    this.result = null
    this.failure = null
    try {
      this.job = await orca.plugin.request('query.start', { ...input, limit: Number(this.rowLimit) })
    } catch (cause) {
      this.failure = errorMessage(cause)
    }
    this.renderData()
  }

  private async cancel(): Promise<void> {
    if (this.job) await orca.plugin.request('query.cancel', { jobId: this.job.jobId }).catch(() => {})
  }
}

function button(label: string, onClick: () => void, className = '', disabled = false): HTMLButtonElement {
  const element = el('button', { type: 'button', class: className, disabled }, label)
  element.addEventListener('click', onClick)
  return element
}

function section(title: string, open: boolean, ...content: (Node | null)[]): HTMLDetailsElement {
  const details = el('details', { class: 'section' }, el('summary', {}, title), ...content)
  details.open = open
  return details
}
