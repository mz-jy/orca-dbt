// Turns dbt's target/manifest.json (and catalog.json, when there is one) into a slim lineage
// graph plus the catalog details the panels show. Pure: no Node APIs, so tests feed it objects.
import type {
  CatalogLevel,
  ColumnInfo,
  Direction,
  GroupBy,
  LineageGraph,
  NodeDetail,
  NodeFocus,
  NodeSummary
} from './protocol'

export type GraphNode = Omit<NodeDetail, 'parents' | 'children'> & {
  /** The folder of the node's file, under dbt_packages/<package> for installed packages. */
  folder: string
  /** database.schema, for relations. */
  schemaName: string | null
  /** What dbt selectors match on: fqn, scalar (and string-list) config, group, access. */
  fqn: string[]
  config: Record<string, string | number | boolean | string[]>
  group: string | null
  access: string | null
}

/**
 * A YAML selector as the manifest stores it. dbt v1 keeps the raw YAML under `definition`;
 * dbt v2 (Fusion) flattens it into the entry and normalizes it.
 */
export type RawSelector = { name?: string; description?: string; definition?: unknown } & Record<string, unknown>

export type Graph = {
  projectName: string
  generatedAt: string | null
  dbtVersion: string | null
  nodes: Map<string, GraphNode>
  parents: Map<string, string[]>
  children: Map<string, string[]>
  selectors: Record<string, RawSelector>
}

type RawColumn = { name?: string; description?: string; data_type?: string | null }

type RawNode = {
  name?: string
  resource_type?: string
  package_name?: string
  original_file_path?: string
  source_name?: string
  database?: string | null
  schema?: string | null
  alias?: string | null
  identifier?: string | null
  description?: string
  tags?: string[]
  meta?: Record<string, unknown> | null
  group?: string | null
  access?: string | null
  fqn?: string[]
  columns?: Record<string, RawColumn>
  config?: ({ materialized?: string; meta?: Record<string, unknown> | null } & Record<string, unknown>) | null
  depends_on?: { nodes?: string[] }
  /** Tests: the node they test (dbt 1.5+), the column, and the generic test's name. */
  attached_node?: string | null
  column_name?: string | null
  test_metadata?: { name?: string; namespace?: string | null }
}

export type RawManifest = {
  metadata?: { project_name?: string; generated_at?: string; dbt_version?: string }
  nodes?: Record<string, RawNode>
  sources?: Record<string, RawNode>
  exposures?: Record<string, RawNode>
  metrics?: Record<string, RawNode>
  semantic_models?: Record<string, RawNode>
  saved_queries?: Record<string, RawNode>
  parent_map?: Record<string, string[]>
  selectors?: Record<string, RawSelector>
}

type RawCatalogNode = {
  columns?: Record<string, { name?: string; type?: string; index?: number }>
  stats?: Record<string, { value?: unknown }>
}

/** target/catalog.json, written by `dbt docs generate`: the warehouse's own column types. */
export type RawCatalog = { nodes?: Record<string, RawCatalogNode>; sources?: Record<string, RawCatalogNode> }

/** Tests and operations are not lineage; leaving them out keeps trees readable. */
const SKIPPED_TYPES: Record<string, true> = {
  test: true,
  unit_test: true,
  operation: true,
  sql_operation: true
}
const RELATION_TYPES: Record<string, true> = { model: true, seed: true, snapshot: true, source: true }
/** dbt v2 (Fusion) writes each `dbt show --inline` query into the manifest as a model. */
const FUSION_INLINE_FILE = /(^|\/)inline_[0-9a-f]+\.sql$/
/** Search ranks these first when two names match equally well. */
const TYPE_RANK: Record<string, number> = { model: 0, source: 1, seed: 2, snapshot: 3, exposure: 4 }
const MAX_DESCRIPTION = 20_000
const MAX_META_ENTRIES = 30
const MAX_META_VALUE = 500
/** The explorer's group key for nodes without a tag, owner, schema or package. */
export const NO_GROUP = '(none)'

export function buildGraph(manifest: RawManifest, catalog?: RawCatalog | null): Graph {
  const projectName = manifest.metadata?.project_name ?? ''
  const nodes = new Map<string, GraphNode>()
  const declaredParents = new Map<string, string[]>()
  const groups = [
    manifest.nodes,
    manifest.sources,
    manifest.exposures,
    manifest.metrics,
    manifest.semantic_models,
    manifest.saved_queries
  ]
  for (const group of groups) {
    for (const [id, raw] of Object.entries(group ?? {})) {
      const type = raw.resource_type ?? id.slice(0, id.indexOf('.'))
      if (SKIPPED_TYPES[type] || FUSION_INLINE_FILE.test(raw.original_file_path ?? '')) continue
      nodes.set(id, toNode(id, type, raw, projectName))
      // parent_map is dbt's resolved edge list; depends_on covers manifests written without it.
      declaredParents.set(id, manifest.parent_map?.[id] ?? raw.depends_on?.nodes ?? [])
    }
  }

  for (const [id, raw] of Object.entries(manifest.nodes ?? {})) {
    if ((raw.resource_type ?? id.slice(0, id.indexOf('.'))) === 'test') attachTest(nodes, raw)
  }
  for (const [id, entry] of Object.entries({ ...catalog?.nodes, ...catalog?.sources })) {
    const node = nodes.get(id)
    if (node) mergeCatalog(node, entry)
  }

  const parents = new Map<string, string[]>()
  const children = new Map<string, string[]>()
  for (const id of nodes.keys()) {
    parents.set(id, [])
    children.set(id, [])
  }
  for (const [id, declared] of declaredParents) {
    const own = parents.get(id)!
    for (const parent of declared) {
      if (parent === id || !nodes.has(parent) || own.includes(parent)) continue
      own.push(parent)
      children.get(parent)!.push(id)
    }
  }

  return {
    projectName,
    generatedAt: manifest.metadata?.generated_at ?? null,
    dbtVersion: manifest.metadata?.dbt_version ?? null,
    nodes,
    parents,
    children,
    selectors: manifest.selectors ?? {}
  }
}

function toNode(id: string, type: string, raw: RawNode, projectName: string): GraphNode {
  const name =
    type === 'source' && raw.source_name ? `${raw.source_name}.${raw.name}` : (raw.name ?? id)
  const identifier = type === 'source' ? (raw.identifier ?? raw.name) : (raw.alias ?? raw.name)
  const isRelation = RELATION_TYPES[type] === true
  const file = raw.original_file_path ?? null
  const directory = file?.includes('/') ? file.slice(0, file.lastIndexOf('/')) : ''
  const packageName = raw.package_name ?? ''
  const meta = { ...raw.config?.meta, ...raw.meta }
  const owner = typeof meta.owner === 'string' ? meta.owner : (raw.group ?? null)
  return {
    id,
    name,
    type,
    packageName,
    file,
    materialized: raw.config?.materialized ?? null,
    relation: isRelation ? [raw.database, raw.schema, identifier].filter(Boolean).join('.') || null : null,
    description: (raw.description ?? '').slice(0, MAX_DESCRIPTION),
    tags: [...new Set(raw.tags ?? [])],
    owner,
    meta: Object.entries(meta)
      .slice(0, MAX_META_ENTRIES)
      .map(([key, value]) => ({
        key,
        value: (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, MAX_META_VALUE)
      })),
    columns: Object.values(raw.columns ?? {}).map((column) => ({
      name: column.name ?? '',
      type: column.data_type || null,
      description: column.description ?? '',
      tests: []
    })),
    tests: [],
    rowCount: null,
    folder: packageName && projectName && packageName !== projectName
      ? ['dbt_packages', packageName, directory].filter(Boolean).join('/')
      : directory,
    schemaName: isRelation ? [raw.database, raw.schema].filter(Boolean).join('.') || null : null,
    fqn: raw.fqn ?? [packageName, name],
    config: Object.fromEntries(
      Object.entries(raw.config ?? {}).filter(
        (entry): entry is [string, string | number | boolean | string[]] =>
          ['string', 'number', 'boolean'].includes(typeof entry[1]) ||
          (Array.isArray(entry[1]) && entry[1].every((item) => typeof item === 'string'))
      )
    ),
    group: raw.group ?? null,
    access: raw.access ?? null
  }
}

/** Files a test under the node (or column) it tests. */
function attachTest(nodes: Map<string, GraphNode>, test: RawNode): void {
  const target = test.attached_node ?? test.depends_on?.nodes?.find((id) => nodes.has(id))
  const node = target ? nodes.get(target) : undefined
  if (!node) return
  const generic = test.test_metadata?.name
  const label = generic
    ? test.test_metadata?.namespace
      ? `${test.test_metadata.namespace}.${generic}`
      : generic
    : (test.name ?? 'test')
  if (!test.column_name) {
    if (!node.tests.includes(label)) node.tests.push(label)
    return
  }
  const wanted = test.column_name.toLowerCase()
  let column = node.columns.find((candidate) => candidate.name.toLowerCase() === wanted)
  if (!column) {
    column = { name: test.column_name, type: null, description: '', tests: [] }
    node.columns.push(column)
  }
  if (!column.tests.includes(label)) column.tests.push(label)
}

/** Fills column types the YAML left out, adds undocumented columns, and the row count. */
function mergeCatalog(node: GraphNode, entry: RawCatalogNode): void {
  const warehouseColumns = Object.values(entry.columns ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  for (const warehouse of warehouseColumns) {
    if (!warehouse.name) continue
    const wanted = warehouse.name.toLowerCase()
    const column: ColumnInfo | undefined = node.columns.find((candidate) => candidate.name.toLowerCase() === wanted)
    if (column) column.type ??= warehouse.type ?? null
    else node.columns.push({ name: warehouse.name, type: warehouse.type ?? null, description: '', tests: [] })
  }
  const rows = entry.stats?.row_count?.value
  node.rowCount = typeof rows === 'number' ? rows : null
}

export function summarize(graph: Graph, id: string): NodeSummary {
  const node = graph.nodes.get(id)!
  return {
    id,
    name: node.name,
    type: node.type,
    parents: graph.parents.get(id)!.length,
    children: graph.children.get(id)!.length
  }
}

export function neighbors(graph: Graph, id: string, direction: Direction): NodeSummary[] {
  const ids = (direction === 'up' ? graph.parents : graph.children).get(id) ?? []
  return ids.map((neighbor) => summarize(graph, neighbor)).sort(byTypeThenName)
}

export function focus(graph: Graph, id: string): NodeFocus | null {
  const node = graph.nodes.get(id)
  if (!node) return null
  return {
    node: {
      ...summarize(graph, id),
      packageName: node.packageName,
      file: node.file,
      materialized: node.materialized,
      relation: node.relation,
      description: node.description,
      tags: node.tags,
      owner: node.owner,
      meta: node.meta,
      columns: node.columns,
      tests: node.tests,
      rowCount: node.rowCount
    },
    parents: neighbors(graph, id, 'up'),
    children: neighbors(graph, id, 'down')
  }
}

/** Name matches first (exact, prefix, anywhere), then id, column names and descriptions. */
export function search(graph: Graph, query: string, limit: number): NodeSummary[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const scored: { id: string; score: number }[] = []
  for (const [id, node] of graph.nodes) {
    const name = node.name.toLowerCase()
    const score =
      name === needle
        ? 0
        : name.startsWith(needle)
          ? 1
          : name.includes(needle)
            ? 2
            : id.toLowerCase().includes(needle)
              ? 3
              : node.columns.some((column) => column.name.toLowerCase().includes(needle))
                ? 4
                : node.description.toLowerCase().includes(needle)
                  ? 5
                  : -1
    if (score >= 0) scored.push({ id, score })
  }
  return scored
    .map(({ id, score }) => ({ score, summary: summarize(graph, id) }))
    .sort((a, b) => a.score - b.score || byTypeThenName(a.summary, b.summary))
    .slice(0, limit)
    .map(({ summary }) => summary)
}

function byTypeThenName(a: NodeSummary, b: NodeSummary): number {
  return (
    (TYPE_RANK[a.type] ?? 9) - (TYPE_RANK[b.type] ?? 9) ||
    a.name.length - b.name.length ||
    a.name.localeCompare(b.name)
  )
}

function groupKeys(node: GraphNode, by: Exclude<GroupBy, 'folder'>): string[] {
  switch (by) {
    case 'tag':
      return node.tags.length > 0 ? node.tags : [NO_GROUP]
    case 'schema':
      return [node.schemaName ?? NO_GROUP]
    case 'type':
      return [node.type]
    case 'package':
      return [node.packageName || NO_GROUP]
    case 'owner':
      return [node.owner ?? NO_GROUP]
  }
}

/**
 * One level of the catalog explorer. By folder, `path` is a folder and the level holds its
 * sub-folders and files; otherwise '' lists the groups and a group key lists its nodes.
 */
export function catalogLevel(graph: Graph, by: GroupBy, path: string, cap: number): CatalogLevel {
  const counts = new Map<string, number>()
  const direct: string[] = []
  if (by === 'folder') {
    const prefix = path ? `${path}/` : ''
    for (const [id, node] of graph.nodes) {
      if (node.folder === path) direct.push(id)
      else if (node.folder.startsWith(prefix)) {
        const child = prefix + node.folder.slice(prefix.length).split('/')[0]
        counts.set(child, (counts.get(child) ?? 0) + 1)
      }
    }
  } else {
    for (const [id, node] of graph.nodes) {
      for (const key of groupKeys(node, by)) {
        if (!path) counts.set(key, (counts.get(key) ?? 0) + 1)
        else if (key === path) direct.push(id)
      }
    }
  }
  const nodes = direct.map((id) => summarize(graph, id)).sort(byTypeThenName)
  return {
    groups: [...counts]
      .sort(([a], [b]) => (a === NO_GROUP ? 1 : b === NO_GROUP ? -1 : a.localeCompare(b)))
      .map(([key, count]) => ({ key, label: by === 'folder' ? key.slice(key.lastIndexOf('/') + 1) : key, count })),
    nodes: nodes.slice(0, cap),
    more: Math.max(0, nodes.length - cap)
  }
}

/**
 * The nodes within `up` levels above and `down` levels below `id`, each direction stopping at
 * half of `limit`, plus the direct neighbors of each `expand` entry; with every edge among them.
 */
export function subgraph(
  graph: Graph,
  id: string,
  up: number,
  down: number,
  expand: readonly { id: string; direction: Direction }[],
  limit: number
): LineageGraph | null {
  if (!graph.nodes.has(id)) return null
  const included = new Set([id])
  let truncated = false

  const walk = (direction: Direction, levels: number, budget: number) => {
    const edges = direction === 'up' ? graph.parents : graph.children
    let frontier = [id]
    let added = 0
    for (let level = 0; level < levels && frontier.length > 0; level++) {
      const next: string[] = []
      for (const current of frontier) {
        for (const neighbor of edges.get(current) ?? []) {
          if (included.has(neighbor)) continue
          if (added >= budget) {
            truncated = true
            return
          }
          included.add(neighbor)
          next.push(neighbor)
          added++
        }
      }
      frontier = next
    }
  }
  walk('up', up, Math.floor(limit / 2))
  walk('down', down, Math.floor(limit / 2))
  truncated = expandInto(graph, included, expand, limit) || truncated
  return drawable(graph, included, id, truncated)
}

/** The nodes a selector chose (the first `limit` of them), plus `expand`, with their edges. */
export function selectionGraph(
  graph: Graph,
  selected: ReadonlySet<string>,
  expand: readonly { id: string; direction: Direction }[],
  limit: number
): LineageGraph {
  const included = new Set([...selected].slice(0, limit))
  const truncated = selected.size > limit || expandInto(graph, included, expand, limit)
  return drawable(graph, included, null, truncated)
}

/** Adds each `expand` entry's direct neighbors; true when `limit` cut that short. */
function expandInto(
  graph: Graph,
  included: Set<string>,
  expand: readonly { id: string; direction: Direction }[],
  limit: number
): boolean {
  for (const entry of expand) {
    if (!included.has(entry.id)) continue
    for (const neighbor of (entry.direction === 'up' ? graph.parents : graph.children).get(entry.id) ?? []) {
      if (included.has(neighbor)) continue
      if (included.size >= limit) return true
      included.add(neighbor)
    }
  }
  return false
}

function drawable(graph: Graph, included: ReadonlySet<string>, focusId: string | null, truncated: boolean): LineageGraph {
  const nodes = [...included].map((nodeId) => {
    const node = graph.nodes.get(nodeId)!
    return {
      ...summarize(graph, nodeId),
      materialized: node.materialized,
      relation: node.relation,
      file: node.file,
      hiddenParents: graph.parents.get(nodeId)!.filter((parent) => !included.has(parent)).length,
      hiddenChildren: graph.children.get(nodeId)!.filter((child) => !included.has(child)).length
    }
  })
  const edges: [string, string][] = []
  for (const child of included) {
    for (const parent of graph.parents.get(child)!) {
      if (included.has(parent)) edges.push([parent, child])
    }
  }
  return { focus: focusId, nodes, edges, truncated }
}

/** `select *` from a node, in the Jinja dbt resolves against the current target. */
export function previewSql(id: string, type: string, name: string, packageName: string): string | null {
  const parts = id.split('.')
  if (type === 'source') return `select * from {{ source('${parts[2]}', '${parts.slice(3).join('.')}') }}`
  if (type === 'model' || type === 'seed' || type === 'snapshot') {
    return `select * from {{ ref('${packageName}', '${name}') }}`
  }
  return null
}
