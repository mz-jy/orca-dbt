// The plugin's worker: finds the focused workspace's dbt project, reads its target/manifest.json
// (and catalog.json), answers the panels' catalog and lineage requests, and runs the project's
// own dbt for data previews. Coding agents get the same over MCP (src/mcp.ts), as the tools at
// the end of this file. Orca transpiles this file when it loads: no build step.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  buildGraph,
  catalogLevel,
  focus,
  neighbors,
  nodeForFile,
  previewSql,
  reach,
  resolveNode,
  summarize,
  search,
  selectionGraph,
  subgraph,
  type Graph,
  type RawCatalog,
  type RawManifest
} from './graph'
import { buildCommand, downstream, mapChanges } from './changes'
import {
  dbtEnvironment,
  deleteDotenvVar,
  displayPath,
  envCandidates,
  envSources,
  isEnvKey,
  readEnvFiles,
  requiredEnvVars,
  setDotenvVar
} from './env'
import { branchDiff, GitError } from './git'
import { startMcpServer, type McpServer, type McpTool } from './mcp'
import { freshnessArgs, readFreshness } from './freshness'
import { findProjectDir, manifestPathFor } from './project'
import type {
  BranchChanges,
  ChangedNode,
  DbtEngine,
  EnvState,
  ProjectProblem,
  ProjectStatus,
  QualityDone,
  QualityReport,
  QualityRun,
  SourceFreshness,
  QueryResult,
  TestResult
} from './protocol'
import { testArgs, TestResults } from './quality'
import { dbtCommand, dbtError, loggedTests, parseDbtVersion, runDbt, showRows, v2ParserFailed, type DbtResult } from './runner'
import { select, SelectorError, yamlSelectors } from './selector'

type Workspace = { id: string; name: string; path: string; project?: string | null; hostId: string | null }
type Location = { workspace: Workspace; projectDir: string; manifestPath: string }
type Project = Location & { graph: Graph }

class ProjectError extends Error {
  constructor(
    readonly reason: ProjectProblem,
    message: string
  ) {
    super(message)
  }
}

/** Parsed manifests by path, re-read when manifest.json or catalog.json changes. */
const manifests = new Map<string, { version: string; graph: Promise<Graph> }>()
const MAX_CACHED_MANIFESTS = 3
const DEFAULT_SEARCH_LIMIT = 30
/** Nodes one graph request may draw; dagre and the SVG stay quick below it. */
const GRAPH_NODE_LIMIT = 400
/** Nodes one explorer level lists; a Tree draws at most 5000 items. */
const CATALOG_LEVEL_LIMIT = 1000
const MAX_QUERY_ROWS = 1000
/**
 * dbt-core settings for `dbt show`: no manifest.json, graph.gpickle or run_results.json (on a
 * large project writing them costs more than the query), and no listing of every schema the
 * project builds into (an inline query reads none of it). Variables, not flags, so dbt Fusion,
 * which may not know the flags, still runs.
 */
const QUERY_ENV = { DBT_WRITE_JSON: 'false', DBT_POPULATE_CACHE: 'false' }
/** Turns on dbt-core's v2 parser (1.12+); older dbt-core has no such variable. */
const V2_PARSER_ENV = { DBT_ENGINE_USE_V2_PARSER: 'true' }
/** Project folders the v2 parser failed on: they parse with dbt-core's own until a restart. */
const v2ParserBroken = new Set<string>()
/**
 * Per project folder, when the dbt runs queued to write target/ (all but previews) are done:
 * two at once interleave their writes and leave a manifest.json no one can read.
 */
const artifactWriters = new Map<string, Promise<void>>()
/** Long enough for a warehouse to wake up and for a person to finish an SSO sign-in. */
const JOB_TIMEOUT_MS = 10 * 60_000

/** Running query and parse jobs, so a panel can cancel them. */
const jobs = new Map<string, AbortController>()
/** `dbt --version` answers by command; it takes seconds for dbt-core. */
const engines = new Map<string, Promise<DbtEngine>>()
const DEFAULT_SELECTION_LIMIT = 500
/** Tests one quality.read lists; counts and flags always cover every test. */
const QUALITY_LIST_LIMIT = 1000
/** Test results by project folder. */
const testResults = new Map<string, TestResults>()
/** How bad a status is, to flag a node with the worst of its tests and its freshness. */
const TEST_RANK = { error: 4, fail: 3, warn: 2, skipped: 1, pass: 0 }
/** The test run or freshness check in progress, by project folder. */
const testRuns = new Map<string, QualityRun>()
/** The MCP server agents reach, once it listens: null when it is off or its port was taken. */
let agentServer: Promise<McpServer | null> = Promise.resolve(null)
/** Nodes one agent answer lists: enough to act on, short enough to read. */
const AGENT_LIST_LIMIT = 200
/** Ancestors or descendants one dbt_lineage answer lists. */
const AGENT_LINEAGE_LIMIT = 500
const AGENT_QUERY_ROWS = 20

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('lineage.status', () => projectStatus(orca))

  // Orca tells plugins nothing about the file in front of the person; a save is the one moment a
  // path reaches a plugin. The save never waits: the hook passes at once and the panel follows.
  orca.hooks.on('editor.save.before', ({ path }) => {
    void revealSaved(orca, path)
  })

  orca.panels.handle('project.choose', async ({ folder }) => {
    await orca.settings.set('projectDir', folder.trim())
    return projectStatus(orca)
  })

  orca.panels.handle('lineage.search', async ({ query, limit }) => {
    const { graph } = await loadProject(orca)
    return search(graph, query, limit ?? DEFAULT_SEARCH_LIMIT)
  })

  orca.panels.handle('lineage.node', async ({ id }) => focus((await loadProject(orca)).graph, id))

  orca.panels.handle('lineage.neighbors', async ({ id, direction }) =>
    neighbors((await loadProject(orca)).graph, id, direction)
  )

  orca.panels.handle('lineage.graph', async ({ id, up, down, expand }) =>
    subgraph((await loadProject(orca)).graph, id, up, down, expand ?? [], GRAPH_NODE_LIMIT)
  )

  orca.panels.handle('catalog.level', async ({ by, path }) =>
    catalogLevel((await loadProject(orca)).graph, by, path, CATALOG_LEVEL_LIMIT)
  )

  orca.panels.handle('catalog.select', async ({ selector, limit }) => {
    const { graph } = await loadProject(orca)
    try {
      const ids = [...select(graph, selector)]
      return {
        count: ids.length,
        nodes: ids.slice(0, limit ?? DEFAULT_SELECTION_LIMIT).map((id) => summarize(graph, id))
      }
    } catch (error) {
      if (error instanceof SelectorError) return { count: 0, nodes: [], error: error.message }
      throw error
    }
  })

  orca.panels.handle('catalog.selectors', async () => yamlSelectors((await loadProject(orca)).graph))

  orca.panels.handle('lineage.selectGraph', async ({ selector, expand }) => {
    const { graph } = await loadProject(orca)
    try {
      const ids = select(graph, selector)
      return { graph: selectionGraph(graph, ids, expand ?? [], GRAPH_NODE_LIMIT), count: ids.size }
    } catch (error) {
      if (error instanceof SelectorError) return { graph: null, count: 0, error: error.message }
      throw error
    }
  })

  orca.panels.handle('lineage.changes', async (): Promise<BranchChanges> => {
    try {
      return await branchChanges(orca)
    } catch (error) {
      if (error instanceof GitError || error instanceof ProjectError) return { ok: false, message: error.message }
      throw error
    }
  })

  orca.panels.handle('lineage.changesGraph', async ({ expand }) => {
    try {
      const changes = await branchChanges(orca)
      if (!changes.ok) return { graph: null, error: changes.message }
      const { graph } = await loadProject(orca)
      // Changed nodes first, so a graph cut at the limit still shows every change.
      const ids = new Set([...changes.changed.map((node) => node.id), ...changes.impacted.map((node) => node.id)])
      return { graph: ids.size > 0 ? selectionGraph(graph, ids, expand ?? [], GRAPH_NODE_LIMIT) : null }
    } catch (error) {
      if (error instanceof GitError || error instanceof ProjectError) return { graph: null, error: error.message }
      throw error
    }
  })

  orca.panels.handle('env.read', async () => envState(orca))

  orca.panels.handle('env.set', async ({ key, value }) => {
    if (!isEnvKey(key)) {
      throw Object.assign(new Error(`"${key}" is not a variable name: letters, digits and _, not starting with a digit.`), {
        code: 'invalid_params'
      })
    }
    const { workspace, projectDir } = await locateProject(orca)
    const { target } = envSources(workspace.path, projectDir, await stringSetting(orca, 'envFile'))
    const text = existsSync(target) ? await readFile(target, 'utf8') : ''
    await writeFile(target, setDotenvVar(text, key, value))
    return envState(orca)
  })

  orca.panels.handle('env.delete', async ({ key }) => {
    const { workspace, projectDir } = await locateProject(orca)
    for (const file of envSources(workspace.path, projectDir, await stringSetting(orca, 'envFile')).files) {
      const text = await readFile(file, 'utf8')
      const without = deleteDotenvVar(text, key)
      if (without !== text) await writeFile(file, without)
    }
    return envState(orca)
  })

  orca.panels.handle('env.choose', async ({ file }) => {
    await orca.settings.set('envFile', file.trim())
    return envState(orca)
  })

  orca.panels.handle('query.engine', async () => {
    const { workspace, projectDir } = await locateProject(orca)
    const command = dbtCommand(workspace.path, projectDir, await stringSetting(orca, 'dbtCommand'))
    const key = command.join(' ')
    let engine = engines.get(key)
    if (!engine) {
      engine = runDbt(command, ['--version'], {
        cwd: projectDir,
        env: dbtEnvironment(workspace.path, projectDir, await stringSetting(orca, 'envFile')),
        signal: AbortSignal.timeout(60_000)
      }).then(
        (run) => ({ command: key, ...parseDbtVersion([...run.lines, run.stderr].join('\n')) }),
        () => ({ command: key, version: null, flavor: 'unknown' as const })
      )
      engines.set(key, engine)
    }
    return engine
  })

  orca.panels.handle('lineage.open', async ({ id }) => {
    const { workspace, projectDir, graph } = await loadProject(orca)
    const node = graph.nodes.get(id)
    if (!node?.file) return { opened: false, message: 'This node has no file.' }
    // Installed packages keep their files under dbt_packages/<package>.
    const file = [
      join(projectDir, node.file),
      join(projectDir, 'dbt_packages', node.packageName, node.file)
    ].find((candidate) => existsSync(candidate))
    if (!file) return { opened: false, message: `${node.file} is not in this workspace.` }
    await orca.host.call('editor.open', { workspaceId: workspace.id, path: relative(workspace.path, file) })
    return { opened: true }
  })

  orca.panels.handle('query.start', async (wanted) => {
    const { jobId, sql, done } = startQuery(orca, await loadProject(orca), wanted)
    void done.then((result) => orca.panels.post('query.done', result))
    return { jobId, sql }
  })

  orca.panels.handle('quality.read', async (wanted) => qualityReport(await loadProject(orca), wanted, QUALITY_LIST_LIMIT))

  orca.panels.handle('quality.freshness', async ({ nodeId }) => startFreshness(orca, await loadProject(orca), nodeId).running)

  orca.panels.handle('quality.run', async (wanted) => startTests(orca, await loadProject(orca), wanted).running)

  orca.panels.handle('project.parse', async () => ({ jobId: startParse(orca, await locateProject(orca)).jobId }))

  orca.panels.handle('query.cancel', async ({ jobId }) => {
    const controller = jobs.get(jobId)
    controller?.abort()
    return { cancelled: controller !== undefined }
  })

  // Agents reach the same project over MCP. A port already taken (a second Orca, a development
  // copy of the plugin) is logged, and the panel works as before.
  void serveAgents(orca)
  orca.settings.onDidChange(() => void serveAgents(orca))
}

/** Tells open panels to focus the node a saved file of the focused project holds. */
async function revealSaved(orca: OrcaWorkerApi, path: string): Promise<void> {
  const project = await loadProject(orca).catch(() => null)
  if (!project) return
  const file = relative(project.projectDir, isAbsolute(path) ? path : join(project.workspace.path, path))
  if (file.startsWith('..') || isAbsolute(file)) return
  const id = nodeForFile(project.graph, file.split(sep).join('/'))
  if (id) orca.panels.post('lineage.reveal', { id })
}

export async function deactivate(): Promise<void> {
  for (const controller of jobs.values()) controller.abort()
  agentServer = agentServer.then((server) => server?.close()).then(() => null)
  await agentServer
}

/** How a background dbt run ended: its output, or why it never finished. */
type JobOutcome = { jobId: string; ms: number; run?: DbtResult; error?: string }

/**
 * Runs `dbt <args>` in the background with JSON logs; `done` resolves with the outcome. A query
 * (`dbt show`) runs the dbt command and writes nothing to target/; an artifacts run (tests,
 * parse) runs the parse and test command when set (a wrapper such as `just dbt`) and waits for
 * the project's previous one. With the v2 parser setting on, parses with it unless it failed on
 * the project before; a run it fails is repeated with dbt-core's own parser. Answers the job id
 * at once: a warehouse query can outlast a panel request's timeout.
 */
function runJob(
  orca: OrcaWorkerApi,
  workspace: Workspace,
  projectDir: string,
  args: string[],
  kind: 'query' | 'artifacts'
): { jobId: string; done: Promise<JobOutcome> } {
  const jobId = randomUUID()
  const controller = new AbortController()
  jobs.set(jobId, controller)
  const timer = setTimeout(() => controller.abort(), JOB_TIMEOUT_MS)
  const started = Date.now()
  const done = (async () => {
    let outcome: JobOutcome
    let release = () => {}
    try {
      if (kind === 'artifacts') {
        const previous = artifactWriters.get(projectDir) ?? Promise.resolve()
        const done = previous.then(() => new Promise<void>((resolve) => (release = resolve)))
        artifactWriters.set(projectDir, done)
        void done.then(() => artifactWriters.get(projectDir) === done && artifactWriters.delete(projectDir))
        await untilDone(previous, controller.signal)
      }
      const wrapper = kind === 'artifacts' ? await stringSetting(orca, 'parseTestCommand') : ''
      const command = dbtCommand(workspace.path, projectDir, wrapper || (await stringSetting(orca, 'dbtCommand')))
      const v2 = (await orca.settings.get('useV2Parser')) === true && !v2ParserBroken.has(projectDir)
      orca.log(`job ${jobId}: ${command.join(' ')} ${args[0]} in ${projectDir}${v2 ? ' (v2 parser)' : ''}`)
      const dbtArgs = [...args, '--log-format', 'json']
      const projectEnv = dbtEnvironment(workspace.path, projectDir, await stringSetting(orca, 'envFile'))
      const jobEnv = kind === 'query' ? { ...projectEnv, ...QUERY_ENV } : projectEnv
      const options = { cwd: projectDir, signal: controller.signal }
      let run = await runDbt(command, dbtArgs, { ...options, env: v2 ? { ...jobEnv, ...V2_PARSER_ENV } : jobEnv })
      if (v2 && v2ParserFailed(run)) {
        v2ParserBroken.add(projectDir)
        orca.log(`job ${jobId}: the v2 parser failed on ${projectDir}; running again with dbt-core's own parser`)
        run = await runDbt(command, dbtArgs, { ...options, env: jobEnv })
      }
      outcome = { jobId, ms: Date.now() - started, run }
    } catch (error) {
      const ms = Date.now() - started
      const message = controller.signal.aborted
        ? ms >= JOB_TIMEOUT_MS
          ? 'Timed out after 10 minutes.'
          : 'Cancelled.'
        : error instanceof Error
          ? error.message
          : String(error)
      outcome = { jobId, ms, error: message }
    } finally {
      release()
      clearTimeout(timer)
      jobs.delete(jobId)
    }
    return outcome
  })()
  return { jobId, done }
}

/**
 * Starts `sql` (Jinja allowed), the rows test `testId` found, or a preview of node `id`, as
 * `dbt show`; `done` resolves with the rows or the error.
 */
function startQuery(
  orca: OrcaWorkerApi,
  project: Project,
  { id, sql: given, testId, limit }: { id?: string; sql?: string; testId?: string; limit: number }
): { jobId: string; sql: string; done: Promise<QueryResult> } {
  const { workspace, projectDir, graph } = project
  const node = id ? graph.nodes.get(id) : undefined
  const sql =
    given?.trim() ||
    (testId ? resultsFor(project).failingRowsSql(graph, testId) : null) ||
    (node && previewSql(node.id, node.type, node.name, node.packageName))
  if (!sql) {
    throw Object.assign(
      new Error(testId ? 'dbt has not compiled this test yet: run it first.' : 'Only models, seeds, snapshots and sources hold rows to preview.'),
      { code: 'invalid_params' }
    )
  }
  const rows = Math.min(Math.max(Math.trunc(limit), 1), MAX_QUERY_ROWS)
  const job = runJob(orca, workspace, projectDir, ['show', '--inline', sql, '--limit', String(rows), '--output', 'json'], 'query')
  const done = job.done.then(({ jobId, ms, run, error }): QueryResult => {
    const shown = run?.code === 0 ? showRows(run) : null
    return shown ? { jobId, ok: true, ...shown, ms } : { jobId, ok: false, error: error ?? dbtError(run!), ms }
  })
  return { jobId: job.jobId, sql, done }
}

/**
 * Test results and source freshness as the panel and agents read them: the problems, everything
 * with `all`, or one node's with `nodeId`. A stale source is flagged like a failing test.
 */
function qualityReport(project: Project, wanted: { all?: boolean; nodeId?: string }, limit: number): QualityReport {
  const { graph, projectDir, manifestPath } = project
  const results = resultsFor(project)
  results.sync(graph)
  const report = results.report(graph, wanted, limit)
  const fresh = readFreshness(graph, dirname(manifestPath))
  for (const { node, status } of fresh.sources) {
    if (!status) continue
    const flag = (report.flags[node.id] ??= { status: 'pass', problems: 0, tests: 0 })
    flag.freshness = status
    if (status !== 'pass') flag.problems++
    if (TEST_RANK[status] > TEST_RANK[flag.status]) flag.status = status
  }
  const listed = (source: SourceFreshness) =>
    wanted.nodeId ? source.node.id === wanted.nodeId : wanted.all || (source.status !== null && source.status !== 'pass')
  return {
    ...report,
    freshness: { counts: fresh.counts, checkedAt: fresh.checkedAt, sources: fresh.sources.filter(listed).slice(0, limit) },
    running: testRuns.get(projectDir) ?? null
  }
}

/**
 * Starts `dbt test` on what `wanted` names (see `testArgs`), one run at a time per project.
 * When it ends, open panels hear `quality.done` (whoever started it) and `done` resolves with the same.
 */
function startTests(
  orca: OrcaWorkerApi,
  project: Project,
  wanted: { nodeId?: string; selector?: string; testIds?: string[] }
): { running: QualityRun; done: Promise<QualityDone> } {
  const run = testArgs(project.graph, wanted)
  if (!run) throw Object.assign(new Error('The manifest no longer has those tests: parse again.'), { code: 'invalid_params' })
  return startQualityRun(orca, project, run, (ended, startedAt) => {
    const results = resultsFor(project)
    results.sync(project.graph)
    if (ended) results.correct(loggedTests(ended))
    // A run that wrote run_results.json ran its tests, failing or not; one that did not
    // stopped before them (a compile error, a missing profile).
    return results.last && Date.parse(results.last.at) >= startedAt - 1000 ? results.last.tests : null
  })
}

/**
 * Starts `dbt source freshness` on source `nodeId`, or on every source with a rule. dbt exits
 * with an error when a source is stale: a run that wrote sources.json checked its sources.
 */
function startFreshness(orca: OrcaWorkerApi, project: Project, nodeId?: string): { running: QualityRun; done: Promise<QualityDone> } {
  const run = freshnessArgs(project.graph, nodeId)
  if (!run) throw Object.assign(new Error('Only sources have a freshness to check.'), { code: 'invalid_params' })
  return startQualityRun(orca, project, run, (_ended, startedAt) => {
    const fresh = readFreshness(project.graph, dirname(project.manifestPath))
    return fresh.checkedAt && Date.parse(fresh.checkedAt) >= startedAt - 1000 ? fresh.checked : null
  })
}

/**
 * Runs `dbt <run.args>` as the project's one test run or freshness check at a time. `counted`
 * reads what the run wrote: how many results it left, or null when it stopped before any.
 */
function startQualityRun(
  orca: OrcaWorkerApi,
  project: Project,
  run: { args: string[]; label: string },
  counted: (ended: DbtResult | undefined, startedAt: number) => number | null
): { running: QualityRun; done: Promise<QualityDone> } {
  const { workspace, projectDir } = project
  if (testRuns.has(projectDir)) {
    throw Object.assign(new Error(`Already running ${testRuns.get(projectDir)!.label}. Cancel it first.`), { code: 'invalid_params' })
  }
  const startedAt = Date.now()
  const job = runJob(orca, workspace, projectDir, run.args, 'artifacts')
  const running = { jobId: job.jobId, label: run.label, startedAt }
  testRuns.set(projectDir, running)
  const done = job.done.then(({ jobId, run: ended, error }): QualityDone => {
    testRuns.delete(projectDir)
    const ran = counted(ended, startedAt)
    const outcome: QualityDone =
      ran !== null && !error ? { jobId, ok: true, ran } : { jobId, ok: false, ran: 0, error: error ?? dbtError(ended!) }
    orca.panels.post('quality.done', outcome)
    return outcome
  })
  return { running, done }
}

/** Starts `dbt parse`; open panels hear `parse.done` and `done` resolves with the same. */
function startParse(
  orca: OrcaWorkerApi,
  { workspace, projectDir }: Location
): { jobId: string; done: Promise<{ jobId: string; ok: boolean; error?: string }> } {
  const job = runJob(orca, workspace, projectDir, ['parse'], 'artifacts')
  const done = job.done.then(({ jobId, run, error }) => {
    const outcome = run?.code === 0 ? { jobId, ok: true } : { jobId, ok: false, error: error ?? dbtError(run!) }
    orca.panels.post('parse.done', outcome)
    return outcome
  })
  return { jobId: job.jobId, done }
}

/** Waits for `promise`, or rejects when `signal` aborts first. */
function untilDone(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    })
  })
}

async function projectStatus(orca: OrcaWorkerApi): Promise<ProjectStatus> {
  try {
    const { workspace, projectDir, graph } = await loadProject(orca)
    return {
      ok: true,
      projectName: graph.projectName,
      workspaceName: workspace.project ? `${workspace.project} · ${workspace.name}` : workspace.name,
      projectDir: relative(workspace.path, projectDir),
      generatedAt: graph.generatedAt,
      dbtVersion: graph.dbtVersion,
      nodeCount: graph.nodes.size
    }
  } catch (error) {
    if (error instanceof ProjectError) return { ok: false, reason: error.reason, message: error.message }
    throw error
  }
}

/**
 * The focused workspace, or the one that holds folder `cwd` (an agent says where it works; the
 * person may be looking at another workspace), and its dbt project folder, without reading the manifest.
 */
async function locateProject(orca: OrcaWorkerApi, cwd?: string): Promise<Location> {
  const { workspaces } = await orca.host.call('workspace.list')
  let workspace: Workspace | undefined
  if (cwd) {
    // The deepest one: a worktree can sit inside another workspace's folder.
    workspace = workspaces
      .filter((row) => (row.hostId === null || row.hostId === 'local') && !relative(row.path, cwd).startsWith('..'))
      .sort((a, b) => b.path.length - a.path.length)[0]
    if (!workspace) {
      // An agent started outside Orca: its folder stands in for a workspace.
      if (!isAbsolute(cwd) || !existsSync(cwd)) throw new ProjectError('no_workspace', `"${cwd}" is not a folder on this computer.`)
      workspace = { id: cwd, name: basename(cwd), path: cwd, hostId: null }
    }
  } else {
    const context = await orca.host.call('workspace.readContext')
    if (!context?.workspaceId) {
      throw new ProjectError('no_workspace', 'Open a workspace to see its dbt lineage.')
    }
    workspace = workspaces.find((row) => row.id === context.workspaceId)
    if (!workspace) {
      orca.log(`workspace ${context.workspaceId} is not in workspace.list`)
      throw new ProjectError('no_workspace', `Orca did not list the workspace "${context.displayName}".`)
    }
  }
  if (workspace.hostId !== null && workspace.hostId !== 'local') {
    throw new ProjectError('remote', 'dbt lineage reads files on this computer; this workspace is on another host.')
  }

  const configured = await stringSetting(orca, 'projectDir')
  const projectDir = findProjectDir(workspace.path, configured)
  if (!projectDir) {
    throw new ProjectError(
      'no_project',
      configured
        ? `No dbt_project.yml in "${configured}". Fix the project folder here or in this plugin's settings.`
        : "No dbt_project.yml within three folders of the workspace root. Set the project folder here or in this plugin's settings."
    )
  }
  return { workspace, projectDir, manifestPath: manifestPathFor(projectDir) }
}

/** A string setting the person may have left empty (auto-detection): '' then. */
async function stringSetting(
  orca: OrcaWorkerApi,
  key: 'projectDir' | 'dbtCommand' | 'parseTestCommand' | 'baseBranch' | 'envFile'
): Promise<string> {
  const value = await orca.settings.get(key)
  return typeof value === 'string' ? value.trim() : ''
}

/** Where query variables come from, what they set, and what the dbt profile needs. */
async function envState(orca: OrcaWorkerApi): Promise<EnvState> {
  const { workspace, projectDir } = await locateProject(orca)
  const configured = await stringSetting(orca, 'envFile')
  const sources = envSources(workspace.path, projectDir, configured)
  const vars = readEnvFiles(sources.files)
  const fromFiles = new Set(vars.map((entry) => entry.key))
  const needed = requiredEnvVars(projectDir, dbtEnvironment(workspace.path, projectDir, configured))
  const show = (file: string) => displayPath(workspace.path, file)
  return {
    configured,
    files: sources.files.map(show),
    target: show(sources.target),
    candidates: envCandidates(workspace.path, projectDir).map(show),
    vars: vars.map((entry) => ({ ...entry, file: show(entry.file) })),
    profile: needed.profile,
    profilesFile: needed.profilesFile ? show(needed.profilesFile) : null,
    required: needed.vars.map((entry) => ({
      ...entry,
      setBy: fromFiles.has(entry.key) ? 'file' : process.env[entry.key] !== undefined ? 'orca' : null
    }))
  }
}

/** The branch's changes mapped onto the manifest, with what they reach downstream. */
async function branchChanges(orca: OrcaWorkerApi, cwd?: string): Promise<BranchChanges> {
  const { projectDir, manifestPath, graph } = await loadProject(orca, cwd)
  const diff = await branchDiff(projectDir, await stringSetting(orca, 'baseBranch'))
  const mapped = mapChanges(graph, diff.files)
  // An edited file newer than the manifest may hold models or refs the manifest lacks yet.
  const manifestTime = (await stat(manifestPath)).mtimeMs
  const times = await Promise.all(
    diff.files
      .filter((file) => file.status !== 'D')
      .slice(0, 500)
      .map((file) => stat(join(projectDir, file.path)).then((info) => info.mtimeMs, () => 0))
  )
  return {
    ok: true,
    head: diff.head,
    base: diff.base,
    mergeBase: diff.mergeBase,
    ...mapped,
    manifestStale: times.some((time) => time > manifestTime),
    command: buildCommand(graph, mapped.changed)
  }
}

/** The project's test results, read from its target folder once per worker. */
function resultsFor({ projectDir, manifestPath }: Location): TestResults {
  let results = testResults.get(projectDir)
  if (!results) {
    results = new TestResults(projectDir, dirname(manifestPath))
    testResults.set(projectDir, results)
  }
  return results
}

async function loadProject(orca: OrcaWorkerApi, cwd?: string): Promise<Project> {
  const location = await locateProject(orca, cwd)
  const { workspace, manifestPath } = location
  const graph = await readGraph(manifestPath).catch((error: NodeJS.ErrnoException) => {
    const where = relative(workspace.path, manifestPath)
    if (error.code === 'ENOENT') {
      throw new ProjectError('no_manifest', `No ${where} yet. Run \`dbt parse\` to write it.`)
    }
    throw new ProjectError('unreadable', `Could not read ${where}: ${error.message}`)
  })
  return { ...location, graph }
}

async function readGraph(manifestPath: string): Promise<Graph> {
  const catalogPath = join(dirname(manifestPath), 'catalog.json')
  const [manifestStat, catalogStat] = await Promise.all([stat(manifestPath), stat(catalogPath).catch(() => null)])
  const version = `${manifestStat.mtimeMs}:${catalogStat?.mtimeMs ?? 'none'}`
  const cached = manifests.get(manifestPath)
  if (cached?.version === version) return cached.graph

  const graph = Promise.all([
    readFile(manifestPath, 'utf8'),
    catalogStat ? readFile(catalogPath, 'utf8') : Promise.resolve(null)
  ]).then(([manifest, catalog]) =>
    buildGraph(JSON.parse(manifest) as RawManifest, catalog ? (JSON.parse(catalog) as RawCatalog) : null)
  )
  const entry = { version, graph }
  manifests.delete(manifestPath)
  manifests.set(manifestPath, entry)
  if (manifests.size > MAX_CACHED_MANIFESTS) manifests.delete(manifests.keys().next().value!)
  // A failed read is not cached: the next request tries again.
  graph.catch(() => {
    if (manifests.get(manifestPath) === entry) manifests.delete(manifestPath)
  })
  return graph
}

/**
 * Starts the MCP server on the "MCP server port" setting, or moves it when the setting changed;
 * 0 turns it off. Calls take turns, so two setting changes never start two servers.
 */
function serveAgents(orca: OrcaWorkerApi): Promise<unknown> {
  agentServer = agentServer.then(async (current) => {
    const setting = await orca.settings.get('mcpPort').catch(() => undefined)
    const port = typeof setting === 'number' && Number.isInteger(setting) && setting > 0 && setting < 65536 ? setting : 0
    if (current?.port === port) return current
    await current?.close()
    if (port === 0) return null
    try {
      const server = await startMcpServer(port, {
        name: 'orca-dbt',
        version: pluginVersion(),
        instructions:
          'The dbt project of an Orca workspace, read from its manifest and run with its own dbt. Pass `workspace`, the absolute path of the folder you work in, to every tool: without it they answer for the workspace the person has focused in Orca, which may not be yours. After editing models, dbt_impact shows what the branch changed and everything downstream, and dbt_run_tests tests it. When dbt_impact says manifestStale, or a node you added is missing, call dbt_parse first.',
        tools: agentTools(orca)
      })
      orca.log(`MCP server at http://127.0.0.1:${server.port}/mcp`)
      return server
    } catch (error) {
      orca.log(`MCP server not started on port ${port}: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  })
  return agentServer
}

function pluginVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8')) as { version?: string }
    return manifest.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** A text argument, trimmed; undefined when left out or empty. */
function textArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${key} must be text.`)
  return value.trim() || undefined
}

/** A whole-number argument between 0 and `max`; `fallback` when left out. */
function countArg(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const value = args[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a number.`)
  return Math.min(Math.max(Math.trunc(value), 0), max)
}

/** The node an agent named, or an error that says what it could have meant. */
function namedNode(graph: Graph, reference: string) {
  const node = resolveNode(graph, reference)
  if (node) return node
  const near = search(graph, reference, 5).map((found) => found.id)
  throw new Error(
    `The manifest has no node "${reference}".${near.length > 0 ? ` Did you mean: ${near.join(', ')}?` : ''} A node added since the last parse appears after dbt_parse.`
  )
}

/** A test as an agent reads it: what it checks, how it last ran, and what it found. */
function briefTest(test: TestResult) {
  return {
    id: test.id,
    test: test.label,
    kind: test.kind,
    node: test.node?.name ?? null,
    column: test.column,
    status: test.status ?? 'never ran',
    failures: test.failures,
    message: test.message,
    at: test.at,
    /** dbt_query with test_id shows the rows it found. */
    hasFailingRows: test.rows
  }
}

/** A source's freshness as an agent reads it. */
function briefFreshness(source: SourceFreshness) {
  const window = (after: SourceFreshness['warnAfter']) => (after ? `${after.count} ${after.period}${after.count === 1 ? '' : 's'}` : null)
  return {
    source: source.node.name,
    id: source.node.id,
    status: source.status === null ? 'never checked' : FRESHNESS_WORDS[source.status],
    lastLoadedAt: source.maxLoadedAt,
    checkedAt: source.checkedAt,
    warnAfter: window(source.warnAfter),
    errorAfter: window(source.errorAfter),
    loadedAtField: source.loadedAtField,
    message: source.message
  }
}

const FRESHNESS_WORDS = { pass: 'fresh', warn: 'warn: past warn_after', fail: 'stale: past error_after', error: 'check failed' }

const brief = ({ id, name, type }: { id: string; name: string; type: string }) => ({ id, name, type })

/** What agents can do over MCP: the panel's catalog, lineage, changes, tests and queries, each answered in one call. */
function agentTools(orca: OrcaWorkerApi): McpTool[] {
  const workspace = {
    workspace: {
      type: 'string',
      description: 'Absolute path of the folder you work in (your worktree or repository). Leave out for the workspace focused in Orca.'
    }
  }
  const nodeRef = 'A node by name (orders; raw.orders for a source) or unique id (model.shop.orders).'
  const project = (args: Record<string, unknown>) => loadProject(orca, textArg(args, 'workspace'))
  /** Stops job `jobId` when the agent stops waiting for it. */
  const stopWith = (signal: AbortSignal, jobId: string) => signal.addEventListener('abort', () => jobs.get(jobId)?.abort(), { once: true })

  return [
    {
      name: 'dbt_project',
      description:
        'The dbt project of the workspace: its name and folder, when its manifest was written, how many nodes of each type and tests it has, and its YAML selectors. Start here; an error says what is missing (no project, no manifest yet).',
      input: { properties: workspace },
      readOnly: true,
      run: async (args) => {
        const { projectDir, graph } = await project(args)
        const nodes: Record<string, number> = {}
        for (const node of graph.nodes.values()) nodes[node.type] = (nodes[node.type] ?? 0) + 1
        return {
          project: graph.projectName,
          folder: projectDir,
          manifestWrittenAt: graph.generatedAt,
          dbtVersion: graph.dbtVersion,
          nodes,
          tests: graph.tests.size,
          selectors: yamlSelectors(graph).map((selector) => selector.name)
        }
      }
    },
    {
      name: 'dbt_search',
      description: 'Finds models, sources, seeds, snapshots and exposures by name, id, column name or description; best match first.',
      input: {
        properties: { query: { type: 'string' }, limit: { type: 'integer', description: 'Default 30.' }, ...workspace },
        required: ['query']
      },
      readOnly: true,
      run: async (args) => search((await project(args)).graph, textArg(args, 'query') ?? '', countArg(args, 'limit', DEFAULT_SEARCH_LIMIT, AGENT_LIST_LIMIT))
    },
    {
      name: 'dbt_node',
      description:
        'One node in full: its file, relation, materialization, description, tags, owner, meta, columns with types and tests, direct parents and children, and the latest result of each of its tests.',
      input: { properties: { node: { type: 'string', description: nodeRef }, ...workspace }, required: ['node'] },
      readOnly: true,
      run: async (args) => {
        const loaded = await project(args)
        const { graph } = loaded
        const { id } = namedNode(graph, textArg(args, 'node') ?? '')
        const report = qualityReport(loaded, { nodeId: id }, AGENT_LIST_LIMIT)
        const found = focus(graph, id)!
        return {
          ...found.node,
          parents: found.parents.map(brief),
          children: found.children.map(brief),
          tests: report.tests.map(briefTest),
          ...(report.freshness.sources.length > 0 ? { freshness: briefFreshness(report.freshness.sources[0]) } : {})
        }
      }
    },
    {
      name: 'dbt_lineage',
      description:
        'Everything upstream and downstream of a node, nearest first, each with its distance in edges. Downstream is what a change to the node can break (exposures are the dashboards and apps that read it).',
      input: {
        properties: {
          node: { type: 'string', description: nodeRef },
          upstream: { type: 'integer', description: 'Levels of ancestors; all of them by default, 0 for none.' },
          downstream: { type: 'integer', description: 'Levels of descendants; all of them by default, 0 for none.' },
          ...workspace
        },
        required: ['node']
      },
      readOnly: true,
      run: async (args) => {
        const { graph } = await project(args)
        const { id } = namedNode(graph, textArg(args, 'node') ?? '')
        const walk = (direction: 'up' | 'down', key: string) => {
          const { nodes, truncated } = reach(graph, id, direction, countArg(args, key, Infinity, Infinity), AGENT_LINEAGE_LIMIT)
          return { nodes: nodes.map((node) => ({ ...brief(node), depth: node.depth })), ...(truncated ? { truncated } : {}) }
        }
        return { node: brief(summarize(graph, id)), upstream: walk('up', 'upstream'), downstream: walk('down', 'downstream') }
      }
    },
    {
      name: 'dbt_select',
      description:
        'The nodes a dbt selector chooses, evaluated on the manifest without running dbt: `+orders+`, `tag:finance,config.materialized:table`, `path:models/marts --exclude stg_*`, `selector:nightly`. Not supported: state:, result:, source_status:, test_name:, test_type:.',
      input: {
        properties: { selector: { type: 'string' }, limit: { type: 'integer', description: `Default ${AGENT_LIST_LIMIT}.` }, ...workspace },
        required: ['selector']
      },
      readOnly: true,
      run: async (args) => {
        const { graph } = await project(args)
        const ids = [...select(graph, textArg(args, 'selector') ?? '')]
        return { count: ids.length, nodes: ids.slice(0, countArg(args, 'limit', AGENT_LIST_LIMIT, 5000)).map((id) => brief(summarize(graph, id))) }
      }
    },
    {
      name: 'dbt_impact',
      description:
        "Impact analysis. Without `nodes`: what the branch changed since its base (committed, uncommitted and untracked files, mapped to nodes: added, modified, yaml for a changed .yml, macro for a changed macro it calls), every node downstream of that, the exposures reached, and a selector that builds and tests exactly that. With `nodes`: the same for a change to those nodes, whatever git says. manifestStale means a changed file is newer than the manifest: call dbt_parse, then ask again.",
      input: {
        properties: {
          nodes: { type: 'array', items: { type: 'string' }, description: `Nodes you plan to change, instead of the branch's changes. ${nodeRef}` },
          ...workspace
        }
      },
      readOnly: true,
      run: async (args) => {
        const cwd = textArg(args, 'workspace')
        const named = Array.isArray(args.nodes) ? args.nodes.map(String) : []
        const { graph } = await loadProject(orca, cwd)
        let changes: { changed: ChangedNode[]; impacted: { id: string; name: string; type: string }[]; command: string | null }
        let fromGit = {}
        if (named.length > 0) {
          const changed = named.map((reference) => ({ ...summarize(graph, namedNode(graph, reference).id), change: 'modified' as const, files: [] }))
          const impacted = [...downstream(graph, new Set(changed.map((node) => node.id)))].map((id) => summarize(graph, id))
          changes = { changed, impacted, command: buildCommand(graph, changed) }
        } else {
          const found = await branchChanges(orca, cwd)
          if (!found.ok) throw new Error(found.message)
          const { head, base, mergeBase, removed, unmapped, manifestStale } = found
          changes = found
          fromGit = { head, base, mergeBase, removedFiles: removed, filesOfNoNode: unmapped, manifestStale }
        }
        const reached = new Set([...changes.changed, ...changes.impacted].map((node) => node.id))
        // A command cut short ends with an ellipsis: no selector then, rather than half of one.
        const selector = changes.command && !changes.command.endsWith('…') ? changes.command.replace('dbt build --select ', '') : null
        return {
          ...fromGit,
          changed: changes.changed.map((node) => ({ ...brief(node), ...(named.length > 0 ? {} : { change: node.change, files: node.files }) })),
          downstream: changes.impacted.slice(0, AGENT_LINEAGE_LIMIT).map(brief),
          downstreamCount: changes.impacted.length,
          exposures: [...changes.changed, ...changes.impacted].filter((node) => node.type === 'exposure').map((node) => node.name),
          tests: [...graph.tests.values()].filter((test) => test.nodeId !== null && reached.has(test.nodeId)).length,
          /** For dbt_run_tests, or `dbt build --select <selector>` in a terminal. */
          selector,
          buildCommand: changes.command
        }
      }
    },
    {
      name: 'dbt_test_results',
      description:
        "The latest result of the project's data and unit tests, from target/run_results.json (runs from a terminal count): counts by status, and the failing, erroring and warning tests, worst first. With `node`, that node's tests; with `all`, every test. Runs nothing.",
      input: {
        properties: { node: { type: 'string', description: nodeRef }, all: { type: 'boolean' }, ...workspace }
      },
      readOnly: true,
      run: async (args) => {
        const loaded = await project(args)
        const { graph } = loaded
        const node = textArg(args, 'node')
        const results = resultsFor(loaded)
        results.sync(graph)
        const report = results.report(graph, { all: args.all === true, nodeId: node && namedNode(graph, node).id }, AGENT_LIST_LIMIT)
        return {
          counts: report.counts,
          lastRun: report.lastRun,
          running: testRuns.get(loaded.projectDir)?.label ?? null,
          tests: report.tests.map(briefTest),
          ...(report.more > 0 ? { more: report.more } : {})
        }
      }
    },
    {
      name: 'dbt_run_tests',
      description:
        "Runs `dbt test` with the project's own dbt, on the warehouse of its profile, and waits for it: on one node's tests (`node`), on a dbt selector (`selector`, such as the one dbt_impact gives, or `selector:nightly`), on the tests `test_ids` (to re-run failing ones), or on every test when none is given. Answers with counts by status and each failing, erroring or warning test with its message. It tests what is built in the warehouse: build changed models first (`dbt build --select …` in a terminal). One run at a time per project; it can take minutes.",
      input: {
        properties: {
          node: { type: 'string', description: nodeRef },
          selector: { type: 'string', description: 'A dbt selector: `stg_orders+`, `tag:finance --exclude orders`, `selector:nightly`.' },
          test_ids: { type: 'array', items: { type: 'string' }, description: 'Test unique ids, as dbt_test_results lists them.' },
          ...workspace
        }
      },
      readOnly: false,
      run: async (args, signal) => {
        const loaded = await project(args)
        const { graph } = loaded
        const node = textArg(args, 'node')
        const started = startTests(orca, loaded, {
          nodeId: node && namedNode(graph, node).id,
          selector: textArg(args, 'selector'),
          testIds: Array.isArray(args.test_ids) && args.test_ids.length > 0 ? args.test_ids.map(String) : undefined
        })
        stopWith(signal, started.running.jobId)
        const done = await started.done
        if (!done.ok) throw new Error(done.error ?? 'dbt test stopped before running any test.')
        // The tests of this run are those whose result carries its time.
        const results = resultsFor(loaded)
        const ran = results.report(graph, { all: true }, Infinity).tests.filter((test) => test.at === results.last?.at)
        const counts: Record<string, number> = {}
        for (const test of ran) counts[test.status ?? 'never ran'] = (counts[test.status ?? 'never ran'] ?? 0) + 1
        const problems = ran.filter((test) => test.status === 'error' || test.status === 'fail' || test.status === 'warn')
        return {
          ran: done.ran,
          counts,
          problems: problems.slice(0, AGENT_LIST_LIMIT).map(briefTest),
          ...(problems.length > AGENT_LIST_LIMIT ? { more: problems.length - AGENT_LIST_LIMIT } : {})
        }
      }
    },
    {
      name: 'dbt_source_freshness',
      description:
        "Source freshness: for each source with a warn_after or error_after rule, when it last received data, when that was checked, and whether it is fresh, past warn_after, stale (past error_after) or its check failed; stale ones first. Reads the latest check (target/sources.json; runs from a terminal count). With `check`, runs `dbt source freshness` on the warehouse first and waits for it. With `source`, one source only.",
      input: {
        properties: {
          check: { type: 'boolean', description: 'Run `dbt source freshness` now, rather than read the latest check.' },
          source: { type: 'string', description: 'One source, by name (raw.orders) or unique id (source.shop.raw.orders).' },
          ...workspace
        }
      },
      readOnly: false,
      run: async (args, signal) => {
        const loaded = await project(args)
        const source = textArg(args, 'source')
        const nodeId = source && namedNode(loaded.graph, source).id
        if (args.check === true) {
          const started = startFreshness(orca, loaded, nodeId)
          stopWith(signal, started.running.jobId)
          const done = await started.done
          if (!done.ok) throw new Error(done.error ?? 'dbt source freshness stopped before checking any source.')
        }
        const { freshness } = qualityReport(loaded, nodeId ? { nodeId } : { all: true }, AGENT_LIST_LIMIT)
        return {
          counts: { fresh: freshness.counts.pass, warn: freshness.counts.warn, stale: freshness.counts.fail, checkFailed: freshness.counts.error, neverChecked: freshness.counts.never },
          lastCheck: freshness.checkedAt,
          sources: freshness.sources.map(briefFreshness)
        }
      }
    },
    {
      name: 'dbt_query',
      description:
        "Runs a query on the warehouse through the project's own dbt (`dbt show`), so with its profile and credentials, and answers with the rows: `sql` (a select; Jinja works: `select count(*) from {{ ref('orders') }}`), or the first rows of `node`, or the rows a failing test found (`test_id`).",
      input: {
        properties: {
          sql: { type: 'string' },
          node: { type: 'string', description: `Preview this model, seed, snapshot or source. ${nodeRef}` },
          test_id: { type: 'string', description: 'The unique id of a failing or warning test.' },
          limit: { type: 'integer', description: `Rows to return; default ${AGENT_QUERY_ROWS}, at most ${MAX_QUERY_ROWS}.` },
          ...workspace
        }
      },
      readOnly: false,
      run: async (args, signal) => {
        const loaded = await project(args)
        const sql = textArg(args, 'sql')
        const testId = textArg(args, 'test_id')
        const node = textArg(args, 'node')
        if (!sql && !testId && !node) throw new Error('Give sql, node or test_id.')
        const query = startQuery(orca, loaded, {
          sql,
          testId,
          id: node && namedNode(loaded.graph, node).id,
          limit: countArg(args, 'limit', AGENT_QUERY_ROWS, MAX_QUERY_ROWS)
        })
        stopWith(signal, query.jobId)
        const result = await query.done
        if (!result.ok) throw new Error(result.error)
        return { sql: query.sql, columns: result.columns, rows: result.rows, truncated: result.truncated, ms: result.ms }
      }
    },
    {
      name: 'dbt_parse',
      description:
        "Runs `dbt parse` to rewrite target/manifest.json, so models, columns, tests and refs added or changed since the last parse show up in the other tools. Waits for it: seconds on a small project, a minute or more on a large one.",
      input: { properties: workspace },
      readOnly: false,
      run: async (args, signal) => {
        const cwd = textArg(args, 'workspace')
        const parse = startParse(orca, await locateProject(orca, cwd))
        stopWith(signal, parse.jobId)
        const done = await parse.done
        // dbt v2 can fail a parse and still write the manifest: say both.
        const written = await loadProject(orca, cwd).then(
          ({ graph }) => ({ manifestWrittenAt: graph.generatedAt, nodes: graph.nodes.size }),
          () => null
        )
        if (!done.ok) throw new Error(`${done.error ?? 'dbt parse failed.'}${written ? `\n(The manifest is readable: written ${written.manifestWrittenAt}.)` : ''}`)
        return { ok: true, ...written }
      }
    }
  ]
}
