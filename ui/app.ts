// The dbt page: the lineage graph, the catalog explorer and the model sheet,
// side by side when the panel is wide, the graph above a Catalog/Model sheet when it is narrow.
// Every click in one view moves the others: picking a node in the catalog draws its lineage and
// shows its docs; clicking a node in the graph shows its docs and marks it in the catalog.
import type { BranchChanges, Direction, GroupBy, LineageGraph, ProjectStatus } from '../src/protocol'
import { CatalogView } from './catalog-view'
import { byId, el, errorMessage } from './dom'
import { GraphView, type Orientation } from './graph-view'
import { EnvView } from './env-view'
import { ModelView } from './model-view'

const DEPTHS: readonly (readonly [number, string])[] = [
  [1, '1'],
  [2, '2'],
  [3, '3'],
  [5, '5'],
  [99, 'All']
]
const SEARCH_DELAY_MS = 150

const searchInput = byId<HTMLInputElement>('search')
const selectorInput = byId<HTMLInputElement>('selector')
const yamlSelect = byId<HTMLSelectElement>('yaml')
const clearSelectorButton = byId<HTMLButtonElement>('clear-selector')
const statusLine = byId<HTMLDivElement>('status')
const workspaceElement = byId<HTMLElement>('workspace')
const upSelect = byId<HTMLSelectElement>('up')
const downSelect = byId<HTMLSelectElement>('down')
const orientationButton = byId<HTMLButtonElement>('orientation')
const sheetBar = byId<HTMLElement>('sheet-bar')
const detailsElement = byId<HTMLElement>('details')
const changesButton = byId<HTMLButtonElement>('changes')

/** What the page shows; the choices a person makes are kept across reloads in localStorage. */
const state = {
  status: null as ProjectStatus | null,
  /** The node the lineage is drawn around. */
  focus: localStorage.getItem('focus'),
  /** A dbt selector; while set, the graph draws what it selects instead of the focus's lineage. */
  selector: localStorage.getItem('selector') ?? '',
  selectedCount: 0,
  /** While on, the graph draws what the branch changed and everything downstream of it. */
  changesMode: localStorage.getItem('changes') === '1',
  changes: null as BranchChanges | null,
  graph: null as LineageGraph | null,
  /** Nodes whose hidden neighbours the person revealed with a +n badge. */
  expand: [] as { id: string; direction: Direction }[],
  up: Number(localStorage.getItem('up') ?? 2),
  down: Number(localStorage.getItem('down') ?? 2),
  groupBy: (localStorage.getItem('groupBy') ?? 'folder') as GroupBy,
  query: ''
}
let loadSeq = 0
let graphSeq = 0
let searchSeq = 0
let nodeSeq = 0
let searchTimer: ReturnType<typeof setTimeout> | undefined
let parseJob: string | null = null

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
  (localStorage.getItem('orientation') ?? (innerHeight > innerWidth ? 'TB' : 'LR')) as Orientation
)

const catalogView = new CatalogView(byId<HTMLElement>('explorer'), {
  open: (id) => void focusNode(id),
  show: (id) => void showNode(id),
  loadLevel: (by, path) => orca.plugin.request('catalog.level', { by, path }),
  groupBy: (by) => {
    state.groupBy = by
    localStorage.setItem('groupBy', by)
    catalogView.showTree(by)
  },
  refreshChanges: () => void refreshChanges(),
  parse: () => void runParse(),
  error: report
})

const modelView = new ModelView(detailsElement, {
  focus: (id) => void focusNode(id),
  select: (id) => void showNode(id),
  openFile: (id) => void openFile(id),
  selectTag: (tag) => void applySelector(`tag:${tag}`),
  openEnv: (key) => void envView.open(key)
})

const envView = new EnvView(byId<HTMLDialogElement>('env-dialog'), (env) => modelView.setEnv(env))

// ---------- Loading ----------

async function load(): Promise<void> {
  const seq = ++loadSeq
  state.status = null
  renderStatus()
  try {
    const status = await orca.plugin.request('lineage.status', undefined, { timeoutMs: 120_000 })
    if (seq !== loadSeq) return
    state.status = status
    renderStatus()
    if (!status.ok) {
      graphView.show(null, status.message)
      modelView.show(null, false)
      catalogView.showMessage(
        status.message,
        'warning',
        status.reason === 'no_manifest' ? button('Run dbt parse', () => void runParse(), 'primary') : undefined
      )
      return
    }
    void orca.plugin.request('catalog.selectors').then(renderYamlSelectors, report)
    void orca.plugin.request('query.engine').then((engine) => modelView.setEngine(engine), report)
    void orca.plugin.request('env.read').then((env) => modelView.setEnv(env), report)
    // The branch's changes first: every graph marks them.
    await loadChanges()
    await Promise.all([renderCatalog(), loadGraph(), state.focus ? showNode(state.focus, { openSheet: false }) : modelView.show(null, false)])
  } catch (cause) {
    report(cause)
  }
}

async function loadGraph(): Promise<void> {
  const seq = ++graphSeq
  try {
    let graph: LineageGraph | null = null
    let emptyText = 'Pick a node in the catalog, or enter a dbt selector, to draw its lineage.'
    if (state.status?.ok && state.changesMode) {
      const answer = await orca.plugin.request('lineage.changesGraph', { expand: state.expand })
      graph = answer.graph
      emptyText = answer.error ?? 'No dbt node changed in this branch.'
    } else if (state.status?.ok && state.selector) {
      const answer = await orca.plugin.request('lineage.selectGraph', { selector: state.selector, expand: state.expand })
      graph = answer.graph
      state.selectedCount = answer.count
      emptyText = answer.error ?? 'The selector selects nothing.'
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
    // A changes graph opens on the first change, which may sit far from the graph's middle.
    graphView.show(graph, emptyText, state.changesMode && state.changes?.ok ? (state.changes.changed[0]?.id ?? null) : null)
    graphView.select(modelView.nodeId)
    modelView.setGraphFocus(isGraphFocus(modelView.nodeId))
    renderStatus()
  } catch (cause) {
    report(cause)
  }
}

/** The explorer: search matches, the branch's changes, the selector's nodes, or the tree. */
async function renderCatalog(): Promise<void> {
  const query = state.query.trim()
  if (query) {
    const seq = ++searchSeq
    const found = await orca.plugin.request('lineage.search', { query, limit: 100 })
    if (seq === searchSeq) {
      catalogView.showList(`${found.length}${found.length === 100 ? '+' : ''} match${found.length === 1 ? '' : 'es'} for “${query}”`, found)
    }
  } else if (state.changesMode) {
    if (state.changes?.ok) catalogView.showChanges(state.changes)
    else catalogView.showMessage(state.changes?.message ?? 'Reading the branch…', state.changes ? 'warning' : 'muted')
  } else if (state.selector) {
    const selection = await orca.plugin.request('catalog.select', { selector: state.selector })
    if (selection.error) catalogView.showMessage(selection.error, 'warning')
    else {
      catalogView.showList(
        `${selection.count} selected`,
        selection.nodes,
        selection.count > selection.nodes.length ? `The first ${selection.nodes.length} are listed.` : undefined
      )
    }
  } else {
    catalogView.showTree(state.groupBy)
  }
  catalogView.setCurrent(modelView.nodeId)
}

// ---------- Branch changes ----------

/** Reads what the branch changed and marks those nodes in every graph. */
async function loadChanges(): Promise<void> {
  try {
    state.changes = await orca.plugin.request('lineage.changes')
  } catch (cause) {
    state.changes = { ok: false, message: errorMessage(cause) }
  }
  const changes = state.changes
  graphView.setMarks(changes.ok ? Object.fromEntries(changes.changed.map((node) => [node.id, node.change])) : {})
  const count = changes.ok ? changes.changed.length : 0
  changesButton.textContent = count > 0 ? `± Changes (${count})` : '± Changes'
  changesButton.title = changes.ok
    ? `What ${changes.head} changed since ${changes.base}, and everything downstream`
    : changes.message
}

async function refreshChanges(): Promise<void> {
  await loadChanges()
  if (state.changesMode) await Promise.all([loadGraph(), state.query ? null : renderCatalog().catch(report)])
  renderStatus()
}

function setChangesMode(on: boolean): void {
  state.changesMode = on
  localStorage.setItem('changes', on ? '1' : '0')
  changesButton.classList.toggle('active', on)
  state.expand = []
}

async function toggleChanges(): Promise<void> {
  setChangesMode(!state.changesMode)
  if (state.changesMode) {
    setSelector('')
    state.query = ''
    searchInput.value = ''
    setSheet('catalog')
    await loadChanges()
  }
  await Promise.all([loadGraph(), renderCatalog().catch(report)])
  renderStatus()
}

// ---------- Moving between nodes ----------

/** Whether the lineage is drawn around `id`: no selector, no changes graph, and it is the focus. */
function isGraphFocus(id: string | null): boolean {
  return !state.selector && !state.changesMode && id === state.focus
}

/** Shows `id`'s docs and data, marks it in the graph and the catalog. */
async function showNode(id: string, options: { openSheet?: boolean } = {}): Promise<void> {
  const seq = ++nodeSeq
  try {
    const focus = await orca.plugin.request('lineage.node', { id })
    if (seq !== nodeSeq) return
    const change = state.changes?.ok ? (state.changes.changed.find((node) => node.id === id) ?? null) : null
    modelView.show(focus, isGraphFocus(id), change)
    graphView.select(focus ? id : null)
    catalogView.setCurrent(focus ? id : null)
    if (focus && options.openSheet !== false) setSheet('model')
  } catch (cause) {
    report(cause)
  }
}

/** Draws the lineage around `id` (leaving selector and changes modes) and shows it. */
async function focusNode(id: string): Promise<void> {
  state.focus = id
  localStorage.setItem('focus', id)
  state.expand = []
  if (state.selector) setSelector('')
  if (state.changesMode) setChangesMode(false)
  await Promise.all([loadGraph(), showNode(id), state.query ? null : renderCatalog()])
}

function setSelector(text: string): void {
  state.selector = text.trim()
  localStorage.setItem('selector', state.selector)
  selectorInput.value = state.selector
  yamlSelect.value = state.selector.startsWith('selector:') ? state.selector.slice('selector:'.length) : ''
  clearSelectorButton.hidden = state.selector === ''
  state.expand = []
}

async function applySelector(text: string): Promise<void> {
  setSelector(text)
  if (state.changesMode) setChangesMode(false)
  state.query = ''
  searchInput.value = ''
  setSheet('catalog')
  await Promise.all([loadGraph(), renderCatalog().catch(report)])
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
    catalogView.showMessage('Running dbt parse…', 'muted')
  } catch (cause) {
    report(cause)
  }
}

// ---------- Chrome ----------

function renderStatus(): void {
  statusLine.classList.remove('warning')
  const status = state.status
  const ready = status?.ok === true
  searchInput.disabled = selectorInput.disabled = !ready
  upSelect.disabled = downSelect.disabled = !ready || state.selector !== '' || state.changesMode
  if (!status) {
    statusLine.textContent = 'Reading the dbt manifest…'
    return
  }
  if (!status.ok) {
    statusLine.textContent = status.message
    statusLine.classList.add('warning')
    return
  }
  const parts = [
    `${status.projectName} · ${status.workspaceName}${status.projectDir ? ` / ${status.projectDir}` : ''}`,
    `${status.nodeCount} nodes`
  ]
  if (status.dbtVersion) parts.push(`dbt ${status.dbtVersion}`)
  if (state.changesMode && state.changes?.ok) {
    parts.push(`${state.changes.changed.length} changed · ${state.changes.impacted.length} downstream vs ${state.changes.base}`)
  } else if (state.selector) parts.push(`${state.selectedCount} selected`)
  if (state.graph) parts.push(`${state.graph.nodes.length} drawn${state.graph.truncated ? ' (limit reached)' : ''}`)
  statusLine.textContent = parts.join(' · ')
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
  statusLine.textContent = errorMessage(cause)
  statusLine.classList.add('warning')
}

function button(label: string, onClick: () => void, className = ''): HTMLButtonElement {
  const element = el('button', { type: 'button', class: className }, label)
  element.addEventListener('click', onClick)
  return element
}

/** In a narrow panel the sheet under the graph shows the catalog or the model. */
function setSheet(sheet: 'catalog' | 'model'): void {
  workspaceElement.classList.toggle('sheet-catalog', sheet === 'catalog')
  workspaceElement.classList.toggle('sheet-model', sheet === 'model')
  for (const tab of sheetBar.querySelectorAll<HTMLButtonElement>('[data-sheet]')) {
    tab.classList.toggle('active', tab.dataset.sheet === sheet)
  }
  localStorage.setItem('sheet', sheet)
}

function renderOrientation(): void {
  const horizontal = graphView.orientation === 'LR'
  orientationButton.textContent = horizontal ? '⇄' : '⇅'
  orientationButton.title = horizontal ? 'Horizontal layout: switch to vertical' : 'Vertical layout: switch to horizontal'
}

// ---------- Wiring ----------

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    state.query = searchInput.value
    setSheet('catalog')
    void renderCatalog().catch(report)
  }, SEARCH_DELAY_MS)
})
selectorInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void applySelector(selectorInput.value)
  if (event.key === 'Escape') selectorInput.value = state.selector
})
yamlSelect.addEventListener('change', () => void applySelector(yamlSelect.value ? `selector:${yamlSelect.value}` : ''))
changesButton.addEventListener('click', () => void toggleChanges())
// Back from editing files: read the branch again, so new edits show up in the graph.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.status?.ok) void refreshChanges()
})
clearSelectorButton.addEventListener('click', () => void applySelector(''))

for (const [select, key] of [
  [upSelect, 'up'],
  [downSelect, 'down']
] as const) {
  select.replaceChildren(...DEPTHS.map(([value, label]) => new Option(label, String(value))))
  select.value = String(state[key])
  select.addEventListener('change', () => {
    state[key] = Number(select.value)
    localStorage.setItem(key, select.value)
    state.expand = []
    void loadGraph()
  })
}
orientationButton.addEventListener('click', () => {
  graphView.setOrientation(graphView.orientation === 'LR' ? 'TB' : 'LR')
  localStorage.setItem('orientation', graphView.orientation)
  renderOrientation()
})
byId<HTMLButtonElement>('fit').addEventListener('click', () => graphView.fit(true))

for (const tab of sheetBar.querySelectorAll<HTMLButtonElement>('[data-sheet]')) {
  tab.addEventListener('click', () => setSheet(tab.dataset.sheet === 'model' ? 'model' : 'catalog'))
}
// Drag the bar between graph and sheet to share the height differently.
sheetBar.addEventListener('pointerdown', (event) => {
  if ((event.target as Element).closest('button')) return
  sheetBar.setPointerCapture(event.pointerId)
  const move = (moveEvent: PointerEvent) => {
    const box = workspaceElement.getBoundingClientRect()
    const height = Math.min(Math.max(box.bottom - moveEvent.clientY - sheetBar.offsetHeight / 2, 120), box.height - 160)
    workspaceElement.style.setProperty('--sheet-height', `${height}px`)
  }
  const stop = () => {
    sheetBar.removeEventListener('pointermove', move)
    localStorage.setItem('sheetHeight', workspaceElement.style.getPropertyValue('--sheet-height'))
  }
  sheetBar.addEventListener('pointermove', move)
  sheetBar.addEventListener('pointerup', stop, { once: true })
})

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
setSheet(localStorage.getItem('sheet') === 'model' ? 'model' : 'catalog')
setSelector(state.selector)
setChangesMode(state.changesMode)
renderOrientation()
void load()
