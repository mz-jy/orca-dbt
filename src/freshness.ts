// Source freshness: how long ago each source last received data, against the warn_after and
// error_after its YAML sets. `dbt source freshness` (run from the panel, by an agent or in a
// terminal) writes target/sources.json; the manifest says which sources have a rule at all.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshnessWindow, selectorTerm, summarize, type Graph, type RawWindow } from './graph'
import type { FreshnessReport, FreshnessStatus, SourceFreshness } from './protocol'

type RawFreshness = {
  unique_id?: string
  /** dbt-core: pass, warn, error (stale), runtime error (the check failed). Fusion capitalizes them. */
  status?: string
  max_loaded_at?: string | null
  snapshotted_at?: string | null
  criteria?: { warn_after?: RawWindow; error_after?: RawWindow } | null
  /** A check that failed says why. */
  error?: string | null
}

type RawSources = { metadata?: { generated_at?: string }; results?: RawFreshness[] }

/** Worst first; a source never checked sits between the problems and the fresh ones. */
const RANK: Record<FreshnessStatus | 'never', number> = { error: 4, fail: 3, warn: 2, never: 1, pass: 0 }
const MAX_MESSAGE = 2000

/** dbt calls a stale source an error; here `fail` is stale and `error` a check that did not run. */
function freshnessStatus(raw: string | undefined): FreshnessStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'pass':
      return 'pass'
    case 'warn':
      return 'warn'
    case 'error':
      return 'fail'
    default:
      return 'error'
  }
}

/**
 * Every source with a freshness rule (or a result), worst first, with its latest check from
 * `<targetDir>/sources.json`; `checkedAt` and `checked` describe that file's run (null and 0 without one).
 */
export function readFreshness(graph: Graph, targetDir: string): FreshnessReport & { checked: number } {
  let raw: RawSources = {}
  try {
    raw = JSON.parse(readFileSync(join(targetDir, 'sources.json'), 'utf8')) as RawSources
  } catch {
    // Never checked, or half written: every source shows as not checked yet.
  }
  const results = new Map((raw.results ?? []).flatMap((result) => (result.unique_id ? [[result.unique_id, result]] : [])))
  const counts: FreshnessReport['counts'] = { error: 0, fail: 0, warn: 0, pass: 0, never: 0 }
  const sources: SourceFreshness[] = []
  for (const node of graph.nodes.values()) {
    const result = results.get(node.id)
    if (node.type !== 'source' || (!node.freshness && !result)) continue
    const status = result ? freshnessStatus(result.status) : null
    counts[status ?? 'never']++
    sources.push({
      node: summarize(graph, node.id),
      warnAfter: freshnessWindow(result?.criteria?.warn_after) ?? node.freshness?.warnAfter ?? null,
      errorAfter: freshnessWindow(result?.criteria?.error_after) ?? node.freshness?.errorAfter ?? null,
      loadedAtField: node.freshness?.loadedAtField ?? null,
      status,
      maxLoadedAt: result?.max_loaded_at ?? null,
      checkedAt: result ? (result.snapshotted_at ?? raw.metadata?.generated_at ?? null) : null,
      message: result?.error ? result.error.slice(0, MAX_MESSAGE) : null
    })
  }
  sources.sort((a, b) => RANK[b.status ?? 'never'] - RANK[a.status ?? 'never'] || a.node.name.localeCompare(b.node.name))
  return { counts, checkedAt: raw.metadata?.generated_at ?? null, sources, checked: raw.results?.length ?? 0 }
}

/** The `dbt source freshness` arguments: for source `nodeId`, or every source with a rule. Null when the manifest has no such source. */
export function freshnessArgs(graph: Graph, nodeId?: string): { args: string[]; label: string } | null {
  if (!nodeId) return { args: ['source', 'freshness'], label: 'source freshness' }
  const node = graph.nodes.get(nodeId)
  if (node?.type !== 'source') return null
  return { args: ['source', 'freshness', '--select', selectorTerm(node)], label: `freshness of ${node.name}` }
}
