// dbt's node selection syntax, evaluated against the lineage graph: the command-line form
// (`+orders+ tag:finance,config.materialized:table --exclude path:models/legacy`) and the YAML
// selectors in the manifest, as dbt v1 (raw YAML under `definition`) and dbt v2 / Fusion
// (flattened, normalized) store them. Tests are not in the graph, so they are never selected.
import type { Graph, GraphNode, RawSelector } from './graph'

export class SelectorError extends Error {}

/** dbt's own spec pattern: `[@][N+]method:value[+N]`. */
const SPEC = /^(@)?(?:(\d*)\+)?(?:([\w.]+):)?(.*?)(?:\+(\d*))?$/
/** Methods that need run results, state or test nodes, which the manifest graph lacks. */
const UNSUPPORTED: Record<string, string> = {
  state: 'needs a state manifest (--state)',
  result: 'needs run_results.json from a previous run',
  source_status: 'needs sources.json from `dbt source freshness`',
  test_name: 'selects tests, which the lineage leaves out',
  test_type: 'selects tests, which the lineage leaves out',
  unit_test: 'selects unit tests, which the lineage leaves out'
}
/** YAML keys that describe a selector rather than select. */
const SELECTOR_KEYS: Record<string, true> = { name: true, description: true, default: true, definition: true }
const GRAPH_KEYS: Record<string, true> = {
  parents: true,
  parents_depth: true,
  children: true,
  children_depth: true,
  childrens_parents: true,
  indirect_selection: true
}
const MAX_SELECTOR_NESTING = 20

type GraphOps = {
  parents: boolean
  parentsDepth: number
  children: boolean
  childrenDepth: number
  childrensParents: boolean
}

/** The YAML selectors the manifest defines, for a picker. */
export function yamlSelectors(graph: Graph): { name: string; description: string }[] {
  return Object.entries(graph.selectors)
    .map(([name, entry]) => ({ name, description: typeof entry.description === 'string' ? entry.description : '' }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The ids `expression` selects, in manifest order; throws SelectorError on what dbt rejects. */
export function select(graph: Graph, expression: string, nesting = 0): Set<string> {
  const include: string[] = []
  const exclude: string[] = []
  let target = include
  const tokens = expression.trim().split(/\s+/).filter(Boolean)
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token === '--select' || token === '-s' || token === '--models' || token === '-m') target = include
    else if (token === '--exclude') target = exclude
    else if (token === '--selector') {
      const name = tokens[++index]
      if (!name) throw new SelectorError('--selector needs a selector name.')
      target.push(`selector:${name}`)
    } else target.push(token)
  }
  const chosen = include.length > 0 ? union(include.map((term) => intersectTerm(graph, term, nesting))) : new Set(graph.nodes.keys())
  if (exclude.length === 0) return chosen
  return minus(chosen, union(exclude.map((term) => intersectTerm(graph, term, nesting))))
}

/** `a,b,c`: the nodes every spec selects. */
function intersectTerm(graph: Graph, term: string, nesting: number): Set<string> {
  return intersection(term.split(',').filter(Boolean).map((spec) => evalSpec(graph, spec, nesting)))
}

function evalSpec(graph: Graph, spec: string, nesting: number): Set<string> {
  const match = SPEC.exec(spec)
  const value = match?.[4] ?? ''
  if (!match || !value) throw new SelectorError(`"${spec}" is not a selector.`)
  const method = match[3] ?? defaultMethod(value)
  if (method === 'selector') {
    if (match[1] || match[2] !== undefined || match[5] !== undefined) {
      throw new SelectorError('Graph operators (+, @) do not apply to selector: methods.')
    }
    return yamlSelector(graph, value, nesting)
  }
  return withGraphOps(graph, matchMethod(graph, method, value), {
    childrensParents: match[1] === '@',
    parents: match[2] !== undefined,
    parentsDepth: match[2] ? Number(match[2]) : Infinity,
    children: match[5] !== undefined,
    childrenDepth: match[5] ? Number(match[5]) : Infinity
  })
}

/** As dbt infers it: something that looks like a path, a file name, else an fqn or name. */
function defaultMethod(value: string): string {
  if (value.includes('/') || value.includes('\\')) return 'path'
  if (/\.(sql|py|csv|yml|yaml)$/i.test(value)) return 'file'
  return 'fqn'
}

function matchMethod(graph: Graph, method: string, value: string): Set<string> {
  const reason = UNSUPPORTED[method]
  if (reason) throw new SelectorError(`"${method}:" ${reason}.`)
  const matches = nodeMatcher(method, value)
  const selected = new Set<string>()
  for (const [id, node] of graph.nodes) if (matches(node)) selected.add(id)
  return selected
}

function nodeMatcher(method: string, value: string): (node: GraphNode) => boolean {
  const glob = globMatcher(value)
  if (method.startsWith('config.')) {
    const key = method.slice('config.'.length)
    return (node) => {
      const setting = node.config[key]
      if (setting === undefined) return false
      return Array.isArray(setting)
        ? setting.some((item) => glob(item))
        : String(setting).toLowerCase() === value.toLowerCase() || glob(String(setting))
    }
  }
  switch (method) {
    case 'fqn': {
      const parts = value.split('.')
      return (node) => glob(node.fqn[node.fqn.length - 1]) || fqnPrefix(node.fqn, parts) || fqnPrefix(node.fqn.slice(1), parts)
    }
    case 'tag':
      return (node) => node.tags.some((tag) => glob(tag))
    case 'path': {
      const wanted = value.replace(/^\.\//, '').replace(/\/+$/, '')
      const pathGlob = globMatcher(wanted)
      return (node) => node.file !== null && (pathGlob(node.file) || node.file.startsWith(`${wanted}/`))
    }
    case 'file':
      return (node) => {
        const base = node.file?.slice(node.file.lastIndexOf('/') + 1)
        return base !== undefined && (glob(base) || glob(base.replace(/\.[^.]+$/, '')))
      }
    case 'resource_type':
      return (node) => node.type === value
    case 'package':
      return (node) => glob(node.packageName)
    case 'source': {
      const parts = value.split('.')
      return (node) => {
        if (node.type !== 'source') return false
        // source.<package>.<source_name>.<table>
        const [, pkg, sourceName, ...table] = node.id.split('.')
        const candidates = [[sourceName], [sourceName, table.join('.')], [pkg, sourceName, table.join('.')]]
        return candidates.some((candidate) => fqnPrefix(candidate, parts) && parts.length <= candidate.length)
      }
    }
    case 'exposure':
    case 'metric':
    case 'semantic_model':
    case 'saved_query':
      return (node) => node.type === method && glob(node.name)
    case 'group':
      return (node) => node.group !== null && glob(node.group)
    case 'access':
      return (node) => node.access === value
    default:
      throw new SelectorError(`Unknown selector method "${method}:".`)
  }
}

/** True when `parts` (globs allowed) match the start of `fqn`. */
function fqnPrefix(fqn: readonly string[], parts: readonly string[]): boolean {
  return parts.length <= fqn.length && parts.every((part, index) => globMatcher(part)(fqn[index]))
}

/** fnmatch: `*`, `?` and `[...]`, matched against the whole value. */
function globMatcher(pattern: string): (value: string) => boolean {
  if (!/[*?[]/.test(pattern)) return (value) => value === pattern
  const source = pattern
    .split('')
    .map((char) => (char === '*' ? '.*' : char === '?' ? '.' : char === '[' || char === ']' ? char : char.replace(/[.+^${}()|\\]/g, '\\$&')))
    .join('')
  const regex = new RegExp(`^${source}$`)
  return (value) => regex.test(value)
}

function withGraphOps(graph: Graph, base: Set<string>, ops: GraphOps): Set<string> {
  const result = new Set(base)
  if (ops.parents) for (const id of walk(graph.parents, base, ops.parentsDepth)) result.add(id)
  if (ops.children || ops.childrensParents) {
    const descendants = walk(graph.children, base, ops.children ? ops.childrenDepth : Infinity)
    for (const id of descendants) result.add(id)
    // @: the descendants and every ancestor of them, as `dbt build` needs to run them.
    if (ops.childrensParents) for (const id of walk(graph.parents, new Set([...base, ...descendants]), Infinity)) result.add(id)
  }
  return result
}

/** Everything reachable from `start` along `edges`, at most `depth` steps away. */
function walk(edges: Map<string, string[]>, start: ReadonlySet<string>, depth: number): Set<string> {
  const seen = new Set<string>()
  let frontier = [...start]
  for (let level = 0; level < depth && frontier.length > 0; level++) {
    const next: string[] = []
    for (const id of frontier) {
      for (const neighbor of edges.get(id) ?? []) {
        if (seen.has(neighbor) || start.has(neighbor)) continue
        seen.add(neighbor)
        next.push(neighbor)
      }
    }
    frontier = next
  }
  return seen
}

function yamlSelector(graph: Graph, name: string, nesting: number): Set<string> {
  const entry: RawSelector | undefined = graph.selectors[name]
  if (!entry) throw new SelectorError(`No selector named "${name}" in selectors.yml.`)
  if (nesting > MAX_SELECTOR_NESTING) throw new SelectorError(`Selector "${name}" refers to itself.`)
  // v1 keeps the YAML under `definition`; v2 flattens it into the entry.
  const definition =
    entry.definition !== undefined
      ? entry.definition
      : Object.fromEntries(Object.entries(entry).filter(([key]) => !SELECTOR_KEYS[key]))
  return evalDefinition(graph, definition, nesting + 1)
}

function evalDefinition(graph: Graph, definition: unknown, nesting: number): Set<string> {
  if (typeof definition === 'string') return select(graph, definition, nesting)
  if (Array.isArray(definition)) return combine(graph, definition, 'union', nesting)
  if (!definition || typeof definition !== 'object') throw new SelectorError('A selector definition must be text or a mapping.')
  const entry = definition as Record<string, unknown>
  if (Array.isArray(entry.union)) return combine(graph, entry.union, 'union', nesting)
  if (Array.isArray(entry.intersection)) return combine(graph, entry.intersection, 'intersection', nesting)
  if (entry.exclude !== undefined && entry.method === undefined) {
    return minus(new Set(graph.nodes.keys()), excluded(graph, entry.exclude, nesting))
  }

  let method = entry.method
  let value = entry.value
  if (method === undefined) {
    // The shorthand `tag: nightly`: one key that names the method.
    const keys = Object.keys(entry).filter((key) => !GRAPH_KEYS[key] && !SELECTOR_KEYS[key])
    if (keys.length !== 1) throw new SelectorError(`Cannot read selector definition ${JSON.stringify(definition)}.`)
    method = keys[0]
    value = entry[keys[0]]
  }
  // `value` may be a list (`method: package, value: [a, b]`): any of them matches.
  const values = Array.isArray(value) ? value : [value]
  if (typeof method !== 'string' || values.length === 0 || !values.every((item) => typeof item === 'string' || typeof item === 'number')) {
    throw new SelectorError(`Cannot read selector definition ${JSON.stringify(definition)}.`)
  }
  const selectorMethod = method
  if (selectorMethod === 'selector') return union(values.map((item) => yamlSelector(graph, String(item), nesting)))
  const matched = union(values.map((item) => matchMethod(graph, selectorMethod, String(item))))
  const base = withGraphOps(graph, matched, {
    parents: entry.parents === true,
    parentsDepth: typeof entry.parents_depth === 'number' ? entry.parents_depth : Infinity,
    children: entry.children === true,
    childrenDepth: typeof entry.children_depth === 'number' ? entry.children_depth : Infinity,
    childrensParents: entry.childrens_parents === true
  })
  return entry.exclude !== undefined ? minus(base, excluded(graph, entry.exclude, nesting)) : base
}

/** `union`/`intersection` items; `exclude` items among them are taken out of the result. */
function combine(graph: Graph, items: unknown[], mode: 'union' | 'intersection', nesting: number): Set<string> {
  const included: Set<string>[] = []
  const excludedSets: Set<string>[] = []
  for (const item of items) {
    if (item && typeof item === 'object' && !Array.isArray(item) && 'exclude' in item && Object.keys(item).length === 1) {
      excludedSets.push(excluded(graph, item.exclude, nesting))
    } else {
      included.push(evalDefinition(graph, item, nesting))
    }
  }
  const result = mode === 'union' ? union(included) : intersection(included)
  return excludedSets.length > 0 ? minus(result, union(excludedSets)) : result
}

/** `exclude:` holds one definition (v2) or a list of them (v1). */
function excluded(graph: Graph, exclude: unknown, nesting: number): Set<string> {
  return Array.isArray(exclude)
    ? union(exclude.map((item) => evalDefinition(graph, item, nesting)))
    : evalDefinition(graph, exclude, nesting)
}

function union(sets: Set<string>[]): Set<string> {
  const result = new Set<string>()
  for (const set of sets) for (const id of set) result.add(id)
  return result
}

function intersection(sets: Set<string>[]): Set<string> {
  if (sets.length === 0) return new Set()
  const [first, ...rest] = sets
  return new Set([...first].filter((id) => rest.every((set) => set.has(id))))
}

function minus(from: Set<string>, remove: Set<string>): Set<string> {
  return new Set([...from].filter((id) => !remove.has(id)))
}
