// The plugin's worker: finds the focused workspace's dbt project, reads its target/manifest.json
// (and catalog.json), answers the panels' catalog and lineage requests, and runs the project's
// own dbt for data previews. Orca transpiles this file when it loads: no build step.
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  buildGraph,
  catalogLevel,
  focus,
  neighbors,
  nodeForFile,
  previewSql,
  summarize,
  search,
  selectionGraph,
  subgraph,
  type Graph,
  type RawCatalog,
  type RawManifest
} from './graph'
import { buildCommand, mapChanges } from './changes'
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
import { findProjectDir, manifestPathFor } from './project'
import type { BranchChanges, DbtEngine, EnvState, ProjectProblem, ProjectStatus, QualityRun } from './protocol'
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
/** The test run in progress, by project folder. */
const testRuns = new Map<string, QualityRun>()

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

  orca.panels.handle('query.start', async ({ id, sql: given, testId, limit }) => {
    const project = await loadProject(orca)
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
    const args = ['show', '--inline', sql, '--limit', String(rows), '--output', 'json']
    const jobId = startJob(orca, workspace, projectDir, args, 'query', ({ jobId, ms, run, error }) => {
      const shown = run?.code === 0 ? showRows(run) : null
      orca.panels.post(
        'query.done',
        shown ? { jobId, ok: true, ...shown, ms } : { jobId, ok: false, error: error ?? dbtError(run!), ms }
      )
    })
    return { jobId, sql }
  })

  orca.panels.handle('quality.read', async ({ all, nodeId }) => {
    const project = await loadProject(orca)
    const results = resultsFor(project)
    results.sync(project.graph)
    return {
      ...results.report(project.graph, { all, nodeId }, QUALITY_LIST_LIMIT),
      running: testRuns.get(project.projectDir) ?? null
    }
  })

  orca.panels.handle('quality.run', async (wanted) => {
    const project = await loadProject(orca)
    const { workspace, projectDir, graph } = project
    if (testRuns.has(projectDir)) {
      throw Object.assign(new Error('Tests are already running. Cancel them first.'), { code: 'invalid_params' })
    }
    const run = testArgs(graph, wanted)
    if (!run) throw Object.assign(new Error('The manifest no longer has those tests: parse again.'), { code: 'invalid_params' })
    const startedAt = Date.now()
    const jobId = startJob(orca, workspace, projectDir, run.args, 'artifacts', ({ jobId, run: done, error }) => {
      testRuns.delete(projectDir)
      const results = resultsFor(project)
      results.sync(graph)
      if (done) results.correct(loggedTests(done))
      // A run that wrote run_results.json ran its tests, failing or not; one that did not
      // stopped before them (a compile error, a missing profile).
      const ran = results.last && Date.parse(results.last.at) >= startedAt - 1000 ? results.last.tests : null
      orca.panels.post(
        'quality.done',
        ran !== null && !error ? { jobId, ok: true, ran } : { jobId, ok: false, ran: 0, error: error ?? dbtError(done!) }
      )
    })
    const running = { jobId, label: run.label, startedAt }
    testRuns.set(projectDir, running)
    return running
  })

  orca.panels.handle('project.parse', async () => {
    const { workspace, projectDir } = await locateProject(orca)
    const jobId = startJob(orca, workspace, projectDir, ['parse'], 'artifacts', ({ jobId, run, error }) => {
      orca.panels.post(
        'parse.done',
        run?.code === 0 ? { jobId, ok: true } : { jobId, ok: false, error: error ?? dbtError(run!) }
      )
    })
    return { jobId }
  })

  orca.panels.handle('query.cancel', async ({ jobId }) => {
    const controller = jobs.get(jobId)
    controller?.abort()
    return { cancelled: controller !== undefined }
  })
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

export function deactivate(): void {
  for (const controller of jobs.values()) controller.abort()
}

/** How a background dbt run ended: its output, or why it never finished. */
type JobOutcome = { jobId: string; ms: number; run?: DbtResult; error?: string }

/**
 * Runs `dbt <args>` in the background with JSON logs and hands `settle` the outcome. A query
 * (`dbt show`) runs the dbt command and writes nothing to target/; an artifacts run (tests,
 * parse) runs the parse and test command when set (a wrapper such as `just dbt`) and waits for
 * the project's previous one. With the v2 parser setting on, parses with it unless it failed on
 * the project before; a run it fails is repeated with dbt-core's own parser. Answers the job id
 * at once: a warehouse query can outlast a panel request's timeout.
 */
function startJob(
  orca: OrcaWorkerApi,
  workspace: Workspace,
  projectDir: string,
  args: string[],
  kind: 'query' | 'artifacts',
  settle: (outcome: JobOutcome) => void
): string {
  const jobId = randomUUID()
  const controller = new AbortController()
  jobs.set(jobId, controller)
  const timer = setTimeout(() => controller.abort(), JOB_TIMEOUT_MS)
  const started = Date.now()
  void (async () => {
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
    settle(outcome)
  })()
  return jobId
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

/** The focused workspace and its dbt project folder, without reading the manifest. */
async function locateProject(orca: OrcaWorkerApi): Promise<Location> {
  const context = await orca.host.call('workspace.readContext')
  if (!context?.workspaceId) {
    throw new ProjectError('no_workspace', 'Open a workspace to see its dbt lineage.')
  }
  const { workspaces } = await orca.host.call('workspace.list')
  const workspace = workspaces.find((row) => row.id === context.workspaceId)
  if (!workspace) {
    orca.log(`workspace ${context.workspaceId} is not in workspace.list`)
    throw new ProjectError('no_workspace', `Orca did not list the workspace "${context.displayName}".`)
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
async function branchChanges(orca: OrcaWorkerApi): Promise<BranchChanges> {
  const { projectDir, manifestPath, graph } = await loadProject(orca)
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

async function loadProject(orca: OrcaWorkerApi): Promise<Project> {
  const location = await locateProject(orca)
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
