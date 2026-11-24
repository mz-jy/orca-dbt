// The catalog pane: every node grouped by folder, tag, schema, type, package or owner in a lazily
// loaded tree, or a flat list of search or selector results.
import type { CatalogLevel, GroupBy, NodeSummary, QualityFlag } from '../src/protocol'
import { el, emptyState, fill, flagTitle, isProblem, statusTag, swatch, typeLabel } from './dom'
import { icon, type IconName } from './icons'

export type CatalogViewEvents = {
  /** A node was chosen: draw its lineage. */
  open(id: string): void
  loadLevel(by: GroupBy, path: string): Promise<CatalogLevel>
  groupBy(by: GroupBy): void
  error(cause: unknown): void
}

const GROUP_OPTIONS: [GroupBy, string][] = [
  ['none', 'None'],
  ['folder', 'Folder'],
  ['tag', 'Tag'],
  ['schema', 'Schema'],
  ['type', 'Resource type'],
  ['package', 'Package'],
  ['owner', 'Owner']
]

export class CatalogView {
  private current: string | null = null
  private groupSelect: HTMLSelectElement | null = null
  /** Nodes' test results, flagged beside their rows. */
  private flags: Record<string, QualityFlag> = {}

  constructor(
    private readonly root: HTMLElement,
    private readonly events: CatalogViewEvents
  ) {}

  /** The tree of groups, `by` the chosen grouping, its top level loaded. */
  showTree(by: GroupBy, total: number | null): void {
    const select = el('select', { class: 'select-compact', title: 'Group the catalog by' })
    this.fillGroupOptions(select, by, by.startsWith('meta:') ? [by.slice('meta:'.length)] : [])
    select.addEventListener('change', () => this.events.groupBy(select.value as GroupBy))
    const tree = el('ul', { class: `tree${by === 'none' ? ' flat' : ''}`, role: 'tree' })
    this.groupSelect = select
    fill(
      this.root,
      el(
        'div',
        { class: 'pane-head' },
        el('h2', {}, 'Catalog'),
        total !== null ? el('span', { class: 'count-badge' }, total.toLocaleString()) : null,
        el('span', { class: 'spacer' }),
        el('label', { class: 'inline-label' }, 'by', select)
      ),
      el('div', { class: 'pane-body' }, tree)
    )
    void this.fillLevel(tree, by, '')
  }

  /** None, the properties, then the project's meta keys. */
  private fillGroupOptions(select: HTMLSelectElement, by: GroupBy, metaKeys: readonly string[]): void {
    const meta = el('optgroup')
    meta.label = 'Meta'
    meta.append(...metaKeys.map((key) => new Option(key, `meta:${key}`)))
    select.replaceChildren(...GROUP_OPTIONS.map(([value, label]) => new Option(label, value)), ...(metaKeys.length > 0 ? [meta] : []))
    select.value = by
  }

  /** A flat list, such as search matches or what a selector selects. */
  showList(kind: 'search' | 'selector', heading: string, nodes: readonly NodeSummary[], note?: string): void {
    fill(
      this.root,
      el(
        'div',
        { class: 'pane-head' },
        el('span', { class: `head-icon` }, icon(kind === 'search' ? 'search' : 'graph', 13)),
        el('h2', {}, heading)
      ),
      el(
        'div',
        { class: 'pane-body' },
        note ? el('p', { class: 'pane-note' }, note) : null,
        nodes.length > 0
          ? el('ul', { class: 'tree flat' }, ...nodes.map((node) => el('li', {}, this.nodeRow(node, true))))
          : emptyState(kind === 'search' ? 'search' : 'graph', kind === 'search' ? 'No matches' : 'Nothing selected', kind === 'search' ? 'Search looks at names, columns and descriptions.' : undefined)
      )
    )
    this.mark()
  }

  /** A message instead of the catalog: no project, a bad selector, … */
  showMessage(title: string, text: string | undefined, tone: 'muted' | 'warning', action?: HTMLElement, iconName: IconName = tone === 'warning' ? 'alert' : 'catalog'): void {
    fill(this.root, el('div', { class: 'pane-body' }, emptyState(iconName, title, text, action, tone)))
  }

  /** Marks the rows of the node the page shows. */
  setCurrent(id: string | null): void {
    this.current = id
    this.mark()
  }

  setFlags(flags: Record<string, QualityFlag>): void {
    this.flags = flags
    this.mark()
  }

  /** The current node's row, and each row's test flag (rows load lazily, so after every fill). */
  private mark(): void {
    for (const row of this.root.querySelectorAll<HTMLElement>('.row.node')) {
      const id = row.dataset.id ?? ''
      row.classList.toggle('current', id === this.current)
      row.setAttribute('aria-selected', String(id === this.current))
      row.querySelector('.test-status')?.remove()
      const flag = this.flags[id]
      // Only problems earn a mark in a list: a column of green ticks is noise.
      if (flag && isProblem(flag.status)) row.querySelector('.row-end')?.prepend(statusTag(flag.status, flagTitle(flag)))
    }
  }

  private async fillLevel(list: HTMLUListElement, by: GroupBy, path: string): Promise<void> {
    list.replaceChildren(el('li', { class: 'tree-note' }, 'Loading…'))
    let level: CatalogLevel
    try {
      level = await this.events.loadLevel(by, path)
    } catch (cause) {
      list.replaceChildren()
      this.events.error(cause)
      return
    }
    if (level.metaKeys && this.groupSelect) this.fillGroupOptions(this.groupSelect, by, level.metaKeys)
    fill(
      list,
      ...level.groups.map((group) => this.groupItem(by, group.key, group.label, group.count)),
      ...level.nodes.map((node) => el('li', { role: 'treeitem' }, this.nodeRow(node, by !== 'type'))),
      level.more > 0 ? el('li', { class: 'tree-note' }, `${level.more} more: search or use a selector to narrow.`) : null
    )
    if (level.groups.length === 0 && level.nodes.length === 0) list.replaceChildren(el('li', { class: 'tree-note' }, 'Nothing here.'))
    this.mark()
  }

  private groupItem(by: GroupBy, key: string, label: string, count: number): HTMLLIElement {
    const caret = el('span', { class: 'caret' }, icon('chevronRight', 12))
    const row = el(
      'button',
      { class: 'row group', type: 'button', title: key, 'aria-expanded': 'false' },
      caret,
      el('span', { class: 'label' }, label),
      el('span', { class: 'row-end' }, el('span', { class: 'row-count' }, count.toLocaleString()))
    )
    const children = el('ul', { class: 'tree', hidden: true, role: 'group' })
    row.addEventListener('click', () => {
      const opening = children.hidden
      children.hidden = !opening
      row.setAttribute('aria-expanded', String(opening))
      row.classList.toggle('open', opening)
      if (opening && children.childElementCount === 0) void this.fillLevel(children, by, key)
    })
    return el('li', { role: 'treeitem' }, row, children)
  }

  private nodeRow(node: NodeSummary, showType: boolean): HTMLButtonElement {
    const row = el(
      'button',
      {
        class: 'row node',
        type: 'button',
        'data-id': node.id,
        title: `${node.id}\n${node.parents} upstream · ${node.children} downstream`
      },
      swatch(node.type),
      el('span', { class: 'label' }, node.name),
      el('span', { class: 'row-end' }, showType ? el('span', { class: 'row-type' }, typeLabel(node.type)) : null)
    )
    row.addEventListener('click', () => this.events.open(node.id))
    return row
  }
}
