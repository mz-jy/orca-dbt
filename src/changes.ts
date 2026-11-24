// From a branch's changed files to the dbt nodes they change and everything downstream: the
// impact of a pull request, read from git rather than from a production manifest
// (dbt's `state:modified+` needs one). Pure: git runs in src/git.ts.
import { selectorTerm, summarize, type Graph } from './graph'
import type { ChangedNode, ChangeKind, NodeSummary } from './protocol'

/** A changed file, relative to the dbt project folder. `U` is untracked (new, not added yet). */
export type FileChange = { path: string; status: 'A' | 'M' | 'D' | 'R' | 'U' }

export type MappedChanges = {
  changed: ChangedNode[]
  impacted: NodeSummary[]
  removed: string[]
  unmapped: string[]
}

/** Stronger first: a node whose file is new and whose YAML changed counts as added. */
const KIND_RANK: Record<ChangeKind, number> = { added: 0, modified: 1, yaml: 2, macro: 3 }
const NODE_FILE = /\.(sql|py|csv)$/i
const MAX_COMMAND_TERMS = 60

export function mapChanges(graph: Graph, files: readonly FileChange[]): MappedChanges {
  // Only the project's own files: installed packages live under dbt_packages/.
  const own = [...graph.nodes.values()].filter((node) => node.packageName === graph.projectName)
  const byFile = new Map<string, string[]>()
  const add = (file: string | null, id: string) => {
    if (file) byFile.set(file, [...(byFile.get(file) ?? []), id])
  }
  for (const node of own) {
    add(node.file, node.id)
    if (node.patchFile !== node.file) add(node.patchFile, node.id)
  }
  const macrosByFile = new Map<string, string[]>()
  for (const [id, macro] of graph.macros) {
    if (macro.packageName === graph.projectName) macrosByFile.set(macro.file, [...(macrosByFile.get(macro.file) ?? []), id])
  }

  const marks = new Map<string, { change: ChangeKind; files: string[] }>()
  const mark = (id: string, change: ChangeKind, file: string) => {
    const current = marks.get(id)
    if (!current) marks.set(id, { change, files: [file] })
    else {
      if (KIND_RANK[change] < KIND_RANK[current.change]) current.change = change
      if (!current.files.includes(file)) current.files.push(file)
    }
  }
  const removed: string[] = []
  const unmapped: string[] = []
  const changedMacros = new Set<string>()

  for (const { path, status } of files) {
    const ids = byFile.get(path) ?? []
    const macros = macrosByFile.get(path) ?? []
    if (status === 'D') {
      if (NODE_FILE.test(path)) removed.push(path)
      else unmapped.push(path)
      continue
    }
    for (const id of ids) {
      const node = graph.nodes.get(id)!
      const ownFile = node.file === path && NODE_FILE.test(path)
      mark(id, ownFile ? (status === 'A' || status === 'U' ? 'added' : 'modified') : 'yaml', path)
    }
    for (const macro of macros) changedMacros.add(macro)
    if (ids.length === 0 && macros.length === 0) unmapped.push(path)
  }

  // A macro that calls a changed macro changes too.
  for (let grew = changedMacros.size > 0; grew; ) {
    grew = false
    for (const [id, macro] of graph.macros) {
      if (!changedMacros.has(id) && macro.uses.some((used) => changedMacros.has(used))) {
        changedMacros.add(id)
        grew = true
      }
    }
  }
  if (changedMacros.size > 0) {
    for (const node of graph.nodes.values()) {
      const used = node.macros.find((macro) => changedMacros.has(macro))
      if (used) mark(node.id, 'macro', graph.macros.get(used)?.file || used)
    }
  }

  const changed = [...marks]
    .map(([id, { change, files: changedFiles }]) => ({ ...summarize(graph, id), change, files: changedFiles }))
    .sort((a, b) => KIND_RANK[a.change] - KIND_RANK[b.change] || a.name.localeCompare(b.name))
  const impacted = [...downstream(graph, new Set(marks.keys()))]
    .map((id) => summarize(graph, id))
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
  return { changed, impacted, removed, unmapped }
}

/** Every node downstream of `from`, not counting `from` itself. */
export function downstream(graph: Graph, from: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>()
  const queue = [...from]
  while (queue.length > 0) {
    for (const child of graph.children.get(queue.pop()!) ?? []) {
      if (from.has(child) || seen.has(child)) continue
      seen.add(child)
      queue.push(child)
    }
  }
  return seen
}

/**
 * `dbt build --select a+ b+ …` for the changed nodes and all they feed, leaving out changed
 * nodes another changed node already reaches. Null when nothing buildable changed.
 */
export function buildCommand(graph: Graph, changed: readonly ChangedNode[]): string | null {
  // Every node one or more edges below a changed node, changed ones included: those are built
  // by the `+` of a changed node above them.
  const reached = new Set<string>()
  const queue = changed.map((node) => node.id)
  while (queue.length > 0) {
    for (const child of graph.children.get(queue.pop()!) ?? []) {
      if (reached.has(child)) continue
      reached.add(child)
      queue.push(child)
    }
  }
  const terms = changed
    .filter((node) => !reached.has(node.id))
    .flatMap((node) =>
      node.type === 'source' || node.type === 'model' || node.type === 'seed' || node.type === 'snapshot' ? [`${selectorTerm(node)}+`] : []
    )
  if (terms.length === 0) return null
  const shown = terms.slice(0, MAX_COMMAND_TERMS)
  return `dbt build --select ${shown.join(' ')}${terms.length > shown.length ? ' …' : ''}`
}
