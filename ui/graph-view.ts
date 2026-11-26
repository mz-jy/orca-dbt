// The lineage graph: lays a LineageGraph out with dagre (vendored, the frame has no network) and
// draws it as SVG, with pan, zoom, chain highlighting, the +n pills that reveal hidden neighbours,
// and optional clusters (by folder, tag, schema, owner, package or a meta key).
//
// Two levels of detail: zoomed in, each node is a card with its name, type and marks; zoomed out,
// a dot in its type's colour, ringed when it changed or its tests fail, so a big graph still reads
// as a map. Dots, rings and edges keep their size on screen at any zoom.
//
// Performance: the layout is computed once per graph, orientation and grouping, and cached; test
// flags, change marks and selection only touch the nodes' marks and classes. Pan and zoom write
// one transform per animation frame.
import { Graph, layout, type Point } from '../vendor/dagre.esm.js'
import type { ChangeKind, Direction, GraphNodeView, LineageGraph, QualityFlag } from '../src/protocol'
import { CHANGE_LABELS, CHANGE_LETTERS, flagTitle, isProblem, STATUS_ICONS, svgEl, typeColor, typeLabel } from './dom'

export type Orientation = 'LR' | 'TB'
/** How the graph clusters its nodes: not at all, by a node property, or by a meta key (`meta:owner`). */
export type GraphGrouping = 'none' | 'folder' | 'tag' | 'schema' | 'owner' | 'package' | `meta:${string}`

export type GraphViewEvents = {
  /** A click on a node (or on the background: null). */
  select(id: string | null): void
  /** A double-click on a node. */
  focus(id: string): void
  /** A click on a node's +n pill. */
  expand(id: string, direction: Direction): void
}

/** Cards are as wide as the graph's longest name needs, between these; longer names lose their middle. */
const MIN_NODE_WIDTH = 216
const MAX_NODE_WIDTH = 340
/** The drawn graph's card width (one graph is drawn at a time). */
let NODE_WIDTH = MIN_NODE_WIDTH
const NODE_HEIGHT = 50
const PAD = 14
/** Fitting the whole graph below this zoom makes labels unreadable... */
const MIN_FIT_SCALE = 0.6
/** ...so the view centres on the focused node at this zoom instead, as much graph on screen as fits. */
const FOCUS_SCALE = 0.75
const MIN_SCALE = 0.04
const MAX_SCALE = 3
/** Below this zoom nodes are dots; above it, cards. Two thresholds, so it does not flicker. */
const DOTS_BELOW = 0.5
const CARDS_ABOVE = 0.56
/** Dots get their names beside them from this zoom up (there is room for a line of text). */
const NAMES_ABOVE = 0.2
const NAME_FONT = 11
/** Lanes reach this far past their nodes, with room for the label on top. */
const CLUSTER_PAD = 12
const CLUSTER_LABEL = 22

type Layout = {
  positions: Map<string, Point>
  /** Each edge's path as cards (ends on the cards' borders) and as dots (ends at the centres). */
  edges: { from: string; to: string; card: string; dot: string }[]
  clusters: { key: string; label: string; count: number; x: number; y: number; width: number; height: number }[]
  width: number
  height: number
  nodeWidth: number
}

export class GraphView {
  orientation: Orientation
  private grouping: GraphGrouping
  private graph: LineageGraph | null = null
  private layoutCache: { graph: LineageGraph; orientation: Orientation; grouping: GraphGrouping; layout: Layout } | null = null
  /** Each drawn node's parents and children within the graph, for highlighting chains. */
  private ups = new Map<string, string[]>()
  private downs = new Map<string, string[]>()
  private nodeElements = new Map<string, SVGGElement>()
  private edgeElements: { element: SVGPathElement; from: string; to: string; card: string; dot: string }[] = []
  private selected: string | null = null
  private view = { x: 0, y: 0, k: 1 }
  private dots = false
  /** The view is as fit() left it (no pan or zoom since). */
  private fitted = false
  /** How many pixels a dot's name may take at the current zoom (0: names hidden), in steps. */
  private nameRoom = 0
  private frame = 0
  private bounds = { width: 0, height: 0 }
  private focusCenter: Point | null = null
  /** Nodes the branch changed, marked in every graph the page draws. */
  private marks: Record<string, ChangeKind> = {}
  /** Nodes' test results, flagged in every graph the page draws. */
  private flags: Record<string, QualityFlag> = {}
  /** Where the view starts when the graph has no focus and is too big to fit: the most upstream of these. */
  private centerOn: readonly string[] = []
  private readonly viewport: SVGGElement
  private readonly clustersLayer: SVGGElement
  private readonly edgesLayer: SVGGElement
  private readonly nodesLayer: SVGGElement
  private readonly measure = document.createElement('canvas').getContext('2d')!
  private readonly clipped = new Map<string, string>()
  private fontFamily = ''

  constructor(
    private readonly svg: SVGSVGElement,
    private readonly emptyNote: HTMLElement,
    private readonly events: GraphViewEvents,
    orientation: Orientation,
    grouping: GraphGrouping
  ) {
    this.orientation = orientation
    this.grouping = grouping
    this.viewport = svg.querySelector('#viewport')!
    this.clustersLayer = svg.querySelector('#clusters')!
    this.edgesLayer = svg.querySelector('#edges')!
    this.nodesLayer = svg.querySelector('#nodes')!
    this.listen()
    let size = { width: 0, height: 0 }
    new ResizeObserver(([entry]) => {
      const next = { width: Math.round(entry.contentRect.width), height: Math.round(entry.contentRect.height) }
      if (next.width === size.width && next.height === size.height) return
      const before = size
      size = next
      if (!this.graph) return
      // Untouched since it was fitted: fit again. Panned or zoomed: keep the same middle in view.
      if (this.fitted || !before.width) return this.fit()
      this.view.x += (next.width - before.width) / 2
      this.view.y += (next.height - before.height) / 2
      this.applyView(true)
    }).observe(svg)
  }

  /** How many nodes are drawn. */
  get size(): number {
    return this.graph?.nodes.length ?? 0
  }

  /** The meta keys the drawn nodes have, to group by. */
  metaKeys(): string[] {
    const keys = new Set<string>()
    for (const node of this.graph?.nodes ?? []) for (const key of Object.keys(node.meta)) keys.add(key)
    return [...keys].sort()
  }

  /**
   * Draws `graph` (or the `empty` element when there is nothing to draw) and fits it; a graph too
   * big to fit readably centres on its focus, else on the most upstream of `centerOn`, else on its middle.
   */
  show(graph: LineageGraph | null, empty: HTMLElement | null, centerOn: readonly string[] = []): void {
    this.graph = graph
    this.centerOn = centerOn
    if (empty) this.emptyNote.replaceChildren(empty)
    this.draw()
    this.fit()
  }

  setOrientation(orientation: Orientation): void {
    this.orientation = orientation
    this.draw()
    this.fit()
  }

  setGrouping(grouping: GraphGrouping): void {
    if (grouping === this.grouping) return
    this.grouping = grouping
    this.draw()
    this.fit()
  }

  setMarks(marks: Record<string, ChangeKind>): void {
    this.marks = marks
    this.redrawNodes()
  }

  setFlags(flags: Record<string, QualityFlag>): void {
    this.flags = flags
    this.redrawNodes()
  }

  /** Highlights `id`'s upstream and downstream chains and dims the rest. */
  select(id: string | null): void {
    if (id === this.selected) return
    this.selected = id
    this.highlight()
  }

  /**
   * Fits the whole graph, unless that would be too small to read and `whole` is false: then it
   * centres on the focused node (a selector's graph has none: on its middle) at a readable zoom.
   */
  fit(whole = false): void {
    const { width, height } = this.svg.getBoundingClientRect()
    if (!this.bounds.width || !width) return
    const k = Math.min((width - 48) / this.bounds.width, (height - 96) / this.bounds.height, 1.15)
    // Too big to read whole: a lineage opens on its node; a selection or the changes open as an
    // overview (dots), unless they name a node to start from.
    if (whole || k >= MIN_FIT_SCALE || !this.focusCenter) {
      this.view = { k, x: (width - this.bounds.width * k) / 2, y: (height - this.bounds.height * k) / 2 }
    } else {
      const center = this.focusCenter ?? { x: this.bounds.width / 2, y: this.bounds.height / 2 }
      const k = FOCUS_SCALE
      // Centre on the node, but slide so no empty margin shows where the graph could fill it.
      const clamp = (offset: number, view: number, size: number) =>
        size * k <= view ? (view - size * k) / 2 : Math.min(0, Math.max(view - size * k, offset))
      this.view = {
        k,
        x: clamp(width / 2 - center.x * k, width, this.bounds.width),
        y: clamp(height / 2 - center.y * k, height, this.bounds.height)
      }
    }
    this.fitted = true
    this.applyView(true)
  }

  /** Zooms about the middle of the view. */
  zoom(factor: number): void {
    const { width, height } = this.svg.getBoundingClientRect()
    this.zoomAt(width / 2, height / 2, this.view.k * factor)
  }

  private zoomAt(cx: number, cy: number, next: number): void {
    const { x, y, k } = this.view
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next))
    this.view = { k: scale, x: cx - ((cx - x) * scale) / k, y: cy - ((cy - y) * scale) / k }
    this.fitted = false
    this.applyView()
  }

  // ---------- Layout ----------

  /** The cluster a node belongs to under the current grouping; null: none. */
  private clusterOf(node: GraphNodeView): string | null {
    const grouping = this.grouping
    if (grouping === 'none') return null
    if (grouping === 'folder') return node.folder || '(project root)'
    if (grouping === 'tag') return node.tags[0] ?? null
    if (grouping === 'schema') return node.schema
    if (grouping === 'owner') return node.owner
    if (grouping === 'package') return node.packageName || null
    return node.meta[grouping.slice('meta:'.length)] ?? null
  }

  private layout(graph: LineageGraph): Layout {
    const cached = this.layoutCache
    if (cached && cached.graph === graph && cached.orientation === this.orientation && cached.grouping === this.grouping) {
      NODE_WIDTH = cached.layout.nodeWidth
      return cached.layout
    }

    NODE_WIDTH = this.cardWidth(graph)
    const horizontal = this.orientation === 'LR'
    const laidOut = new Graph()
      .setGraph({ rankdir: this.orientation, nodesep: horizontal ? 18 : 28, ranksep: horizontal ? 60 : 52, marginx: 24, marginy: 24 })
      .setDefaultEdgeLabel(() => ({}))
    for (const node of graph.nodes) laidOut.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
    for (const [parent, child] of graph.edges) laidOut.setEdge(parent, child)
    layout(laidOut)

    const positions = new Map<string, Point>()
    for (const node of graph.nodes) {
      const { x, y } = laidOut.node(node.id)
      positions.set(node.id, { x, y })
    }
    let { width = 0, height = 0 } = laidOut.graph()
    let clusters: Layout['clusters'] = []
    let edges: Layout['edges']
    if (this.grouping !== 'none') {
      ;({ width, height, clusters } = this.lanes(graph, positions))
      // dagre's routes belong to its own positions: join the moved nodes with plain curves.
      edges = graph.edges.map(([from, to]) => ({ from, to, ...link(positions.get(from)!, positions.get(to)!, horizontal) }))
    } else {
      const edgePoints = graph.edges.map(([from, to]) => ({ from, to, points: laidOut.edge(from, to).points.map((point) => ({ ...point })) }))
      // dagre stacks unconnected pieces in one long row or column: tile them.
      ;({ width, height } = pack(graph, positions, edgePoints, width, height, this.svg.getBoundingClientRect()))
      edges = edgePoints.map(({ from, to, points }) => ({
        from,
        to,
        card: curve(points),
        dot: curve([positions.get(from)!, ...points.slice(1, -1), positions.get(to)!])
      }))
    }
    const result = { positions, edges, clusters, width, height, nodeWidth: NODE_WIDTH }
    this.layoutCache = { graph, orientation: this.orientation, grouping: this.grouping, layout: result }
    return result
  }

  /**
   * Swimlanes: each group a band across the graph (a column when vertical). Nodes keep dagre's
   * rank, so the flow still reads left to right (top to bottom), and dagre's order within a rank.
   */
  private lanes(graph: LineageGraph, positions: Map<string, Point>): Pick<Layout, 'width' | 'height' | 'clusters'> {
    const horizontal = this.orientation === 'LR'
    const along = horizontal ? 'x' : 'y'
    const across = horizontal ? 'y' : 'x'
    const size = horizontal ? NODE_HEIGHT : NODE_WIDTH
    const gap = horizontal ? 18 : 28
    const OTHER = '\u0000other'
    const members = new Map<string, string[]>()
    for (const node of graph.nodes) {
      const key = this.clusterOf(node) ?? OTHER
      members.set(key, [...(members.get(key) ?? []), node.id])
    }
    // Lanes in the order dagre placed their members, nodes without a group last.
    const firstAcross = (ids: string[]) => Math.min(...ids.map((id) => positions.get(id)![across]))
    const order = [...members.keys()].sort((a, b) => (a === OTHER ? 1 : b === OTHER ? -1 : firstAcross(members.get(a)!) - firstAcross(members.get(b)!)))

    // Ranks in flow order; a rank holding more than STACK nodes of one lane wraps into sub-columns.
    const STACK = 8
    const alongSize = horizontal ? NODE_WIDTH : NODE_HEIGHT
    const alongGap = horizontal ? 60 : 52
    const rankOf = new Map(graph.nodes.map((node) => [node.id, Math.round(positions.get(node.id)![along])]))
    const ranks = [...new Set(rankOf.values())].sort((a, b) => a - b)
    const cells = new Map<string, string[]>()
    for (const key of order) {
      for (const id of members.get(key)!) {
        const cell = `${key}\u0000${rankOf.get(id)}`
        cells.set(cell, [...(cells.get(cell) ?? []), id])
      }
    }
    for (const ids of cells.values()) ids.sort((a, b) => positions.get(a)![across] - positions.get(b)![across])
    const rankStart = new Map<number, number>()
    let alongCursor = 24 + (horizontal ? 0 : CLUSTER_LABEL)
    for (const rank of ranks) {
      const columns = Math.max(1, ...order.map((key) => Math.ceil((cells.get(`${key}\u0000${rank}`)?.length ?? 0) / STACK)))
      rankStart.set(rank, alongCursor)
      alongCursor += columns * alongSize + (columns - 1) * 40 + alongGap
    }
    const alongExtent = alongCursor - alongGap + 24

    const clusters: Layout['clusters'] = []
    let cursor = 24
    const head = horizontal ? CLUSTER_LABEL : 0
    for (const key of order) {
      const ids = members.get(key)!
      let depth = 0
      for (const rank of ranks) {
        const column = cells.get(`${key}\u0000${rank}`) ?? []
        column.forEach((id, index) => {
          const point = positions.get(id)!
          point[along] = rankStart.get(rank)! + Math.floor(index / STACK) * (alongSize + 40) + alongSize / 2
          point[across] = cursor + head + CLUSTER_PAD + (index % STACK) * (size + gap) + size / 2
        })
        depth = Math.max(depth, Math.min(column.length, STACK))
      }
      const extent = head + CLUSTER_PAD * 2 + depth * size + (depth - 1) * gap
      const label = key === OTHER ? `No ${this.groupingLabel()}` : key
      clusters.push(
        horizontal
          ? { key, label, count: ids.length, x: 8, y: cursor, width: alongExtent - 16, height: extent }
          : { key, label, count: ids.length, x: cursor, y: 8, width: extent, height: alongExtent - 16 }
      )
      cursor += extent + 16
    }
    return horizontal ? { width: alongExtent, height: cursor + 8, clusters } : { width: cursor + 8, height: alongExtent, clusters }
  }

  /** Wide enough for the longest name (and the change chip), within the bounds. */
  private cardWidth(graph: LineageGraph): number {
    this.measure.font = `600 12.5px ${this.font()}`
    let longest = 0
    for (const node of graph.nodes) longest = Math.max(longest, this.measure.measureText(node.name).width)
    return Math.min(MAX_NODE_WIDTH, Math.max(MIN_NODE_WIDTH, Math.ceil(longest + PAD * 2 + 26 + 22 + 2)))
  }

  private groupingLabel(): string {
    return this.grouping.startsWith('meta:') ? this.grouping.slice('meta:'.length) : this.grouping
  }

  // ---------- Drawing ----------

  private draw(): void {
    this.clustersLayer.replaceChildren()
    this.edgesLayer.replaceChildren()
    this.nodesLayer.replaceChildren()
    this.nodeElements.clear()
    this.edgeElements = []
    const graph = this.graph
    const empty = !graph || graph.nodes.length === 0
    this.emptyNote.hidden = !empty
    this.svg.classList.toggle('is-empty', empty)
    if (empty) {
      this.bounds = { width: 0, height: 0 }
      return
    }

    const laid = this.layout(graph)
    this.bounds = { width: laid.width, height: laid.height }
    this.ups = new Map(graph.nodes.map((node) => [node.id, []]))
    this.downs = new Map(graph.nodes.map((node) => [node.id, []]))
    for (const [parent, child] of graph.edges) {
      this.ups.get(child)?.push(parent)
      this.downs.get(parent)?.push(child)
    }

    const axis = this.orientation === 'LR' ? 'x' : 'y'
    const centerId =
      graph.focus ??
      this.centerOn
        .filter((id) => laid.positions.has(id))
        .reduce<string | null>((best, id) => (best === null || laid.positions.get(id)![axis] < laid.positions.get(best)![axis] ? id : best), null)
    this.focusCenter = centerId ? laid.positions.get(centerId)! : null

    for (const cluster of laid.clusters) {
      const group = svgEl('g', { class: 'cluster', transform: `translate(${cluster.x},${cluster.y})` }, this.clustersLayer)
      svgEl('title', {}, group).textContent = `${cluster.label}: ${cluster.count} node${cluster.count === 1 ? '' : 's'}`
      svgEl('rect', { class: 'cluster-box', width: cluster.width, height: cluster.height, rx: 12 }, group)
      const label = svgEl('text', { class: 'cluster-label', x: 12, y: 7 }, group)
      label.textContent = this.clip(cluster.label, `600 11px ${this.font()}`, cluster.width - 60)
      svgEl('tspan', { class: 'cluster-count', dx: 6 }, label).textContent = String(cluster.count)
    }

    const fragment = document.createDocumentFragment()
    for (const edge of laid.edges) {
      const element = svgEl('path', { class: 'edge', d: this.dots ? edge.dot : edge.card }, fragment as unknown as Element)
      this.edgeElements.push({ element, ...edge })
    }
    this.edgesLayer.append(fragment)

    const nodes = document.createDocumentFragment()
    for (const node of graph.nodes) {
      const { x, y } = laid.positions.get(node.id)!
      const group = svgEl('g', { transform: `translate(${x - NODE_WIDTH / 2},${y - NODE_HEIGHT / 2})`, 'data-id': node.id, tabindex: 0 }, nodes as unknown as Element)
      this.nodeElements.set(node.id, group)
      this.drawNode(group, node, node.id === graph.focus)
    }
    this.nodesLayer.append(nodes)
    this.nameRoom = -1
    this.highlight(true)
  }

  /** Redraws each node's content in place, for new marks or flags: no layout, no edges. */
  private redrawNodes(): void {
    const graph = this.graph
    if (!graph) return
    for (const node of graph.nodes) {
      const group = this.nodeElements.get(node.id)
      if (!group) continue
      group.replaceChildren()
      this.drawNode(group, node, node.id === graph.focus)
    }
    this.highlight(true)
  }

  private font(): string {
    if (!this.fontFamily) this.fontFamily = getComputedStyle(document.body).fontFamily
    return this.fontFamily
  }

  private drawNode(group: SVGGElement, node: GraphNodeView, isFocus: boolean): void {
    const change = this.marks[node.id]
    const flag = this.flags[node.id]
    const problem = flag && isProblem(flag.status)
    group.setAttribute(
      'class',
      ['node', isFocus ? 'focus' : '', change ? `changed changed-${change}` : '', problem ? `problem status-${flag.status}` : ''].filter(Boolean).join(' ')
    )
    group.style.setProperty('--type', typeColor(node.type))
    svgEl('title', {}, group).textContent = [
      node.name,
      `${typeLabel(node.type)}${node.materialized ? ` · ${node.materialized}` : ''}`,
      node.relation ?? node.id,
      change ? `Changed in this branch: ${CHANGE_LABELS[change]}` : '',
      flag ? flagTitle(flag) : '',
      'Double-click to centre the lineage on it'
    ]
      .filter(Boolean)
      .join('\n')

    // Zoomed out: a dot (its ring says changed or failing).
    svgEl('circle', { class: 'dot', cx: NODE_WIDTH / 2, cy: NODE_HEIGHT / 2 }, group)
    // Its whole name shows over the dot when it is the focus, selected or hovered...
    svgEl('text', { class: 'dot-label', x: NODE_WIDTH / 2, y: NODE_HEIGHT / 2 }, group).textContent = node.name
    // ...and every dot's name, cut to the room there is, beside it once zoomed in far enough.
    const name = svgEl('text', { class: `dot-name ${this.orientation === 'LR' ? 'beside' : 'below'}`, x: NODE_WIDTH / 2, y: NODE_HEIGHT / 2 }, group)
    name.dataset.name = node.name
    if (this.nameRoom > 0) name.textContent = this.clip(node.name, `500 ${NAME_FONT}px ${this.font()}`, this.nameRoom)

    // Zoomed in: the card.
    const card = svgEl('g', { class: 'card' }, group)
    svgEl('rect', { class: 'box', width: NODE_WIDTH, height: NODE_HEIGHT, rx: 8 }, card)
    svgEl('circle', { class: 'type-dot', cx: PAD + 3, cy: 18, r: 4 }, card)
    let nameRoom = NODE_WIDTH - PAD - 26 - PAD
    if (change) {
      svgEl('rect', { class: 'change-chip', x: NODE_WIDTH - PAD - 16, y: 10, width: 16, height: 16, rx: 4 }, card)
      svgEl('text', { class: 'change-letter', x: NODE_WIDTH - PAD - 8, y: 18.5 }, card).textContent = CHANGE_LETTERS[change]
      nameRoom -= 22
    }
    let metaRoom = NODE_WIDTH - PAD * 2
    if (flag) {
      const mark = svgEl('g', { class: `test-flag status-${flag.status}${problem ? ' problem' : ''}` }, card)
      if (problem) {
        svgEl('circle', { cx: NODE_WIDTH - PAD - 7, cy: 35, r: 7 }, mark)
        svgEl('text', { x: NODE_WIDTH - PAD - 7, y: 35.5 }, mark).textContent = STATUS_ICONS[flag.status]
      } else {
        svgEl('circle', { cx: NODE_WIDTH - PAD - 4, cy: 35, r: 3.5 }, mark)
      }
      metaRoom -= 22
    }
    const font = this.font()
    svgEl('text', { class: 'name', x: PAD + 13, y: 22 }, card).textContent = this.clip(node.name, `600 12.5px ${font}`, nameRoom)
    const meta = [typeLabel(node.type), node.materialized && node.materialized !== node.type ? node.materialized : null].filter(Boolean).join(' · ')
    svgEl('text', { class: 'meta', x: PAD, y: 39 }, card).textContent = this.clip(meta, `11px ${font}`, metaRoom)

    // Horizontal: parents' pill on the left edge, children's on the right. Vertical: on the top
    // and bottom edges, left of centre, off the arrows that meet in the middle.
    const pill = (count: number, direction: Direction) => {
      if (count === 0) return
      const text = count > 99 ? '99+' : `+${count}`
      const w = 12 + text.length * 6
      const [cx, cy] =
        this.orientation === 'LR' ? [direction === 'up' ? 0 : NODE_WIDTH, NODE_HEIGHT / 2] : [36, direction === 'up' ? 0 : NODE_HEIGHT]
      const element = svgEl('g', { class: 'expand', 'data-direction': direction }, card)
      svgEl('title', {}, element).textContent = `Show ${count} more ${direction === 'up' ? (count === 1 ? 'parent' : 'parents') : count === 1 ? 'child' : 'children'}`
      svgEl('rect', { x: cx - w / 2, y: cy - 9, width: w, height: 18, rx: 9 }, element)
      svgEl('text', { x: cx, y: cy + 0.5 }, element).textContent = text
    }
    pill(node.hiddenParents, 'up')
    pill(node.hiddenChildren, 'down')
  }

  /**
   * `text` fitted to `maxWidth` pixels, its middle replaced by an ellipsis when too long: dbt names
   * share prefixes (stg_, int_…) and differ at either end. Memoized: redraws measure nothing.
   */
  private clip(text: string, font: string, maxWidth: number): string {
    const key = `${font}|${maxWidth}|${text}`
    const known = this.clipped.get(key)
    if (known !== undefined) return known
    this.measure.font = font
    let result = text
    if (this.measure.measureText(text).width > maxWidth) {
      const cut = (keep: number) => {
        const head = Math.ceil(keep * 0.55)
        return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`
      }
      let low = 0
      let high = text.length - 1
      while (low < high) {
        const mid = (low + high + 1) >> 1
        if (this.measure.measureText(cut(mid)).width <= maxWidth) low = mid
        else high = mid - 1
      }
      result = low > 0 ? cut(low) : '…'
    }
    if (this.clipped.size > 20_000) this.clipped.clear()
    this.clipped.set(key, result)
    return result
  }

  /** Dims everything outside the selected node's upstream and downstream chains. */
  private highlight(force = false): void {
    const graph = this.graph
    const selected = this.selected
    for (const [id, element] of this.nodeElements) element.classList.toggle('selected', id === selected)
    // The focused node's chains are the whole graph: highlight only another node's.
    if (!graph || !selected || selected === graph.focus || !this.nodeElements.has(selected)) {
      if (force || this.svg.classList.contains('has-selection')) {
        this.svg.classList.remove('has-selection')
        for (const element of this.nodeElements.values()) element.classList.remove('dim')
        for (const edge of this.edgeElements) edge.element.classList.remove('dim', 'lit')
      }
      return
    }
    const reach = (links: Map<string, string[]>): Set<string> => {
      const seen = new Set([selected])
      const queue = [selected]
      while (queue.length > 0) {
        for (const next of links.get(queue.pop()!) ?? []) {
          if (!seen.has(next)) {
            seen.add(next)
            queue.push(next)
          }
        }
      }
      return seen
    }
    const upstream = reach(this.ups)
    const downstream = reach(this.downs)
    this.svg.classList.add('has-selection')
    for (const [id, element] of this.nodeElements) element.classList.toggle('dim', !upstream.has(id) && !downstream.has(id))
    for (const edge of this.edgeElements) {
      const lit = (upstream.has(edge.from) && upstream.has(edge.to)) || (downstream.has(edge.from) && downstream.has(edge.to))
      edge.element.classList.toggle('lit', lit)
      edge.element.classList.toggle('dim', !lit)
    }
  }

  // ---------- View ----------

  /** Writes the view on the next animation frame (or now): one transform per frame while panning. */
  private applyView(now = false): void {
    if (now) {
      cancelAnimationFrame(this.frame)
      this.frame = 0
      this.writeView()
      return
    }
    if (!this.frame) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0
        this.writeView()
      })
    }
  }

  private writeView(): void {
    const { x, y, k } = this.view
    this.viewport.setAttribute('transform', `translate(${x},${y}) scale(${k})`)
    const dots = this.dots ? k < CARDS_ABOVE : k < DOTS_BELOW
    // Dots, rings and cluster labels keep their size on screen (cards need no --k: no restyle).
    if (dots) this.svg.style.setProperty('--k', String(k))
    if (dots !== this.dots) {
      this.dots = dots
      this.svg.classList.toggle('dots', dots)
      for (const edge of this.edgeElements) edge.element.setAttribute('d', dots ? edge.dot : edge.card)
    }
    this.writeNames(dots && k >= NAMES_ABOVE ? k : 0)
    // The dot grid behind the graph pans and zooms with it (sparser when far out).
    const area = this.svg.parentElement
    if (area) {
      let step = 20 * k
      while (step < 10) step *= 4
      area.style.setProperty('--grid-size', `${step}px`)
      area.style.setProperty('--grid-x', `${x % step}px`)
      area.style.setProperty('--grid-y', `${y % step}px`)
    }
  }

  /**
   * Dots' names, cut to the gap to the next dot along the flow (beside, horizontal) or across it
   * (below, vertical) at zoom `k`; 0 hides them. Recut only when the room changes by a step.
   */
  private writeNames(k: number): void {
    const pitch = this.orientation === 'LR' ? NODE_WIDTH + 60 : NODE_WIDTH + 28
    const room = k > 0 ? Math.min(320, Math.floor((pitch * k - 18) / 12) * 12) : 0
    if (room === this.nameRoom) return
    this.nameRoom = room
    this.svg.classList.toggle('named', room > 0)
    if (room <= 0) return
    const font = `500 ${NAME_FONT}px ${this.font()}`
    for (const label of this.nodesLayer.querySelectorAll<SVGTextElement>('.dot-name')) {
      label.textContent = this.clip(label.dataset.name ?? '', font, room)
    }
  }

  private listen(): void {
    const svg = this.svg
    let drag: { pointerX: number; pointerY: number; viewX: number; viewY: number; moved: boolean } | null = null
    let suppressClick = false

    svg.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || (event.target as Element).closest('.node')) return
      drag = { pointerX: event.clientX, pointerY: event.clientY, viewX: this.view.x, viewY: this.view.y, moved: false }
      svg.setPointerCapture(event.pointerId)
    })
    svg.addEventListener('pointermove', (event) => {
      if (!drag) return
      const dx = event.clientX - drag.pointerX
      const dy = event.clientY - drag.pointerY
      if (!drag.moved && Math.hypot(dx, dy) < 3) return
      drag.moved = true
      this.fitted = false
      svg.classList.add('panning')
      this.view.x = drag.viewX + dx
      this.view.y = drag.viewY + dy
      this.applyView()
    })
    svg.addEventListener('pointerup', () => {
      suppressClick = drag?.moved ?? false
      drag = null
      svg.classList.remove('panning')
    })
    svg.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault()
        const rect = svg.getBoundingClientRect()
        this.zoomAt(event.clientX - rect.left, event.clientY - rect.top, this.view.k * Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015)))
      },
      { passive: false }
    )
    svg.addEventListener('click', (event) => {
      if (suppressClick) {
        suppressClick = false
        return
      }
      const target = event.target as Element
      const node = target.closest<SVGGElement>('.node')
      const pill = target.closest<SVGGElement>('.expand')
      if (node && pill && !this.dots) this.events.expand(node.dataset.id!, pill.dataset.direction as Direction)
      else this.events.select(node ? node.dataset.id! : null)
    })
    svg.addEventListener('dblclick', (event) => {
      const target = event.target as Element
      const node = target.closest<SVGGElement>('.node')
      if (node && !target.closest('.expand')) this.events.focus(node.dataset.id!)
    })
    svg.addEventListener('keydown', (event) => {
      const node = (event.target as Element).closest<SVGGElement>('.node')
      if (!node || event.key !== 'Enter') return
      if (event.shiftKey) this.events.focus(node.dataset.id!)
      else this.events.select(node.dataset.id!)
    })
  }
}

/**
 * Tiles the graph's connected pieces in rows, biggest first, toward the view's shape, moving
 * `positions` and the edges' points in place; returns the new size. One piece: left as is.
 */
function pack(
  graph: LineageGraph,
  positions: Map<string, Point>,
  edges: { from: string; to: string; points: Point[] }[],
  width: number,
  height: number,
  view: { width: number; height: number }
): { width: number; height: number } {
  const root = new Map(graph.nodes.map((node) => [node.id, node.id]))
  const find = (id: string): string => {
    let at = id
    while (root.get(at) !== at) at = root.get(at)!
    root.set(id, at)
    return at
  }
  for (const [from, to] of graph.edges) root.set(find(from), find(to))
  const pieces = new Map<string, { ids: string[]; left: number; top: number; right: number; bottom: number }>()
  for (const node of graph.nodes) {
    const key = find(node.id)
    const { x, y } = positions.get(node.id)!
    const piece = pieces.get(key) ?? { ids: [], left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }
    piece.ids.push(node.id)
    piece.left = Math.min(piece.left, x - NODE_WIDTH / 2)
    piece.right = Math.max(piece.right, x + NODE_WIDTH / 2)
    piece.top = Math.min(piece.top, y - NODE_HEIGHT / 2)
    piece.bottom = Math.max(piece.bottom, y + NODE_HEIGHT / 2)
    pieces.set(key, piece)
  }
  if (pieces.size < 2) return { width, height }

  const GAP = 40
  const MARGIN = 24
  const list = [...pieces.values()].sort((a, b) => b.bottom - b.top - (a.bottom - a.top) || a.ids[0].localeCompare(b.ids[0]))
  const area = list.reduce((sum, piece) => sum + (piece.right - piece.left + GAP) * (piece.bottom - piece.top + GAP), 0)
  const aspect = view.width > 0 && view.height > 0 ? view.width / view.height : 1.5
  const widest = Math.max(...list.map((piece) => piece.right - piece.left))
  const rowWidth = Math.max(widest, Math.sqrt(area * aspect))
  const shift = new Map<string, Point>()
  let [x, y, rowHeight, maxX] = [MARGIN, MARGIN, 0, 0]
  for (const piece of list) {
    const pieceWidth = piece.right - piece.left
    if (x > MARGIN && x + pieceWidth > MARGIN + rowWidth) {
      x = MARGIN
      y += rowHeight + GAP
      rowHeight = 0
    }
    const delta = { x: x - piece.left, y: y - piece.top }
    for (const id of piece.ids) {
      const point = positions.get(id)!
      positions.set(id, { x: point.x + delta.x, y: point.y + delta.y })
      shift.set(id, delta)
    }
    x += pieceWidth + GAP
    maxX = Math.max(maxX, x - GAP)
    rowHeight = Math.max(rowHeight, piece.bottom - piece.top)
  }
  for (const edge of edges) {
    const delta = shift.get(edge.from)!
    for (const point of edge.points) {
      point.x += delta.x
      point.y += delta.y
    }
  }
  return { width: maxX + MARGIN, height: y + rowHeight + MARGIN }
}

/** An S-curve from one node to the next: border to border for cards, centre to centre for dots. */
function link(from: Point, to: Point, horizontal: boolean): { card: string; dot: string } {
  const path = (a: Point, b: Point) => {
    if (horizontal) {
      const bend = Math.max(30, Math.abs(b.x - a.x) / 2)
      return `M${a.x},${a.y}C${a.x + bend},${a.y},${b.x - bend},${b.y},${b.x},${b.y}`
    }
    const bend = Math.max(24, Math.abs(b.y - a.y) / 2)
    return `M${a.x},${a.y}C${a.x},${a.y + bend},${b.x},${b.y - bend},${b.x},${b.y}`
  }
  const card = horizontal
    ? path({ x: from.x + NODE_WIDTH / 2, y: from.y }, { x: to.x - NODE_WIDTH / 2, y: to.y })
    : path({ x: from.x, y: from.y + NODE_HEIGHT / 2 }, { x: to.x, y: to.y - NODE_HEIGHT / 2 })
  return { card, dot: path(from, to) }
}

/** A smooth path through dagre's edge points (d3's basis spline). */
function curve(points: readonly Point[]): string {
  const [first, second] = points
  if (points.length < 3) return `M${first.x},${first.y}L${second.x},${second.y}`
  let [x0, y0, x1, y1] = [first.x, first.y, second.x, second.y]
  let path = `M${x0},${y0}L${(5 * x0 + x1) / 6},${(5 * y0 + y1) / 6}`
  for (const { x, y } of [...points.slice(2), points[points.length - 1]]) {
    path += `C${(2 * x0 + x1) / 3},${(2 * y0 + y1) / 3},${(x0 + 2 * x1) / 3},${(y0 + 2 * y1) / 3},${(x0 + 4 * x1 + x) / 6},${(y0 + 4 * y1 + y) / 6}`
    ;[x0, y0, x1, y1] = [x1, y1, x, y]
  }
  return `${path}L${x1},${y1}`
}
