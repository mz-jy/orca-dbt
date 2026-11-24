// The lineage graph: lays a LineageGraph out with dagre (vendored, the frame has no network) and
// draws it as SVG, with pan, zoom, chain highlighting and the +n badges that reveal hidden
// neighbours. It reports clicks; the page decides what they mean.
import { Graph, layout, type Point } from '../vendor/dagre.esm.js'
import type { Direction, GraphNodeView, LineageGraph } from '../src/protocol'
import { svgEl, typeColor } from './dom'

export type Orientation = 'LR' | 'TB'

export type GraphViewEvents = {
  /** A click on a node (or on the background: null). */
  select(id: string | null): void
  /** A double-click on a node. */
  focus(id: string): void
  /** A click on a node's +n badge. */
  expand(id: string, direction: Direction): void
}

const NODE_WIDTH = 220
const NODE_HEIGHT = 46
const BADGE_RADIUS = 11
/** Fitting the whole graph below this zoom makes labels unreadable... */
const MIN_FIT_SCALE = 0.65
/** ...so the view centres on the focused node at this zoom instead. */
const FOCUS_SCALE = 0.8

export class GraphView {
  orientation: Orientation
  private graph: LineageGraph | null = null
  private selected: string | null = null
  private view = { x: 0, y: 0, k: 1 }
  private bounds = { width: 0, height: 0 }
  private focusCenter: Point | null = null
  private readonly viewport: SVGGElement
  private readonly edgesLayer: SVGGElement
  private readonly nodesLayer: SVGGElement
  private readonly measure = document.createElement('canvas').getContext('2d')!

  constructor(
    private readonly svg: SVGSVGElement,
    private readonly emptyNote: HTMLElement,
    private readonly events: GraphViewEvents,
    orientation: Orientation
  ) {
    this.orientation = orientation
    this.viewport = svg.querySelector('#viewport')!
    this.edgesLayer = svg.querySelector('#edges')!
    this.nodesLayer = svg.querySelector('#nodes')!
    this.listen()
    new ResizeObserver(() => {
      if (this.graph) this.fit()
    }).observe(svg)
  }

  /** Draws `graph` (or `emptyText` when there is nothing to draw) and fits it. */
  show(graph: LineageGraph | null, emptyText: string): void {
    this.graph = graph
    this.draw(emptyText)
    this.fit()
  }

  setOrientation(orientation: Orientation): void {
    this.orientation = orientation
    this.draw('')
    this.fit()
  }

  /** Highlights `id`'s upstream and downstream chains and dims the rest. */
  select(id: string | null): void {
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
    const k = Math.min((width - 16) / this.bounds.width, (height - 16) / this.bounds.height, 1.25)
    if (whole || k >= MIN_FIT_SCALE) {
      this.view = { k, x: (width - this.bounds.width * k) / 2, y: (height - this.bounds.height * k) / 2 }
    } else {
      const center = this.focusCenter ?? { x: this.bounds.width / 2, y: this.bounds.height / 2 }
      this.view = { k: FOCUS_SCALE, x: width / 2 - center.x * FOCUS_SCALE, y: height / 2 - center.y * FOCUS_SCALE }
    }
    this.applyView()
  }

  private draw(emptyText: string): void {
    this.edgesLayer.replaceChildren()
    this.nodesLayer.replaceChildren()
    const graph = this.graph
    const empty = !graph || graph.nodes.length === 0
    this.emptyNote.hidden = !empty
    if (empty) {
      if (emptyText) this.emptyNote.textContent = emptyText
      this.bounds = { width: 0, height: 0 }
      return
    }

    const horizontal = this.orientation === 'LR'
    const laidOut = new Graph()
      .setGraph({ rankdir: this.orientation, nodesep: horizontal ? 16 : 24, ranksep: horizontal ? 64 : 48, marginx: 24, marginy: 24 })
      .setDefaultEdgeLabel(() => ({}))
    for (const node of graph.nodes) laidOut.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
    for (const [parent, child] of graph.edges) laidOut.setEdge(parent, child)
    layout(laidOut)
    const { width = 0, height = 0 } = laidOut.graph()
    this.bounds = { width, height }
    const focusNode = graph.focus ? laidOut.node(graph.focus) : null
    this.focusCenter = focusNode ? { x: focusNode.x, y: focusNode.y } : null

    for (const [parent, child] of graph.edges) {
      svgEl('path', { class: 'edge', d: curve(laidOut.edge(parent, child).points), 'data-from': parent, 'data-to': child }, this.edgesLayer)
    }
    const fontFamily = getComputedStyle(document.body).fontFamily
    for (const node of graph.nodes) {
      const { x, y } = laidOut.node(node.id)
      this.drawNode(node, x - NODE_WIDTH / 2, y - NODE_HEIGHT / 2, node.id === graph.focus, fontFamily)
    }
    this.highlight()
  }

  private drawNode(node: GraphNodeView, left: number, top: number, isFocus: boolean, fontFamily: string): void {
    const group = svgEl(
      'g',
      { class: isFocus ? 'node focus' : 'node', transform: `translate(${left},${top})`, 'data-id': node.id },
      this.nodesLayer
    )
    svgEl('title', {}, group).textContent = `${node.name}\n${node.relation ?? node.id}`
    svgEl('rect', { class: 'box', width: NODE_WIDTH, height: NODE_HEIGHT, rx: 6 }, group)
    svgEl('rect', { x: 1, y: 1, width: 5, height: NODE_HEIGHT - 2, rx: 2, fill: typeColor(node.type) }, group)
    svgEl('text', { class: 'name', x: 14, y: 19 }, group).textContent = this.clip(node.name, `600 12px ${fontFamily}`)
    const meta = [node.type, node.materialized].filter(Boolean).join(' · ')
    svgEl('text', { class: 'meta', x: 14, y: 35 }, group).textContent = this.clip(meta, `10.5px ${fontFamily}`)

    // Horizontal: parents' badge on the left edge, children's on the right. Vertical: on the top
    // and bottom edges, off-centre so it does not sit on the arrows that meet there.
    const badge = (count: number, direction: Direction) => {
      if (count === 0) return
      const [cx, cy] =
        this.orientation === 'LR'
          ? [direction === 'up' ? 0 : NODE_WIDTH, NODE_HEIGHT / 2]
          : [NODE_WIDTH - 24, direction === 'up' ? 0 : NODE_HEIGHT]
      const element = svgEl('g', { class: 'badge', 'data-direction': direction }, group)
      svgEl('title', {}, element).textContent = `Show ${count} more ${direction === 'up' ? 'parents' : 'children'}`
      svgEl('circle', { cx, cy, r: BADGE_RADIUS }, element)
      svgEl('text', { x: cx, y: cy }, element).textContent = count > 99 ? '99+' : `+${count}`
    }
    badge(node.hiddenParents, 'up')
    badge(node.hiddenChildren, 'down')
  }

  /** `text` cut with an ellipsis to fit inside a node. */
  private clip(text: string, font: string): string {
    const maxWidth = NODE_WIDTH - 26
    this.measure.font = font
    if (this.measure.measureText(text).width <= maxWidth) return text
    let low = 0
    let high = text.length
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (this.measure.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) low = mid
      else high = mid - 1
    }
    return `${text.slice(0, low)}…`
  }

  /** Dims everything outside the selected node's upstream and downstream chains. */
  private highlight(): void {
    const graph = this.graph
    const selected = this.selected
    const nodes = this.nodesLayer.querySelectorAll<SVGGElement>('.node')
    const edges = this.edgesLayer.querySelectorAll<SVGPathElement>('.edge')
    // The focused node's chains are the whole graph: highlight only another node's.
    if (!graph || !selected || selected === graph.focus || !graph.nodes.some((node) => node.id === selected)) {
      nodes.forEach((node) => node.classList.remove('dim', 'selected'))
      edges.forEach((edge) => edge.classList.remove('dim', 'lit'))
      return
    }
    const reach = (from: 0 | 1): Set<string> => {
      const seen = new Set([selected])
      const queue = [selected]
      while (queue.length > 0) {
        const current = queue.pop()!
        for (const edge of graph.edges) {
          const next = edge[1 - from]
          if (edge[from] === current && !seen.has(next)) {
            seen.add(next)
            queue.push(next)
          }
        }
      }
      return seen
    }
    const upstream = reach(1)
    const downstream = reach(0)
    nodes.forEach((node) => {
      const id = node.dataset.id!
      node.classList.toggle('dim', !upstream.has(id) && !downstream.has(id))
      node.classList.toggle('selected', id === selected)
    })
    edges.forEach((edge) => {
      const from = edge.dataset.from!
      const to = edge.dataset.to!
      const lit = (upstream.has(from) && upstream.has(to)) || (downstream.has(from) && downstream.has(to))
      edge.classList.toggle('lit', lit)
      edge.classList.toggle('dim', !lit)
    })
  }

  private applyView(): void {
    const { x, y, k } = this.view
    this.viewport.setAttribute('transform', `translate(${x},${y}) scale(${k})`)
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
        const cx = event.clientX - rect.left
        const cy = event.clientY - rect.top
        const { x, y, k } = this.view
        const next = Math.min(3, Math.max(0.08, k * Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015))))
        this.view = { k: next, x: cx - ((cx - x) * next) / k, y: cy - ((cy - y) * next) / k }
        this.applyView()
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
      const badge = target.closest<SVGGElement>('.badge')
      if (node && badge) this.events.expand(node.dataset.id!, badge.dataset.direction as Direction)
      else this.events.select(node ? node.dataset.id! : null)
    })
    svg.addEventListener('dblclick', (event) => {
      const target = event.target as Element
      const node = target.closest<SVGGElement>('.node')
      if (node && !target.closest('.badge')) this.events.focus(node.dataset.id!)
    })
  }
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
