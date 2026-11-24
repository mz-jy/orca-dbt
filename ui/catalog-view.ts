// The catalog explorer: every node grouped by folder, tag, schema, type, package or owner in a
// lazily loaded tree, or a flat list of search or selector results.
import type { CatalogLevel, GroupBy, NodeSummary } from '../src/protocol'
import { el, fill, swatch } from './dom'

export type CatalogViewEvents = {
  /** A node was chosen. */
  open(id: string): void
  loadLevel(by: GroupBy, path: string): Promise<CatalogLevel>
  groupBy(by: GroupBy): void
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

  private nodeRow(node: NodeSummary): HTMLButtonElement {
    const row = el(
      'button',
      { class: 'row node', type: 'button', 'data-id': node.id, title: `${node.id}\n${node.parents} upstream · ${node.children} downstream` },
      swatch(node.type),
      el('span', { class: 'label' }, node.name),
      el('span', { class: 'count' }, node.type)
    )
    row.addEventListener('click', () => this.events.open(node.id))
    return row
  }
}
