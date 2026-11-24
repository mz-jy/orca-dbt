// The slice of @dagrejs/dagre 3.1.3's API that ui/graph-view.ts uses.
export type Point = { x: number; y: number }
export type NodeLabel = { width: number; height: number; x: number; y: number }
export type EdgeLabel = { points: Point[] }
export type GraphLabel = {
  rankdir?: 'TB' | 'BT' | 'LR' | 'RL'
  nodesep?: number
  ranksep?: number
  edgesep?: number
  marginx?: number
  marginy?: number
  width?: number
  height?: number
}

export class Graph {
  constructor(options?: { directed?: boolean; multigraph?: boolean; compound?: boolean })
  setGraph(label: GraphLabel): this
  graph(): GraphLabel
  setDefaultEdgeLabel(label: () => object): this
  setNode(id: string, label: { width: number; height: number }): this
  node(id: string): NodeLabel
  setEdge(from: string, to: string): this
  edge(from: string, to: string): EdgeLabel
}

export function layout(graph: Graph): void
