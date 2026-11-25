// The dbt page. One search box on top (search as you type, ↵ draws a dbt selector), and three
// regions that move together: a side pane (Catalog, Changes or Quality), the lineage graph, and
// the details of the node in hand. Side by side when the panel is wide; in a narrow panel the
// graph sits above a sheet that shows one pane at a time.
//
// What the graph draws follows one rule, shown in its top-left chip: the branch's changes while
// the Changes pane is open, else the selector while one is set, else the focused node's lineage.
import type { BranchChanges, Direction, GroupBy, LineageGraph, ProjectStatus, QualityRun } from '../src/protocol'
import { CatalogView } from './catalog-view'
import { ChangesView } from './changes-view'
import { button, byId, el, emptyState, errorMessage, fill, plural } from './dom'
import { EnvView } from './env-view'
import { GraphView, type GraphGrouping, type Orientation } from './graph-view'
import { icon, type IconName } from './icons'
import { ModelView } from './model-view'
import { QualityView } from './quality-view'

const DEPTHS = [1, 2, 3, 5, 99] as const
const SEARCH_DELAY_MS = 150
const ZOOM_STEP = 1.25

const searchInput = byId<HTMLInputElement>('search')
const omnibox = byId<HTMLElement>('omnibox')
const omniboxIcon = byId<HTMLElement>('omnibox-icon')
const omniboxHint = byId<HTMLElement>('omnibox-hint')
const clearSearchButton = byId<HTMLButtonElement>('clear-search')
const yamlSelect = byId<HTMLSelectElement>('yaml')
const projectName = byId<HTMLElement>('project-name')
const projectMeta = byId<HTMLElement>('project-meta')
const notice = byId<HTMLElement>('notice')
const workspaceElement = byId<HTMLElement>('workspace')
const tabBar = byId<HTMLElement>('tabs')
const grip = byId<HTMLElement>('grip')
const graphContext = byId<HTMLElement>('graph-context')
const depthUp = byId<HTMLElement>('depth-up')
const depthDown = byId<HTMLElement>('depth-down')
const depthSeparator = byId<HTMLElement>('depth-sep')
const orientationButton = byId<HTMLButtonElement>('orientation')
const detailsElement = byId<HTMLElement>('details')
const graphGroupSelect = byId<HTMLSelectElement>('graph-group')
/** Three columns (page.css): the details pane is always on screen, no sheet to switch to. */
const wideLayout = matchMedia('(min-width: 900px)')

type Side = 'catalog' | 'changes' | 'quality'

/** What the page shows; the choices a person makes are kept across reloads in localStorage. */
const state = {
  status: null as ProjectStatus | null,
  /** The node the lineage is drawn around. */
  focus: localStorage.getItem('focus'),
  /** A dbt selector; while set, the graph draws what it selects instead of the focus's lineage. */
  selector: localStorage.getItem('selector') ?? '',
  selectedCount: 0,
  /** The side pane; Changes also switches the graph to the branch's changes. */
  side: asSide(localStorage.getItem('side')),
  /** Narrow panels: the sheet shows the details pane instead of the side pane. */
  sheetDetails: localStorage.getItem('sheet') === 'details',
  changes: null as BranchChanges | null,
  graph: null as LineageGraph | null,
  /** Nodes whose hidden neighbours the person revealed with a +n pill. */
  expand: [] as { id: string; direction: Direction }[],
  up: Number(localStorage.getItem('up') ?? 2),
  down: Number(localStorage.getItem('down') ?? 2),
  groupBy: (localStorage.getItem('catalogGroup') ?? 'none') as GroupBy,
  graphGroup: (localStorage.getItem('graphGroup') ?? 'none') as GraphGrouping,
  query: '',
  /** Test problems, for the Quality tab's count. */
  problems: 0,
  /** The Quality pane lists every test, not only problems. */
  qualityAll: localStorage.getItem('qualityAll') === '1',
  /** Why the last test run produced no results. */
  qualityError: null as string | null
}
let loadSeq = 0
let graphSeq = 0
let searchSeq = 0
let nodeSeq = 0
let searchTimer: ReturnType<typeof setTimeout> | undefined
let parseJob: string | null = null
let qualitySeq = 0

const graphView = new GraphView(
  byId<SVGSVGElement>('svg'),
  byId<HTMLElement>('empty'),
  {
    select: (id) => (id ? void showNode(id) : graphView.select(null)),
    focus: (id) => void focusNode(id),
    expand: (id, direction) => {
      if (!state.expand.some((entry) => entry.id === id && entry.direction === direction)) state.expand.push({ id, direction })
      void loadGraph()
    }
  },
  (localStorage.getItem('orientation') ?? (innerHeight > innerWidth ? 'TB' : 'LR')) as Orientation,
  (localStorage.getItem('graphGroup') ?? 'none') as GraphGrouping
)

const catalogView = new CatalogView(byId<HTMLElement>('explorer'), {
  open: (id) => void focusNode(id),
  loadLevel: (by, path) => orca.plugin.request('catalog.level', { by, path }),
  groupBy: (by) => {
    state.groupBy = by
    localStorage.setItem('catalogGroup', by)
    catalogView.showTree(by, nodeCount())
  },
  error: report
})

const changesView = new ChangesView(byId<HTMLElement>('changes'), {
  show: (id) => void showNode(id),
  open: (id) => void focusNode(id),
  refresh: () => void refreshChanges(),
  parse: () => void runParse()
})

const modelView = new ModelView(detailsElement, {
  focus: (id) => void focusNode(id),
  select: (id) => void showNode(id),
  openFile: (id) => void openFile(id),
  selectTag: (tag) => void applySelector(`tag:${tag}`),
  openEnv: (key) => void envView.open(key),
  runTests: (id) => void runTests({ nodeId: id })
})

const envView = new EnvView(byId<HTMLDialogElement>('env-dialog'), (env) => modelView.setEnv(env))

const qualityView = new QualityView(byId<HTMLElement>('quality'), {
  run: (wanted) => void runTests(wanted),
  cancel: (jobId) => void orca.plugin.request('query.cancel', { jobId }).catch(report),
  show: (id) => void showNode(id),
  rows: (nodeId, testId) => void showNode(nodeId).then(() => modelView.showTestRows(testId)),
  draw: (selector) => void applySelector(selector, { keepSide: true }),
  listAll: (all) => {
    state.qualityAll = all
    localStorage.setItem('qualityAll', all ? '1' : '0')
    void loadQuality()
  }
})

// ---------- Loading ----------

async function load(): Promise<void> {
  const seq = ++loadSeq
  state.status = null
  renderChrome()
  try {
    const status = await orca.plugin.request('lineage.status', undefined, { timeoutMs: 120_000 })
    if (seq !== loadSeq) return
    state.status = status
    hideNotice()
    renderChrome()
    if (!status.ok) {
      showProblem(status)
      return
    }
    void orca.plugin.request('catalog.selectors').then(renderYamlSelectors, report)
    void orca.plugin.request('query.engine').then((engine) => modelView.setEngine(engine), report)
    void orca.plugin.request('env.read').then((env) => modelView.setEnv(env), report)
    void loadQuality()
    // The branch's changes first: every graph marks them.
    await loadChanges()
    await Promise.all([renderCatalog(), loadGraph(), state.focus ? showNode(state.focus, { openSheet: false }) : modelView.show(null, false)])
  } catch (cause) {
    report(cause)
  }
}

/** No project, no manifest, a remote workspace: say so where the content would be. */
function showProblem(status: Extract<ProjectStatus, { ok: false }>): void {
  const titles: Record<typeof status.reason, string> = {
    no_workspace: 'No workspace',
    remote: 'Remote workspace',
    no_project: 'No dbt project here',
    no_manifest: 'No manifest yet',
    unreadable: "Can't read the manifest"
  }
  const action =
    status.reason === 'no_manifest'
      ? button('Run dbt parse', () => void runParse(), { variant: 'primary', icon: 'play' })
      : status.reason === 'no_project'
        ? projectFolderField()
        : null
  graphView.show(null, emptyState('database', titles[status.reason], status.message, action, 'warning'))
  modelView.show(null, false)
  catalogView.showMessage(titles[status.reason], undefined, 'warning')
  changesView.show({ ok: false, message: status.message })
  qualityView.showMessage(titles[status.reason], undefined, 'warning')
}

/** Where to type the dbt project folder when it was not found. */
function projectFolderField(): HTMLElement {
  const path = el('input', { type: 'text', title: 'Folder holding dbt_project.yml, relative to the workspace root or absolute' })
  path.placeholder = 'analytics/dbt'
  path.spellcheck = false
  const choose = async () => {
    const folder = path.value.trim()
    if (!folder) return path.focus()
    try {
      await orca.plugin.request('project.choose', { folder }, { timeoutMs: 120_000 })
      await load()
    } catch (cause) {
      report(cause)
    }
  }
  path.addEventListener('keydown', (event) => event.key === 'Enter' && void choose())
  return el('div', { class: 'field-row project-folder' }, path, button('Use', () => void choose(), { variant: 'primary', small: true }))
}

async function loadGraph(): Promise<void> {
  const seq = ++graphSeq
  try {
    let graph: LineageGraph | null = null
    let empty = emptyState('graph', 'No lineage drawn yet', 'Pick a node in the catalog, or type a dbt selector above and press ↵.')
    if (state.status?.ok && changesMode()) {
      const answer = await orca.plugin.request('lineage.changesGraph', { expand: state.expand })
      graph = answer.graph
      empty = answer.error ? emptyState('alert', 'Could not draw the changes', answer.error, null, 'warning') : emptyState('check', 'No dbt node changed in this branch')
    } else if (state.status?.ok && state.selector) {
      const answer = await orca.plugin.request('lineage.selectGraph', { selector: state.selector, expand: state.expand })
      graph = answer.graph
      state.selectedCount = answer.count
      empty = answer.error ? emptyState('alert', 'Invalid selector', answer.error, null, 'warning') : emptyState('graph', 'The selector selects nothing')
    } else if (state.status?.ok && state.focus) {
      graph = await orca.plugin.request('lineage.graph', { id: state.focus, up: state.up, down: state.down, expand: state.expand })
      if (!graph) {
        // The manifest no longer has it (another branch, a rename).
        state.focus = null
        localStorage.removeItem('focus')
      }
    }
    if (seq !== graphSeq) return
    state.graph = graph
    // A changes graph too big to fit opens on its most upstream change, to read downstream from.
    graphView.show(graph, empty, changesMode() && state.changes?.ok ? state.changes.changed.map((node) => node.id) : [])
    graphView.select(modelView.nodeId)
    modelView.setGraphFocus(isGraphFocus(modelView.nodeId))
    renderGraphGroups()
    renderChrome()
  } catch (cause) {
    report(cause)
  }
}

/** The catalog pane: search matches, the selector's nodes, or the tree. */
async function renderCatalog(): Promise<void> {
  if (!state.status?.ok) return
  const query = state.query.trim()
  if (query) {
    const seq = ++searchSeq
    const found = await orca.plugin.request('lineage.search', { query, limit: 100 })
    if (seq === searchSeq) {
      catalogView.showList('search', `${found.length}${found.length === 100 ? '+' : ''} match${found.length === 1 ? '' : 'es'}`, found)
    }
  } else if (state.selector) {
    const selection = await orca.plugin.request('catalog.select', { selector: state.selector })
    if (selection.error) catalogView.showMessage('Invalid selector', selection.error, 'warning')
    else {
      catalogView.showList(
        'selector',
        `${selection.count} selected`,
        selection.nodes,
        selection.count > selection.nodes.length ? `The first ${selection.nodes.length} are listed.` : undefined
      )
    }
  } else {
    catalogView.showTree(state.groupBy, nodeCount())
  }
  catalogView.setCurrent(modelView.nodeId)
}

// ---------- Branch changes ----------

/** Reads what the branch changed and marks those nodes in every graph. */
async function loadChanges(): Promise<void> {
  if (!state.changes) changesView.showLoading()
  try {
    state.changes = await orca.plugin.request('lineage.changes')
  } catch (cause) {
    state.changes = { ok: false, message: errorMessage(cause) }
  }
  const changes = state.changes
  graphView.setMarks(changes.ok ? Object.fromEntries(changes.changed.map((node) => [node.id, node.change])) : {})
  changesView.show(changes)
  changesView.setCurrent(modelView.nodeId)
  renderChrome()
}

async function refreshChanges(): Promise<void> {
  await loadChanges()
  if (changesMode()) await loadGraph()
}

function changesMode(): boolean {
  return state.side === 'changes'
}

// ---------- Test results ----------

/** Reads the test results: the Quality pane, and the flags in the graph and the lists. */
async function loadQuality(): Promise<void> {
  if (!state.status?.ok) return
  const seq = ++qualitySeq
  try {
    const report = await orca.plugin.request('quality.read', { all: state.qualityAll })
    if (seq !== qualitySeq) return
    qualityView.show(report, { all: state.qualityAll, selector: state.selector, error: state.qualityError })
    graphView.setFlags(report.flags)
    catalogView.setFlags(report.flags)
    changesView.setFlags(report.flags)
    modelView.setTestRun(report.running)
    state.problems = report.counts.error + report.counts.fail + report.counts.warn
    renderTabs()
  } catch (cause) {
    qualityView.showMessage("Can't read test results", errorMessage(cause), 'warning')
  }
}

async function runTests(wanted: { nodeId?: string; selector?: string; testIds?: string[] }): Promise<void> {
  state.qualityError = null
  let running: QualityRun | null = null
  try {
    running = await orca.plugin.request('quality.run', wanted)
  } catch (cause) {
    state.qualityError = errorMessage(cause)
  }
  modelView.setTestRun(running)
  await loadQuality()
}

// ---------- Moving between nodes ----------

/** Whether the lineage is drawn around `id`: no selector, no changes graph, and it is the focus. */
function isGraphFocus(id: string | null): boolean {
  return !state.selector && !changesMode() && id === state.focus
}

/** Shows `id`'s details, marks it in the graph and the lists. */
async function showNode(id: string, options: { openSheet?: boolean } = {}): Promise<void> {
  const seq = ++nodeSeq
  try {
    const focus = await orca.plugin.request('lineage.node', { id })
    if (seq !== nodeSeq) return
    const change = state.changes?.ok ? (state.changes.changed.find((node) => node.id === id) ?? null) : null
    modelView.show(focus, isGraphFocus(id), change)
    graphView.select(focus ? id : null)
    catalogView.setCurrent(focus ? id : null)
    changesView.setCurrent(focus ? id : null)
    if (focus && options.openSheet !== false && !wideLayout.matches) setSheetDetails(true)
  } catch (cause) {
    report(cause)
  }
}

/** Draws the lineage around `id` (leaving selector and changes graphs) and shows it. */
async function focusNode(id: string): Promise<void> {
  state.focus = id
  localStorage.setItem('focus', id)
  state.expand = []
  // Leaving a selector turns its list back into the tree; otherwise the tree keeps its open folders.
  const hadSelector = state.selector !== ''
  if (hadSelector) {
    setSelector('')
    if (!state.query) searchInput.value = ''
  }
  if (changesMode()) setSide('catalog')
  await Promise.all([loadGraph(), showNode(id), hadSelector && !state.query ? renderCatalog() : null])
  renderOmnibox()
}

function setSelector(text: string): void {
  state.selector = text.trim()
  localStorage.setItem('selector', state.selector)
  yamlSelect.value = state.selector.startsWith('selector:') ? state.selector.slice('selector:'.length) : ''
  state.expand = []
  renderOmnibox()
}

/** Draws what `text` selects (or, empty, goes back to the focus's lineage). */
async function applySelector(text: string, options: { keepSide?: boolean } = {}): Promise<void> {
  setSelector(text)
  state.query = ''
  searchInput.value = state.selector
  if (!options.keepSide || changesMode()) setSide('catalog')
  renderOmnibox()
  await Promise.all([loadGraph(), renderCatalog().catch(report), loadQuality()])
}

async function openFile(id: string): Promise<void> {
  try {
    const answer = await orca.plugin.request('lineage.open', { id })
    if (!answer.opened) report(answer.message ?? 'Could not open the file.')
  } catch (cause) {
    report(cause)
  }
}

async function runParse(): Promise<void> {
  try {
    parseJob = (await orca.plugin.request('project.parse')).jobId
    showNotice('Running dbt parse…', 'info')
  } catch (cause) {
    report(cause)
  }
}

// ---------- Chrome ----------

function nodeCount(): number | null {
  return state.status?.ok ? state.status.nodeCount : null
}

function renderChrome(): void {
  const status = state.status
  const ready = status?.ok === true
  searchInput.disabled = !ready
  if (!status) {
    projectName.textContent = 'dbt'
    projectMeta.textContent = 'Reading the manifest…'
  } else if (!status.ok) {
    projectName.textContent = 'dbt'
    projectMeta.textContent = 'No project'
  } else {
    projectName.textContent = status.projectName
    const branch = state.changes?.ok ? state.changes.head : null
    projectMeta.textContent = [branch ?? status.workspaceName, status.dbtVersion ? `dbt ${status.dbtVersion}` : null].filter(Boolean).join(' · ')
    byId<HTMLElement>('project').title = [
      `${status.projectName}: ${plural(status.nodeCount, 'node')}`,
      `Workspace ${status.workspaceName}${status.projectDir ? ` / ${status.projectDir}` : ''}`,
      status.dbtVersion ? `dbt ${status.dbtVersion}` : '',
      status.generatedAt ? `Manifest written ${new Date(status.generatedAt).toLocaleString()}` : ''
    ]
      .filter(Boolean)
      .join('\n')
  }
  renderTabs()
  renderGraphContext()
  renderDepth()
  byId<HTMLElement>('graph-toolbar').hidden = !state.graph || state.graph.nodes.length === 0
}

function renderTabs(): void {
  const changeCount = state.changes?.ok ? state.changes.changed.length : 0
  const labels: Record<string, [IconName, string, string | null, boolean]> = {
    catalog: ['catalog', 'Catalog', null, false],
    changes: ['changes', 'Changes', changeCount > 0 ? String(changeCount) : null, false],
    quality: ['quality', 'Quality', state.problems > 0 ? String(state.problems) : null, state.problems > 0],
    details: ['details', 'Details', null, false]
  }
  const active = !wideLayout.matches && state.sheetDetails ? 'details' : state.side
  for (const tab of tabBar.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
    const [iconName, label, count, alarm] = labels[tab.dataset.tab!]
    fill(tab, icon(iconName, 13), el('span', {}, label), count ? el('span', { class: `tab-count${alarm ? ' alarm' : ''}` }, count) : null)
    tab.classList.toggle('active', tab.dataset.tab === active)
    tab.setAttribute('aria-selected', String(tab.dataset.tab === active))
  }
  workspaceElement.dataset.side = state.side
  workspaceElement.dataset.sheet = state.sheetDetails ? 'details' : 'side'
}

/** The chip over the graph: what it draws, and the way out of a selector. */
function renderGraphContext(): void {
  const status = state.status
  if (!status?.ok || !state.graph || state.graph.nodes.length === 0) {
    graphContext.hidden = true
    return
  }
  graphContext.hidden = false
  const count = plural(state.graph.nodes.length, 'node')
  const truncated = state.graph.truncated ? el('span', { class: 'context-warn', title: 'The node limit cut the graph short' }, 'limit reached') : null
  if (changesMode() && state.changes?.ok) {
    fill(
      graphContext,
      el('span', { class: 'context-kind changed' }, icon('changes', 12), 'Changes'),
      el('span', { class: 'context-main' }, `${state.changes.changed.length} changed · ${state.changes.impacted.length} downstream`),
      el('span', { class: 'context-meta' }, `vs ${state.changes.base}`),
      truncated
    )
  } else if (state.selector) {
    fill(
      graphContext,
      el('span', { class: 'context-kind' }, icon('graph', 12), 'Selector'),
      el('code', { class: 'context-main', title: state.selector }, state.selector),
      el('span', { class: 'context-meta' }, `${state.selectedCount} selected`),
      truncated,
      button('', () => void applySelector(''), { variant: 'ghost', small: true, icon: 'close', title: 'Clear the selector' })
    )
  } else {
    const focus = state.graph.nodes.find((node) => node.id === state.graph?.focus)
    fill(
      graphContext,
      el('span', { class: 'context-kind' }, icon('target', 12), 'Lineage'),
      el('span', { class: 'context-main' }, focus?.name ?? ''),
      el('span', { class: 'context-meta' }, count),
      truncated
    )
  }
}

/** The ↑/↓ depth steppers; only the focus's lineage has a depth. */
function renderDepth(): void {
  const show = Boolean(state.status?.ok && !state.selector && !changesMode() && state.focus)
  depthUp.hidden = depthDown.hidden = depthSeparator.hidden = !show
  if (!show) return
  for (const [element, key, label] of [
    [depthUp, 'up', 'Upstream'],
    [depthDown, 'down', 'Downstream']
  ] as const) {
    const index = DEPTHS.indexOf(state[key] as (typeof DEPTHS)[number])
    const step = (by: number) => {
      const next = DEPTHS[Math.min(DEPTHS.length - 1, Math.max(0, (index < 0 ? 1 : index) + by))]
      state[key] = next
      localStorage.setItem(key, String(next))
      state.expand = []
      renderDepth()
      void loadGraph()
    }
    fill(
      element,
      el('span', { class: 'depth-label', title: `${label} levels` }, key === 'up' ? 'Up' : 'Down'),
      button('', () => step(-1), { variant: 'ghost', small: true, icon: 'minus', title: `Fewer ${label.toLowerCase()} levels`, disabled: index === 0 }),
      el('span', { class: 'depth-value' }, state[key] >= 99 ? 'All' : String(state[key])),
      button('', () => step(1), { variant: 'ghost', small: true, icon: 'plus', title: `More ${label.toLowerCase()} levels`, disabled: index === DEPTHS.length - 1 })
    )
    element.dataset.direction = key
  }
}

/** The graph's group-by choices: none, the properties, and the meta keys its nodes have. */
function renderGraphGroups(): void {
  const metaKeys = graphView.metaKeys()
  const current = state.graphGroup
  if (current.startsWith('meta:') && !metaKeys.includes(current.slice('meta:'.length))) metaKeys.push(current.slice('meta:'.length))
  const options = [
    new Option('No groups', 'none'),
    new Option('Folder', 'folder'),
    new Option('Tag', 'tag'),
    new Option('Schema', 'schema'),
    new Option('Owner', 'owner'),
    new Option('Package', 'package')
  ]
  const meta = el('optgroup')
  meta.label = 'Meta'
  meta.append(...metaKeys.map((key) => new Option(key, `meta:${key}`)))
  graphGroupSelect.replaceChildren(...options, ...(metaKeys.length > 0 ? [meta] : []))
  graphGroupSelect.value = current
  graphGroupSelect.closest('.group-by')?.classList.toggle('active', current !== 'none')
}

function renderOmnibox(): void {
  const showingSelector = state.selector !== '' && searchInput.value.trim() === state.selector
  omnibox.classList.toggle('is-selector', showingSelector)
  omniboxIcon.replaceChildren(icon(showingSelector ? 'graph' : 'search', 14))
  omniboxIcon.title = showingSelector ? 'Drawing this dbt selector' : 'Search'
  clearSearchButton.hidden = searchInput.value === ''
  omniboxHint.hidden = searchInput.value !== '' || document.activeElement === searchInput
}

function renderYamlSelectors(yaml: { name: string; description: string }[]): void {
  yamlSelect.hidden = yaml.length === 0
  yamlSelect.replaceChildren(
    new Option(`selectors.yml (${yaml.length})`, ''),
    ...yaml.map((entry) => new Option(entry.description ? `${entry.name}: ${entry.description}` : entry.name, entry.name))
  )
  yamlSelect.value = state.selector.startsWith('selector:') ? state.selector.slice('selector:'.length) : ''
}

function report(cause: unknown): void {
  showNotice(errorMessage(cause), 'error')
}

function showNotice(text: string, tone: 'error' | 'info'): void {
  notice.hidden = false
  notice.className = `notice ${tone}`
  fill(notice, icon(tone === 'error' ? 'alert' : 'refresh', 14), el('span', { class: 'notice-text' }, text), button('', hideNotice, { variant: 'ghost', small: true, icon: 'close', title: 'Dismiss' }))
}

function hideNotice(): void {
  notice.hidden = true
}

function setSide(side: Side): void {
  const wasChanges = changesMode()
  state.side = side
  localStorage.setItem('side', side)
  if (wasChanges !== changesMode()) state.expand = []
  setSheetDetails(false)
}

/** Narrow panels: the sheet under the graph shows the details pane, or the side pane. */
function setSheetDetails(details: boolean): void {
  state.sheetDetails = details
  localStorage.setItem('sheet', details ? 'details' : 'side')
  renderTabs()
}

function asSide(value: string | null | undefined): Side {
  return value === 'changes' || value === 'quality' ? value : 'catalog'
}

function renderOrientation(): void {
  const horizontal = graphView.orientation === 'LR'
  orientationButton.replaceChildren(icon(horizontal ? 'horizontal' : 'vertical', 14))
  orientationButton.title = horizontal ? 'Left to right: switch to top to bottom' : 'Top to bottom: switch to left to right'
}

// ---------- Wiring ----------

searchInput.addEventListener('input', () => {
  renderOmnibox()
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    const text = searchInput.value
    // The box shows the selector it draws; editing it searches until ↵ applies it again.
    state.query = text.trim() === state.selector ? '' : text
    if (state.query && state.side !== 'catalog') setSide('catalog')
    if (state.query && !wideLayout.matches) setSheetDetails(false)
    void renderCatalog().catch(report)
  }, SEARCH_DELAY_MS)
})
searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    clearTimeout(searchTimer)
    void applySelector(searchInput.value)
  }
  if (event.key === 'Escape') {
    if (searchInput.value.trim() !== state.selector) {
      searchInput.value = state.selector
      state.query = ''
      renderOmnibox()
      void renderCatalog().catch(report)
    } else if (state.selector) void applySelector('')
    else searchInput.blur()
  }
})
searchInput.addEventListener('focus', renderOmnibox)
searchInput.addEventListener('blur', renderOmnibox)
clearSearchButton.replaceChildren(icon('close', 13))
clearSearchButton.addEventListener('click', () => {
  if (searchInput.value.trim() === state.selector && state.selector) void applySelector('')
  else {
    searchInput.value = state.selector
    state.query = ''
    renderOmnibox()
    void renderCatalog().catch(report)
  }
  searchInput.focus()
})
yamlSelect.addEventListener('change', () => void applySelector(yamlSelect.value ? `selector:${yamlSelect.value}` : ''))

// "/" or ⌘K jumps to the search box from anywhere but a text field.
document.addEventListener('keydown', (event) => {
  const typing = (event.target as Element).closest('input, textarea, select, [contenteditable]')
  if ((event.key === '/' && !typing) || (event.key === 'k' && (event.metaKey || event.ctrlKey))) {
    event.preventDefault()
    searchInput.focus()
    searchInput.select()
  }
})

for (const tab of tabBar.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
  tab.addEventListener('click', () => {
    const name = tab.dataset.tab!
    if (name === 'details') return setSheetDetails(true)
    const wasChanges = changesMode()
    setSide(asSide(name))
    // The changes graph replaces a selector's, as it replaces the focus's lineage.
    if (changesMode() && state.selector) {
      setSelector('')
      state.query = ''
      searchInput.value = ''
      renderOmnibox()
      void renderCatalog().catch(report)
    }
    if (wasChanges !== changesMode()) {
      if (changesMode()) void refreshChanges()
      else void loadGraph()
    }
    renderChrome()
  })
}

// Back from editing files or a terminal: read the branch and the test results again.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.status?.ok) return
  void refreshChanges()
  void loadQuality()
})

orientationButton.addEventListener('click', () => {
  graphView.setOrientation(graphView.orientation === 'LR' ? 'TB' : 'LR')
  localStorage.setItem('orientation', graphView.orientation)
  renderOrientation()
})
byId<HTMLElement>('group-by-icon').replaceChildren(icon('layers', 14))
graphGroupSelect.addEventListener('change', () => {
  state.graphGroup = graphGroupSelect.value as GraphGrouping
  localStorage.setItem('graphGroup', state.graphGroup)
  graphView.setGrouping(state.graphGroup)
  renderGraphGroups()
})
const fitButton = byId<HTMLButtonElement>('fit')
fitButton.replaceChildren(icon('fit', 14))
fitButton.addEventListener('click', () => graphView.fit(true))
const zoomIn = byId<HTMLButtonElement>('zoom-in')
zoomIn.replaceChildren(icon('plus', 14))
zoomIn.addEventListener('click', () => graphView.zoom(ZOOM_STEP))
const zoomOut = byId<HTMLButtonElement>('zoom-out')
zoomOut.replaceChildren(icon('minus', 14))
zoomOut.addEventListener('click', () => graphView.zoom(1 / ZOOM_STEP))

// Drag the tab bar between graph and sheet to share the height differently (narrow panels only).
tabBar.addEventListener('pointerdown', (event) => {
  if ((event.target as Element).closest('button') || wideLayout.matches) return
  tabBar.setPointerCapture(event.pointerId)
  workspaceElement.classList.add('resizing')
  const move = (moveEvent: PointerEvent) => {
    const box = workspaceElement.getBoundingClientRect()
    const height = Math.min(Math.max(box.bottom - moveEvent.clientY - tabBar.offsetHeight / 2, 140), box.height - 180)
    workspaceElement.style.setProperty('--sheet-height', `${height}px`)
  }
  const stop = () => {
    tabBar.removeEventListener('pointermove', move)
    workspaceElement.classList.remove('resizing')
    localStorage.setItem('sheetHeight', workspaceElement.style.getPropertyValue('--sheet-height'))
  }
  tabBar.addEventListener('pointermove', move)
  tabBar.addEventListener('pointerup', stop, { once: true })
})
grip.title = 'Drag to resize'
wideLayout.addEventListener('change', renderTabs)

// Links in descriptions open in the browser, through Orca (the frame cannot navigate away).
detailsElement.addEventListener('click', (event) => {
  const link = (event.target as Element).closest('a')
  if (!link) return
  event.preventDefault()
  const href = link.getAttribute('href') ?? ''
  if (/^(https?:|mailto:)/i.test(href)) void orca.shell?.openExternal(href)
})

orca.plugin.on('parse.done', (done) => {
  if (done.jobId !== parseJob) return
  parseJob = null
  // dbt v2 can fail a parse and still write the manifest: reload either way.
  void load().then(() => {
    if (!done.ok) report(done.error ?? 'dbt parse failed.')
  })
})

orca.plugin.on('quality.done', (done) => {
  state.qualityError = done.ok ? null : (done.error ?? 'dbt test stopped before running any test.')
  void loadQuality()
  void modelView.refreshTests()
})

// The first event reports the workspace the page opened in; later ones a switch.
let workspaceId: string | null | undefined
orca.on('workspace.changed', ({ context }) => {
  const next = context?.workspaceId ?? null
  const changed = workspaceId !== undefined && next !== workspaceId
  workspaceId = next
  if (changed) void load()
})

const savedHeight = localStorage.getItem('sheetHeight')
if (savedHeight) workspaceElement.style.setProperty('--sheet-height', savedHeight)
searchInput.value = state.selector
setSelector(state.selector)
renderOrientation()
renderChrome()
void load()
