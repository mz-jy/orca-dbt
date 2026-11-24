// Test results. After every run (the panel's own, or one from a terminal) dbt writes
// target/run_results.json; each test's latest result is kept in target/orca-dbt-tests.json, so
// running a few tests does not forget the others. A test that fails or warns keeps its compiled
// SQL: "failing rows" runs it through `dbt show`.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { selectorTerm, summarize, type Graph, type TestNode } from './graph'
import type { QualityFlag, QualityReport, TestResult, TestStatus } from './protocol'

type StoredResult = {
  status: TestStatus
  failures: number | null
  message: string | null
  ms: number | null
  at: string
  sql?: string
}

type RawResult = {
  unique_id?: string
  status?: string
  failures?: number | null
  message?: string | null
  execution_time?: number
  /** dbt-core only; Fusion leaves it out (its manifest records compiled_path instead). */
  compiled_code?: string | null
}

type RawRunResults = { metadata?: { generated_at?: string; invocation_id?: string }; results?: RawResult[] }

const STORE_FILE = 'orca-dbt-tests.json'
const RANK: Record<TestStatus, number> = { error: 4, fail: 3, warn: 2, skipped: 1, pass: 0 }
const MAX_SQL = 50_000
const MAX_MESSAGE = 4_000

/** A test outcome as dbt-core and Fusion write it; null for what is not one (a model's `success`). */
export function testStatus(raw: string | undefined): TestStatus | null {
  switch ((raw ?? '').toLowerCase()) {
    case 'pass':
      return 'pass'
    case 'warn':
      return 'warn'
    case 'fail':
      return 'fail'
    case 'error':
    case 'runtime error':
      return 'error'
    case 'skipped':
    case 'skip':
      return 'skipped'
    default:
      return null
  }
}

function isProblem(status: TestStatus | null): boolean {
  return status === 'error' || status === 'fail' || status === 'warn'
}

/** One project's test results: target/run_results.json merged into what earlier runs found. */
export class TestResults {
  private results = new Map<string, StoredResult>()
  /** The run_results.json run merged last: its invocation and time. */
  private merged = ''
  /** When the newest merged run finished, and how many tests it ran. */
  last: { at: string; tests: number } | null = null

  constructor(
    private readonly projectDir: string,
    private readonly targetDir: string
  ) {
    try {
      const saved = JSON.parse(readFileSync(join(targetDir, STORE_FILE), 'utf8')) as {
        merged?: string
        results?: Record<string, StoredResult>
      }
      this.merged = saved.merged ?? ''
      this.results = new Map(Object.entries(saved.results ?? {}))
    } catch {
      // No results yet, or a file from elsewhere: start empty.
    }
  }

  /** Merges target/run_results.json when it holds a run not merged yet. */
  sync(graph: Graph): void {
    let raw: RawRunResults
    try {
      raw = JSON.parse(readFileSync(join(this.targetDir, 'run_results.json'), 'utf8')) as RawRunResults
    } catch {
      return
    }
    const run = `${raw.metadata?.invocation_id ?? ''}@${raw.metadata?.generated_at ?? ''}`
    if (run === this.merged) return
    this.merged = run
    const at = raw.metadata?.generated_at ?? new Date().toISOString()
    let tests = 0
    for (const result of raw.results ?? []) {
      const id = result.unique_id ?? ''
      const status = testStatus(result.status)
      if (!status || !/^(test|unit_test)\./.test(id)) continue
      tests++
      const sql = status === 'fail' || status === 'warn' ? result.compiled_code || this.compiledSql(graph.tests.get(id)) : null
      this.results.set(id, {
        status,
        failures: typeof result.failures === 'number' ? result.failures : null,
        message: result.message ? result.message.slice(0, MAX_MESSAGE) : null,
        ms: typeof result.execution_time === 'number' ? Math.round(result.execution_time * 1000) : null,
        at,
        ...(sql ? { sql: sql.slice(0, MAX_SQL) } : {})
      })
    }
    this.last = { at, tests }
    if (tests > 0) {
      writeFileSync(join(this.targetDir, STORE_FILE), JSON.stringify({ merged: this.merged, results: Object.fromEntries(this.results) }))
    }
  }

  /** The SQL that selects what test `id` found: kept from its run, else its compiled file. */
  failingRowsSql(graph: Graph, id: string): string | null {
    return this.results.get(id)?.sql ?? this.compiledSql(graph.tests.get(id))
  }

  /** Counts and flags over every test, and the tests asked for, worst first. */
  report(graph: Graph, wanted: { all?: boolean; nodeId?: string }, limit: number): Omit<QualityReport, 'running'> {
    const counts: QualityReport['counts'] = { error: 0, fail: 0, warn: 0, skipped: 0, pass: 0, never: 0 }
    const flags: Record<string, QualityFlag> = {}
    const listed: [TestNode, StoredResult | undefined][] = []
    let lastRun: string | null = null
    for (const test of graph.tests.values()) {
      const result = this.results.get(test.id)
      counts[result?.status ?? 'never']++
      if (result) {
        if (!lastRun || result.at > lastRun) lastRun = result.at
        if (test.nodeId && graph.nodes.has(test.nodeId)) {
          const flag = (flags[test.nodeId] ??= { status: 'pass', problems: 0, tests: 0 })
          flag.tests++
          if (RANK[result.status] > RANK[flag.status]) flag.status = result.status
          if (isProblem(result.status)) flag.problems++
        }
      }
      if (wanted.nodeId ? test.nodeId === wanted.nodeId : wanted.all || isProblem(result?.status ?? null)) {
        listed.push([test, result])
      }
    }
    const rank = (result: StoredResult | undefined) => (result ? RANK[result.status] : -1)
    listed.sort(
      ([a, resultA], [b, resultB]) =>
        rank(resultB) - rank(resultA) ||
        (a.nodeId ?? '').localeCompare(b.nodeId ?? '') ||
        (a.column ?? '').localeCompare(b.column ?? '') ||
        a.label.localeCompare(b.label)
    )
    return {
      counts,
      lastRun,
      flags,
      tests: listed.slice(0, limit).map(([test, result]) => this.toResult(graph, test, result)),
      more: Math.max(0, listed.length - limit)
    }
  }

  private toResult(graph: Graph, test: TestNode, result: StoredResult | undefined): TestResult {
    const status = result?.status ?? null
    return {
      id: test.id,
      name: test.name,
      label: test.label,
      kind: test.kind,
      column: test.column,
      node: test.nodeId && graph.nodes.has(test.nodeId) ? summarize(graph, test.nodeId) : null,
      status,
      failures: result?.failures ?? null,
      message: result?.message ?? null,
      ms: result?.ms ?? null,
      at: result?.at ?? null,
      rows: (status === 'fail' || status === 'warn') && (Boolean(result?.sql) || this.compiledSql(test) !== null)
    }
  }

  private compiledSql(test: TestNode | undefined): string | null {
    if (!test?.compiledFile) return null
    const file = isAbsolute(test.compiledFile) ? test.compiledFile : join(this.projectDir, test.compiledFile)
    return existsSync(file) ? readFileSync(file, 'utf8') : null
  }
}

/**
 * The `dbt test` arguments for a run on node `nodeId`, the tests `testIds`, a selector as the
 * page's selector box takes it (`+orders tag:x --exclude y`, `selector:nightly`), or every test.
 * Null when the node or tests are not in the manifest.
 */
export function testArgs(
  graph: Graph,
  wanted: { nodeId?: string; selector?: string; testIds?: string[] }
): { args: string[]; label: string } | null {
  if (wanted.nodeId) {
    const node = graph.nodes.get(wanted.nodeId)
    return node ? { args: ['test', '--select', selectorTerm(node)], label: `tests on ${node.name}` } : null
  }
  if (wanted.testIds) {
    const names = [...new Set(wanted.testIds.flatMap((id) => graph.tests.get(id)?.name ?? []))]
    if (names.length === 0) return null
    return { args: ['test', '--select', ...names], label: names.length === 1 ? names[0] : `${names.length} tests` }
  }
  const selector = wanted.selector?.trim()
  if (!selector) return { args: ['test'], label: 'every test' }
  const yaml = /^selector:(\S+)$/.exec(selector)
  if (yaml) return { args: ['test', '--selector', yaml[1]], label: selector }
  const terms = { select: [] as string[], exclude: [] as string[] }
  let into = terms.select
  for (const token of selector.split(/\s+/)) {
    if (token === '--exclude') into = terms.exclude
    else if (token === '--select' || token === '-s') into = terms.select
    else into.push(token)
  }
  return {
    args: [
      'test',
      ...(terms.select.length > 0 ? ['--select', ...terms.select] : []),
      ...(terms.exclude.length > 0 ? ['--exclude', ...terms.exclude] : [])
    ],
    label: selector
  }
}
