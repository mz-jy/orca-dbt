// The details pane: a node's identity and actions up top, then tabs: Overview (docs, properties,
// neighbours), Columns, Tests (with their latest results) and Data, queried through the project's
// own dbt (the worker runs `dbt show`).
import { previewSql } from '../src/graph'
import type {
  ChangedNode,
  DbtEngine,
  EnvState,
  NodeDetail,
  NodeFocus,
  NodeSummary,
  QualityRun,
  QueryResult,
  TestResult
} from '../src/protocol'
import { button, CHANGE_LABELS, changeTag, copyButton, el, emptyState, errorMessage, fill, isProblem, plural, sectionHead, STATUS_LABELS, swatch, typeColor, typeLabel } from './dom'
import { icon } from './icons'
import { renderMarkdown } from './markdown'
import { testItem } from './quality-view'

export type ModelViewEvents = {
  /** Draw the lineage around this node. */
  focus(id: string): void
  /** Show this node here (a neighbour was clicked). */
  select(id: string): void
  openFile(id: string): void
  selectTag(tag: string): void
  /** Open the Environment dialog, ready to add `key` when given. */
  openEnv(key?: string): void
  /** Run this node's tests. */
  runTests(id: string): void
}

type Tab = 'overview' | 'columns' | 'tests' | 'data'

const ROW_LIMITS = ['10', '20', '50', '100', '500']
const COLUMN_FILTER_FROM = 10

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
  private tab: Tab = asTab(localStorage.getItem('detailTab'))
  private columnFilter = ''
  private dataSection: HTMLElement | null = null
  /** The variables queries run with, for the line under the engine. */
  private env: EnvState | null = null
  /** The shown node's tests with their latest results; null while loading. */
  private tests: TestResult[] | null = null
  private testsSeq = 0
  /** The project's test run in progress, if any (one at a time). */
  private testRun: QualityRun | null = null

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

  /** Whether the shown node is the one the graph is drawn around (it hides "Focus lineage"). */
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

  setTestRun(run: QualityRun | null): void {
    if (run?.jobId === this.testRun?.jobId) return
    this.testRun = run
    this.render()
  }

  /** Reads the shown node's test results again (after a run). */
  async refreshTests(): Promise<void> {
    const id = this.shown?.node.id
    const seq = ++this.testsSeq
    if (!id) return
    try {
      const report = await orca.plugin.request('quality.read', { nodeId: id })
      if (seq !== this.testsSeq || id !== this.shown?.node.id) return
      this.tests = report.tests
      this.testRun = report.running
    } catch (cause) {
      if (seq !== this.testsSeq) return
      this.tests = []
      this.failure = errorMessage(cause)
    }
    this.render()
  }

  /** Queries the rows test `testId` found into the Data tab, and shows it. */
  showTestRows(testId: string): void {
    this.setTab('data')
    void this.run({ testId })
  }

  /**
   * Shows `focus` (null: the empty state); `isGraphFocus` hides the "Focus lineage" button;
   * `change` says how the branch changed it.
   */
  show(focus: NodeFocus | null, isGraphFocus: boolean, change: ChangedNode | null = null): void {
    if (focus?.node.id !== this.shown?.node.id) {
      if (this.job) void orca.plugin.request('query.cancel', { jobId: this.job.jobId }).catch(() => {})
      this.job = null
      this.result = null
      this.failure = null
      this.sqlDraft = focus ? this.previewFor(focus.node) : ''
      this.tests = null
      this.columnFilter = ''
      this.shown = focus
      void this.refreshTests()
    }
    this.shown = focus
    this.isGraphFocus = isGraphFocus
    this.change = change
    this.render()
  }

  private setTab(tab: Tab): void {
    this.tab = tab
    localStorage.setItem('detailTab', tab)
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
      fill(
        this.root,
        el(
          'div',
          { class: 'pane-body center' },
          emptyState('details', 'Nothing selected', 'Pick a node in the graph or the catalog to see its docs, columns, tests and data.')
        )
      )
      return
    }
    const { node } = focus
    const tests = this.tests ?? []
    const problems = tests.filter((test) => isProblem(test.status)).length
    const tabs: [Tab, string, string | null, boolean?][] = [
      ['overview', 'Overview', null],
      ['columns', 'Columns', String(node.columns.length)],
      ['tests', 'Tests', this.tests === null ? null : problems > 0 ? String(problems) : String(tests.length), problems > 0],
      ['data', 'Data', null]
    ]
    const tabBar = el(
      'div',
      { class: 'tabs detail-tabs', role: 'tablist' },
      ...tabs.map(([tab, label, count, alarm]) => {
        const element = el(
          'button',
          { type: 'button', class: `tab${tab === this.tab ? ' active' : ''}`, role: 'tab', 'aria-selected': String(tab === this.tab) },
          label,
          count !== null ? el('span', { class: `tab-count${alarm ? ' alarm' : ''}` }, count) : null
        )
        element.addEventListener('click', () => this.setTab(tab))
        return element
      })
    )

    this.dataSection = null
    const body =
      this.tab === 'columns'
        ? this.columnsTab(node)
        : this.tab === 'tests'
          ? this.testsTab(node)
          : this.tab === 'data'
            ? (this.dataSection = el('div', { class: 'data' }))
            : this.overviewTab(focus)
    fill(this.root, this.header(node), tabBar, el('div', { class: 'pane-body detail-body' }, body))
    this.renderData()
  }

  private header(node: NodeDetail): HTMLElement {
    const eyebrow = el('div', { class: 'eyebrow' }, swatch(node.type), typeLabel(node.type), node.materialized && node.materialized !== node.type ? el('span', {}, `· ${node.materialized}`) : null)
    eyebrow.style.setProperty('--type', typeColor(node.type))
    return el(
      'header',
      { class: 'detail-head' },
      eyebrow,
      el('h2', { class: 'detail-title', title: node.id }, node.name),
      node.relation
        ? el('div', { class: 'detail-relation' }, el('code', { title: 'Relation in the warehouse' }, node.relation), copyButton(node.relation, 'Copy the relation name'))
        : null,
      this.change
        ? el(
            'div',
            { class: 'callout changed' },
            changeTag(this.change.change),
            el('div', {}, el('p', {}, `Changed in this branch: ${CHANGE_LABELS[this.change.change]}`), el('ul', { class: 'file-list' }, ...this.change.files.map((file) => el('li', {}, el('code', {}, file)))))
          )
        : null,
      el(
        'div',
        { class: 'detail-actions' },
        this.isGraphFocus ? null : button('Focus lineage', () => this.events.focus(node.id), { icon: 'target', small: true, title: 'Draw the lineage around this node' }),
        node.file ? button('Open file', () => this.events.openFile(node.id), { icon: 'file', small: true, title: node.file }) : null,
        this.tab !== 'data' && previewSql(node.id, node.type, node.name, node.packageName)
          ? button('Preview data', () => {
              this.setTab('data')
              void this.run({ id: node.id })
            }, { icon: 'play', small: true, variant: 'ghost' })
          : null
      )
    )
  }

  private overviewTab({ node, parents, children }: NodeFocus): HTMLElement {
    const description = el('div', { class: 'description prose' })
    if (node.description) description.innerHTML = renderMarkdown(node.description)
    else description.append(el('p', { class: 'muted' }, 'No description. Add one in the YAML next to the model.'))

    const facts: [string, string | null, boolean?][] = [
      ['Owner', node.owner],
      ['Materialized', node.materialized],
      ['Rows', node.rowCount === null ? null : node.rowCount.toLocaleString()],
      ['File', node.file, true],
      ['Package', node.packageName]
    ]
    return el(
      'div',
      {},
      node.tags.length > 0
        ? el(
            'div',
            { class: 'tag-list' },
            ...node.tags.map((tag) => button(`#${tag}`, () => this.events.selectTag(tag), { small: true, class: 'tag', title: `Select tag:${tag}` }))
          )
        : null,
      description,
      el('section', { class: 'block' }, sectionHead('Properties'), properties(facts.map(([label, value, code]) => [label, value ? (code ? el('code', {}, value) : value) : null]))),
      node.meta.length > 0 ? el('section', { class: 'block' }, sectionHead('Meta', node.meta.length), properties(node.meta.map((entry) => [entry.key, entry.value]))) : null,
      el('section', { class: 'block' }, sectionHead('Upstream', parents.length), this.neighbours(parents, 'No parents: this is where the data enters.')),
      el('section', { class: 'block' }, sectionHead('Downstream', children.length), this.neighbours(children, 'Nothing reads from it.'))
    )
  }

  /** One entry per column: name and type on a line, then tests and description. */
  private columnsTab(node: NodeDetail): HTMLElement {
    if (node.columns.length === 0) {
      return emptyState('catalog', 'No columns documented', "`dbt docs generate` writes the warehouse's own columns to target/catalog.json.")
    }
    const list = el('ul', { class: 'column-list' })
    const draw = () => {
      const query = this.columnFilter.trim().toLowerCase()
      const shown = query
        ? node.columns.filter((column) => column.name.toLowerCase().includes(query) || column.description.toLowerCase().includes(query))
        : node.columns
      fill(
        list,
        ...shown.map((column) =>
          el(
            'li',
            {},
            el(
              'div',
              { class: 'column-head' },
              el('code', { class: 'column-name' }, column.name),
              el('span', { class: 'spacer' }),
              column.type ? el('span', { class: 'column-type' }, column.type.toLowerCase()) : null
            ),
            column.description ? el('div', { class: 'column-description' }, column.description) : null,
            column.tests.length > 0
              ? el(
                  'div',
                  { class: 'column-tests' },
                  ...column.tests.map((label) => {
                    const result = this.tests?.find((test) => test.column?.toLowerCase() === column.name.toLowerCase() && test.label === label)
                    return el(
                      'span',
                      { class: `pill status-${result?.status ?? 'never'}`, title: result?.status ? STATUS_LABELS[result.status] : 'not run yet' },
                      label
                    )
                  })
                )
              : null
          )
        ),
        shown.length === 0 ? el('li', { class: 'tree-note' }, 'No column matches.') : null
      )
    }
    draw()
    let filter: HTMLInputElement | null = null
    if (node.columns.length >= COLUMN_FILTER_FROM) {
      filter = el('input', { type: 'search', class: 'input-sm', title: 'Filter columns' }) as HTMLInputElement
      filter.placeholder = `Filter ${node.columns.length} columns`
      filter.value = this.columnFilter
      filter.addEventListener('input', () => {
        this.columnFilter = filter!.value
        draw()
      })
    }
    return el('div', {}, filter ? el('div', { class: 'list-tools' }, filter) : null, list)
  }

  /** The node's tests, worst first, with how each last ran and a way to see what it found. */
  private testsTab(node: NodeDetail): HTMLElement {
    const tests = this.tests
    if (tests === null) return el('p', { class: 'pane-note' }, 'Reading test results…')
    const running = this.testRun
    const bar = running
      ? el('div', { class: 'run-bar running' }, el('span', { class: 'spinner' }), el('span', { class: 'run-label' }, `Running ${running.label}`))
      : el(
          'div',
          { class: 'run-bar' },
          button('Run tests', () => this.events.runTests(node.id), { variant: 'primary', small: true, icon: 'play', disabled: tests.length === 0 }),
          el('code', { class: 'muted run-command' }, `dbt test --select ${node.name}`)
        )
    if (tests.length === 0) return el('div', {}, emptyState('quality', 'No tests on this node', 'Add data tests in its YAML, or a unit test, to check it.'))
    return el(
      'div',
      {},
      bar,
      el(
        'ul',
        { class: 'test-list' },
        ...tests.map((test) => testItem(test, test.rows ? () => this.showTestRows(test.id) : null))
      )
    )
  }

  private neighbours(list: readonly NodeSummary[], none: string): HTMLElement {
    if (list.length === 0) return el('p', { class: 'pane-note' }, none)
    return el(
      'ul',
      { class: 'tree flat' },
      ...list.map((neighbour) => {
        const row = el(
          'button',
          { type: 'button', class: 'row node', title: `${neighbour.id}\nDouble-click to focus its lineage` },
          swatch(neighbour.type),
          el('span', { class: 'label' }, neighbour.name),
          el('span', { class: 'row-end' }, el('span', { class: 'row-type' }, typeLabel(neighbour.type)))
        )
        row.addEventListener('click', () => this.events.select(neighbour.id))
        row.addEventListener('dblclick', () => this.events.focus(neighbour.id))
        return el('li', {}, row)
      })
    )
  }

  private renderData(): void {
    const container = this.dataSection
    const node = this.shown?.node
    if (!container || !node) return
    const engine = this.engine
    const running = this.job !== null
    const flavor = engine?.flavor === 'fusion' ? 'dbt Fusion' : engine?.flavor === 'core' ? 'dbt-core' : 'dbt'
    const limit = el('select', { class: 'select-compact', title: 'Rows to fetch' }, ...ROW_LIMITS.map((value) => new Option(`${value} rows`, value)))
    limit.value = this.rowLimit
    limit.addEventListener('change', () => {
      this.rowLimit = limit.value
      localStorage.setItem('rowLimit', limit.value)
    })
    const sql = el('textarea', { class: 'sql-editor', title: "SQL: Jinja and {{ ref('…') }} work" }) as HTMLTextAreaElement
    sql.rows = 5
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

    const envChip = button(
      env ? (missing.length > 0 ? `${missing.length} variable${missing.length === 1 ? '' : 's'} missing` : `Env · ${env.vars.length} set`) : 'Environment',
      () => this.events.openEnv(),
      {
        variant: missing.length > 0 ? 'danger' : 'ghost',
        small: true,
        icon: 'sliders',
        title: env
          ? `Variables from ${env.files.length > 0 ? env.files.join(', ') : 'no env file yet'}${missing.length > 0 ? `\nMissing: ${missing.join(', ')}` : ''}`
          : 'The variables queries run with'
      }
    )

    fill(
      container,
      el(
        'div',
        { class: 'query-bar' },
        preview ? button('Preview', () => void this.run({ id: node.id }), { variant: 'primary', small: true, icon: 'play', disabled: running }) : null,
        button('Run', () => void this.run({ sql: sql.value }), { small: true, disabled: running || !sql.value.trim(), title: 'Run the SQL (⌘↵)' }),
        limit,
        el('span', { class: 'spacer' }),
        envChip
      ),
      sql,
      el(
        'p',
        { class: 'query-engine' },
        icon('terminal', 12),
        el(
          'span',
          { class: 'engine-text', title: engine ? `Runs ${engine.command} with the project's profile` : undefined },
          engine ? `${flavor}${engine.version ? ` ${engine.version}` : ''} · ${engine.command}` : "The project's own dbt, with its profile"
        ),
        el('span', { class: 'spacer' }),
        el('kbd', {}, '⌘↵')
      ),
      running
        ? el(
            'div',
            { class: 'run-bar running' },
            el('span', { class: 'spinner' }),
            el('span', { class: 'run-label' }, 'Querying the warehouse…'),
            el('span', { class: 'muted small' }, 'an SSO sign-in may open in your browser'),
            el('span', { class: 'spacer' }),
            button('Cancel', () => void this.cancel(), { small: true, icon: 'stop' })
          )
        : null,
      this.failure ? el('div', { class: 'callout danger' }, icon('alert', 14), el('pre', {}, this.failure)) : null,
      error
        ? el(
            'div',
            { class: 'callout danger' },
            icon('alert', 14),
            el('div', {}, el('pre', {}, error), missingVar ? button(`Set ${missingVar}…`, () => this.events.openEnv(missingVar), { variant: 'primary', small: true }) : null)
          )
        : null,
      result && result.ok ? this.resultTable(result) : null,
      !running && !result && !this.failure ? el('p', { class: 'pane-note' }, preview ? 'Preview the first rows, or write SQL and run it.' : 'Write SQL and run it.') : null
    )
  }

  private resultTable(result: Extract<QueryResult, { ok: true }>): HTMLElement {
    return el(
      'div',
      { class: 'results' },
      el(
        'div',
        { class: 'results-meta' },
        el('span', {}, plural(result.rows.length, 'row')),
        el('span', { class: 'muted' }, `${(result.ms / 1000).toFixed(1)} s${result.truncated ? ' · cut short to fit' : ''}`)
      ),
      result.rows.length === 0
        ? el('p', { class: 'pane-note' }, 'The query returned no rows.')
        : el(
            'div',
            { class: 'table-wrap' },
            el(
              'table',
              { class: 'data-table' },
              el('thead', {}, el('tr', {}, el('th', { class: 'row-number' }, '#'), ...result.columns.map((column) => el('th', {}, column)))),
              el(
                'tbody',
                {},
                ...result.rows.map((row, index) =>
                  el(
                    'tr',
                    {},
                    el('td', { class: 'row-number' }, String(index + 1)),
                    ...row.map((value) =>
                      el('td', { class: value === null ? 'null' : typeof value === 'number' ? 'number' : '', title: value === null ? undefined : String(value) }, value === null ? 'null' : String(value))
                    )
                  )
                )
              )
            )
          )
    )
  }

  private async run(input: { id?: string; sql?: string; testId?: string }): Promise<void> {
    this.result = null
    this.failure = null
    try {
      this.job = await orca.plugin.request('query.start', { ...input, limit: Number(this.rowLimit) })
      // A preview's or a test's query fills the box, to read or adjust.
      if (input.testId || input.id) this.sqlDraft = this.job.sql.trim()
    } catch (cause) {
      this.failure = errorMessage(cause)
    }
    this.renderData()
  }

  private async cancel(): Promise<void> {
    if (this.job) await orca.plugin.request('query.cancel', { jobId: this.job.jobId }).catch(() => {})
  }
}

function properties(rows: [string, Node | string | null][]): HTMLElement {
  return el('dl', { class: 'properties' }, ...rows.flatMap(([label, value]) => (value ? [el('dt', {}, label), el('dd', {}, value)] : [])))
}

function asTab(value: string | null): Tab {
  return value === 'columns' || value === 'tests' || value === 'data' ? value : 'overview'
}
