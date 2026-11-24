// The Changes pane: what the branch changed since its base, what that reaches downstream (the
// exposures first: those are dashboards people look at), and the command that builds it all.
import type { BranchChanges, ChangedNode, NodeSummary, QualityFlag } from '../src/protocol'
import { button, CHANGE_LABELS, CHANGE_LETTERS, changeTag, copyButton, el, emptyState, fill, flagTitle, isProblem, sectionHead, statusTag, swatch, typeLabel } from './dom'
import { icon } from './icons'

export type ChangesViewEvents = {
  /** A row was clicked: show the node, keep the changes graph. */
  show(id: string): void
  /** A row was double-clicked: draw the node's own lineage. */
  open(id: string): void
  refresh(): void
  parse(): void
}

export class ChangesView {
  private current: string | null = null
  private flags: Record<string, QualityFlag> = {}

  constructor(
    private readonly root: HTMLElement,
    private readonly events: ChangesViewEvents
  ) {}

  showLoading(): void {
    fill(this.root, el('div', { class: 'pane-body' }, emptyState('branch', 'Reading the branch…')))
  }

  show(changes: BranchChanges): void {
    if (!changes.ok) {
      fill(
        this.root,
        el('div', { class: 'pane-body' }, emptyState('branch', 'No branch to compare', changes.message, button('Try again', () => this.events.refresh(), { icon: 'refresh' }), 'warning'))
      )
      return
    }
    const exposures = changes.impacted.filter((node) => node.type === 'exposure')
    const downstream = changes.impacted.filter((node) => node.type !== 'exposure')
    const rows = (nodes: readonly (NodeSummary | ChangedNode)[]) => el('ul', { class: 'tree flat' }, ...nodes.map((node) => el('li', {}, this.nodeRow(node))))
    const files = (paths: readonly string[]) => el('ul', { class: 'file-list' }, ...paths.map((path) => el('li', {}, icon('file', 12), el('code', {}, path))))

    fill(
      this.root,
      el(
        'div',
        { class: 'pane-head' },
        el('h2', {}, 'Changes'),
        el('span', { class: 'spacer' }),
        button('', () => this.events.refresh(), { variant: 'ghost', icon: 'refresh', small: true, title: 'Read the branch again' })
      ),
      el(
        'div',
        { class: 'pane-body' },
        el(
          'div',
          { class: 'branch-card' },
          el(
            'div',
            { class: 'branch-line' },
            icon('branch', 13),
            el('code', { class: 'branch-head', title: changes.head }, changes.head),
            el('span', { class: 'muted' }, 'vs'),
            el('code', { title: `Merge base ${changes.mergeBase}` }, changes.base)
          ),
          el(
            'div',
            { class: 'stat-row' },
            stat(changes.changed.length, 'changed', 'changed'),
            stat(downstream.length, 'downstream'),
            stat(exposures.length, exposures.length === 1 ? 'exposure' : 'exposures', exposures.length > 0 ? 'exposure' : '')
          )
        ),
        changes.manifestStale
          ? el(
              'div',
              { class: 'callout warning' },
              icon('alert', 14),
              el('div', {}, el('p', {}, 'Files changed after the manifest was written. Parse to pick up new models and refs.'), button('Run dbt parse', () => this.events.parse(), { variant: 'primary', small: true }))
            )
          : null,
        changes.changed.length === 0 && changes.removed.length === 0 && changes.unmapped.length === 0
          ? emptyState('check', 'No dbt changes', `Nothing in the dbt project differs from ${changes.base}.`)
          : null,
        changes.changed.length > 0 ? el('section', { class: 'block' }, sectionHead('Changed', changes.changed.length), rows(changes.changed)) : null,
        exposures.length > 0 ? el('section', { class: 'block' }, sectionHead('Exposures affected', exposures.length), rows(exposures)) : null,
        downstream.length > 0 ? el('section', { class: 'block' }, sectionHead('Downstream', downstream.length), rows(downstream)) : null,
        changes.removed.length > 0 ? el('section', { class: 'block' }, sectionHead('Deleted', changes.removed.length), files(changes.removed)) : null,
        changes.unmapped.length > 0 ? el('section', { class: 'block' }, sectionHead('Other files', changes.unmapped.length), files(changes.unmapped)) : null,
        changes.command
          ? el(
              'section',
              { class: 'block' },
              sectionHead('Build and test the impact', null, copyButton(changes.command, 'Copy the command')),
              el('pre', { class: 'code-block' }, changes.command)
            )
          : null,
        changes.changed.length > 0
          ? el(
              'p',
              { class: 'legend' },
              ...(Object.keys(CHANGE_LETTERS) as (keyof typeof CHANGE_LETTERS)[]).map((kind) => el('span', {}, changeTag(kind), CHANGE_LABELS[kind]))
            )
          : null
      )
    )
    this.mark()
  }

  setCurrent(id: string | null): void {
    this.current = id
    this.mark()
  }

  setFlags(flags: Record<string, QualityFlag>): void {
    this.flags = flags
    this.mark()
  }

  private mark(): void {
    for (const row of this.root.querySelectorAll<HTMLElement>('.row.node')) {
      const id = row.dataset.id ?? ''
      row.classList.toggle('current', id === this.current)
      row.querySelector('.test-status')?.remove()
      const flag = this.flags[id]
      if (flag && isProblem(flag.status)) row.querySelector('.row-end')?.prepend(statusTag(flag.status, flagTitle(flag)))
    }
  }

  private nodeRow(node: NodeSummary | ChangedNode): HTMLButtonElement {
    const changed = 'change' in node
    const row = el(
      'button',
      {
        class: 'row node',
        type: 'button',
        'data-id': node.id,
        title: `${node.id}${changed ? `\n${node.files.join('\n')}` : ''}\nDouble-click to draw its own lineage`
      },
      swatch(node.type),
      el('span', { class: 'label' }, node.name),
      el('span', { class: 'row-end' }, changed ? changeTag(node.change) : el('span', { class: 'row-type' }, typeLabel(node.type)))
    )
    row.addEventListener('click', () => this.events.show(node.id))
    row.addEventListener('dblclick', () => this.events.open(node.id))
    return row
  }
}

function stat(value: number, label: string, tone = ''): HTMLElement {
  return el('div', { class: `stat ${tone}` }, el('span', { class: 'stat-value' }, value.toLocaleString()), el('span', { class: 'stat-label' }, label))
}
