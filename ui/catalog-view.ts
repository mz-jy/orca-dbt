// The catalog explorer: every node grouped by folder, tag, schema, type, package or owner in a
// lazily loaded tree, a flat list of search or selector results, or the branch's changes.
import type { BranchChanges, CatalogLevel, ChangedNode, GroupBy, NodeSummary } from '../src/protocol'
import { CHANGE_LABELS, CHANGE_LETTERS, changeTag, el, fill, swatch } from './dom'

export type CatalogViewEvents = {
  /** A node was chosen: draw its lineage. */
  open(id: string): void
  /** A node in the Changes list was clicked: show it, keep the changes graph. */
  show(id: string): void
  loadLevel(by: GroupBy, path: string): Promise<CatalogLevel>
  groupBy(by: GroupBy): void
  refreshChanges(): void
  parse(): void
  error(cause: unknown): void
}

const GROUP_OPTIONS: [GroupBy, string][] = [
  ['folder', 'Folder'],
  ['tag', 'Tag'],
  ['schema', 'Schema'],
  ['type', 'Resource type'],
  ['package', 'Package'],
  ['owner', 'Owner']
]

export class CatalogView {
  private current: string | null = null

  constructor(
    private readonly root: HTMLElement,
    private readonly events: CatalogViewEvents
  ) {}

  /** The tree of groups, `by` the chosen grouping, its top level loaded. */
  showTree(by: GroupBy): void {
    const select = el('select', { title: 'Group by' }, ...GROUP_OPTIONS.map(([value, label]) => new Option(label, value)))
    select.value = by
    select.addEventListener('change', () => this.events.groupBy(select.value as GroupBy))
    const tree = el('ul', { class: 'tree' })
    this.root.replaceChildren(el('div', { class: 'explorer-head' }, el('label', {}, 'Group by ', select)), tree)
    void this.fillLevel(tree, by, '')
  }

  /** A flat list, such as search matches or what a selector selects. */
  showList(heading: string, nodes: readonly NodeSummary[], note?: string): void {
    fill(
      this.root,
      el('div', { class: 'explorer-head' }, el('strong', {}, heading)),
      note ? el('p', { class: 'muted' }, note) : null,
      el('ul', { class: 'tree flat' }, ...nodes.map((node) => el('li', {}, this.nodeRow(node))))
    )
    this.mark()
  }

  /** A message instead of the catalog: no project, a bad selector, … */
  showMessage(text: string, tone: 'muted' | 'warning', action?: HTMLElement): void {
    fill(this.root, el('div', { class: `message ${tone}` }, el('p', {}, text), action ?? null))
  }

  /** The branch's changes, what they reach downstream, and how to build them. */
  showChanges(changes: Extract<BranchChanges, { ok: true }>): void {
    const exposures = changes.impacted.filter((node) => node.type === 'exposure')
    const downstream = changes.impacted.filter((node) => node.type !== 'exposure')
    const refresh = el('button', { type: 'button', title: 'Read the branch again' }, '↻')
    refresh.addEventListener('click', () => this.events.refreshChanges())
    const parse = el('button', { type: 'button', class: 'primary' }, 'Run dbt parse')
    parse.addEventListener('click', () => this.events.parse())
    const rows = (nodes: readonly (NodeSummary | ChangedNode)[]) =>
      el('ul', { class: 'tree flat' }, ...nodes.map((node) => el('li', {}, this.nodeRow(node, 'show'))))
    const files = (paths: readonly string[]) => el('ul', { class: 'files' }, ...paths.map((path) => el('li', {}, el('code', {}, path))))

    fill(
      this.root,
      el(
        'div',
        { class: 'explorer-head' },
        el('strong', {}, `${changes.head} vs ${changes.base}`),
        el('span', { class: 'muted small', title: 'Merge base' }, `@${changes.mergeBase}`),
        refresh
      ),
      changes.manifestStale
        ? el('div', { class: 'message warning' }, el('p', {}, 'Files changed since the manifest was written: parse to see new models and refs.'), parse)
        : null,
      el(
        'p',
        { class: 'muted small legend' },
        ...(Object.keys(CHANGE_LETTERS) as (keyof typeof CHANGE_LETTERS)[]).flatMap((kind) => [changeTag(kind), ` ${CHANGE_LABELS[kind]}  `])
      ),
      el('h3', {}, `Changed (${changes.changed.length})`),
      changes.changed.length > 0 ? rows(changes.changed) : el('p', { class: 'muted' }, 'No dbt node changed in this branch.'),
      exposures.length > 0 ? el('h3', {}, `Exposures affected (${exposures.length})`) : null,
      exposures.length > 0 ? rows(exposures) : null,
      el('h3', {}, `Downstream (${downstream.length})`),
      downstream.length > 0 ? rows(downstream) : el('p', { class: 'muted' }, 'Nothing downstream.'),
      changes.removed.length > 0 ? el('h3', {}, `Deleted (${changes.removed.length})`) : null,
      changes.removed.length > 0 ? files(changes.removed) : null,
      changes.unmapped.length > 0 ? el('h3', {}, `Other changed files (${changes.unmapped.length})`) : null,
      changes.unmapped.length > 0 ? files(changes.unmapped) : null,
      changes.command ? el('h3', {}, 'Build and test the impact') : null,
      changes.command ? el('pre', { class: 'command' }, changes.command) : null
    )
    this.mark()
  }

  /** Marks the rows of the node the page shows. */
  setCurrent(id: string | null): void {
    this.current = id
    this.mark()
  }

  private mark(): void {
    for (const row of this.root.querySelectorAll<HTMLElement>('.row.node')) {
      row.classList.toggle('current', row.dataset.id === this.current)
    }
  }

  private async fillLevel(list: HTMLUListElement, by: GroupBy, path: string): Promise<void> {
    list.replaceChildren(el('li', { class: 'muted loading' }, 'Loading…'))
    let level: CatalogLevel
    try {
      level = await this.events.loadLevel(by, path)
    } catch (cause) {
      list.replaceChildren()
      this.events.error(cause)
      return
    }
    fill(
      list,
      ...level.groups.map((group) => this.groupItem(by, group.key, group.label, group.count)),
      ...level.nodes.map((node) => el('li', {}, this.nodeRow(node))),
      level.more > 0 ? el('li', { class: 'muted' }, `${level.more} more: search or use a selector to narrow.`) : null
    )
    if (level.groups.length === 0 && level.nodes.length === 0) list.replaceChildren(el('li', { class: 'muted' }, 'Nothing here.'))
    this.mark()
  }

  private groupItem(by: GroupBy, key: string, label: string, count: number): HTMLLIElement {
    const caret = el('span', { class: 'caret' }, '▸')
    const row = el('button', { class: 'row group', type: 'button', title: key }, caret, el('span', { class: 'label' }, label), el('span', { class: 'count' }, String(count)))
    const children = el('ul', { class: 'tree', hidden: true })
    row.addEventListener('click', () => {
      const opening = children.hidden
      children.hidden = !opening
      caret.textContent = opening ? '▾' : '▸'
      if (opening && children.childElementCount === 0) void this.fillLevel(children, by, key)
    })
    return el('li', {}, row, children)
  }

  private nodeRow(node: NodeSummary | ChangedNode, action: 'open' | 'show' = 'open'): HTMLButtonElement {
    const changed = 'change' in node
    const row = el(
      'button',
      {
        class: 'row node',
        type: 'button',
        'data-id': node.id,
        title: `${node.id}\n${node.parents} upstream · ${node.children} downstream${changed ? `\n${node.files.join('\n')}` : ''}`
      },
      swatch(node.type),
      el('span', { class: 'label' }, node.name),
      changed ? changeTag(node.change) : null,
      el('span', { class: 'count' }, node.type)
    )
    row.addEventListener('click', () => (action === 'open' ? this.events.open(node.id) : this.events.show(node.id)))
    if (action === 'show') row.addEventListener('dblclick', () => this.events.open(node.id))
    return row
  }
}
