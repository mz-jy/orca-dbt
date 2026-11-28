// The panels <-> worker contract, declared once: the panels and src/worker.ts all read it.

/** A node as lists and trees show it; `parents`/`children` count its direct neighbors. */
export type NodeSummary = {
  id: string
  name: string
  /** dbt's resource_type: model, source, seed, snapshot, exposure, metric, ... */
  type: string
  parents: number
  children: number
}

export type ColumnInfo = {
  name: string
  /** The declared data_type, else the warehouse type from target/catalog.json. */
  type: string | null
  description: string
  /** Tests on this column, by test name (not_null, unique, accepted_values, ...). */
  tests: string[]
}

export type NodeDetail = NodeSummary & {
  packageName: string
  /** original_file_path, relative to the dbt project (or its package). */
  file: string | null
  materialized: string | null
  /** database.schema.identifier, for nodes that are relations. */
  relation: string | null
  description: string
  tags: string[]
  /** meta.owner, else the node's group. */
  owner: string | null
  /** The node's meta (config.meta merged in), values as text. */
  meta: { key: string; value: string }[]
  columns: ColumnInfo[]
  /** From target/catalog.json, when `dbt docs generate` has written one. */
  rowCount: number | null
}

/** How the catalog explorer groups nodes: not at all (one A–Z list), by a property, or by a meta key. */
export type GroupBy = 'none' | 'folder' | 'tag' | 'schema' | 'type' | 'package' | 'owner' | `meta:${string}`

/** One level of the explorer: sub-groups first, then the nodes that sit directly in it. */
export type CatalogLevel = {
  groups: { key: string; label: string; count: number }[]
  nodes: NodeSummary[]
  /** Nodes left out past the per-level cap. */
  more: number
  /** At the top level: every meta key in the project, to group by. */
  metaKeys?: string[]
}

export type QueryCell = string | number | boolean | null

export type QueryResult =
  | { jobId: string; ok: true; columns: string[]; rows: QueryCell[][]; truncated: boolean; ms: number }
  | { jobId: string; ok: false; error: string; ms: number }

export type NodeFocus = { node: NodeDetail; parents: NodeSummary[]; children: NodeSummary[] }

export type ProjectProblem = 'no_workspace' | 'remote' | 'no_project' | 'no_manifest' | 'unreadable'

export type ProjectStatus =
  | {
      ok: true
      projectName: string
      /** The workspace the project is read from, as Orca's sidebar names it. */
      workspaceName: string
      /** The dbt project folder, relative to the workspace root ('' when it is the root). */
      projectDir: string
      generatedAt: string | null
      dbtVersion: string | null
      nodeCount: number
    }
  | { ok: false; reason: ProjectProblem; message: string }

export type Direction = 'up' | 'down'

export type GraphNodeView = NodeSummary & {
  materialized: string | null
  relation: string | null
  file: string | null
  /** Direct parents and children the graph leaves out. */
  hiddenParents: number
  hiddenChildren: number
  /** What the graph can group nodes by: the file's folder, tags, database.schema, owner, package, meta. */
  folder: string
  tags: string[]
  schema: string | null
  owner: string | null
  packageName: string
  meta: Record<string, string>
}

export type LineageGraph = {
  /** The node the graph is drawn around; null for a selector's graph. */
  focus: string | null
  nodes: GraphNodeView[]
  /** [parent, child] pairs between drawn nodes. */
  edges: [string, string][]
  /** The node limit cut the walk (or the selection) short. */
  truncated: boolean
}

/** What a dbt selector chose: every match counted, the first ones listed. */
export type Selection = { count: number; nodes: NodeSummary[]; error?: string }

/** The dbt a query or parse runs: v1 is dbt-core, v2 is dbt Fusion. */
export type DbtEngine = { command: string; version: string | null; flavor: 'core' | 'fusion' | 'unknown' }

/**
 * How the branch changed a node: its own file is new (`added`) or edited (`modified`), the YAML
 * that documents or configures it changed (`yaml`), or a macro it calls changed (`macro`).
 */
export type ChangeKind = 'added' | 'modified' | 'yaml' | 'macro'

export type ChangedNode = NodeSummary & { change: ChangeKind; files: string[] }

/** What the branch changed since it left its base, and what that reaches downstream. */
export type BranchChanges =
  | {
      ok: true
      /** The current branch, the base it is compared with, and their merge base (short sha). */
      head: string
      base: string
      mergeBase: string
      changed: ChangedNode[]
      /** Downstream of the changed nodes, not changed themselves. */
      impacted: NodeSummary[]
      /** Deleted model, seed or snapshot files. */
      removed: string[]
      /** Changed files in the project that map to no node (dbt_project.yml, packages.yml, …). */
      unmapped: string[]
      /** A changed file is newer than the manifest: `dbt parse` would show more. */
      manifestStale: boolean
      /** `dbt build --select …` for the changed nodes and everything downstream. */
      command: string | null
    }
  | { ok: false; message: string }

/** The environment queries run with: where it comes from, what it sets, what the profile needs. */
export type EnvState = {
  /** The "Env file" setting, workspace-relative; '' reads every .env from the root down. */
  configured: string
  /** The files read, in load order (a later one wins); paths are workspace-relative. */
  files: string[]
  /** Where Save writes. */
  target: string
  /** .env-like files between the workspace root and the project, to choose from. */
  candidates: string[]
  vars: { key: string; value: string; file: string }[]
  /** The dbt profile the project uses and the profiles.yml it is read from. */
  profile: string
  profilesFile: string | null
  /** Variables the profile and dbt_project.yml read with env_var(), and who sets them. */
  required: { key: string; hasDefault: boolean; setBy: 'file' | 'orca' | null }[]
}

/** How a test last ran, worst first: error > fail > warn > skipped > pass. */
export type TestStatus = 'error' | 'fail' | 'warn' | 'skipped' | 'pass'

/** A data test or unit test with its latest result (status null: never ran). */
export type TestResult = {
  id: string
  name: string
  /** not_null, accepted_values, …; a singular or unit test's own name. */
  label: string
  kind: 'data' | 'unit'
  column: string | null
  /** The node it tests. */
  node: NodeSummary | null
  status: TestStatus | null
  /** Rows the test found (a failing test's failures), when dbt reports them. */
  failures: number | null
  message: string | null
  ms: number | null
  /** When the run that produced the result finished (ISO). */
  at: string | null
  /** Whether "failing rows" can query what the test found. */
  rows: boolean
}

/**
 * A node's tests summed up for the flags in the graph, the catalog and the model sheet; for a
 * source with a freshness check, `freshness` is its outcome, and counts in `status`.
 */
export type QualityFlag = { status: TestStatus; problems: number; tests: number; freshness?: FreshnessStatus }

/** A source's latest freshness check: fresh (`pass`), past warn_after (`warn`), past error_after (`fail`: stale), or the check itself failed (`error`). */
export type FreshnessStatus = 'error' | 'fail' | 'warn' | 'pass'

/** A warn_after or error_after: `count` periods (minute, hour, day). */
export type FreshnessWindow = { count: number; period: string }

/** A source with a freshness rule and its latest check (status null: never checked). */
export type SourceFreshness = {
  node: NodeSummary
  warnAfter: FreshnessWindow | null
  errorAfter: FreshnessWindow | null
  /** The column or expression that says when a row was loaded; null when the warehouse's own metadata does. */
  loadedAtField: string | null
  status: FreshnessStatus | null
  /** When the source last received data, and when the check looked (ISO). */
  maxLoadedAt: string | null
  checkedAt: string | null
  /** Why the check failed. */
  message: string | null
}

export type FreshnessReport = {
  /** Sources with a rule by latest status; `never` for those not checked yet. */
  counts: Record<FreshnessStatus | 'never', number>
  /** When `dbt source freshness` last ran. */
  checkedAt: string | null
  /** The sources asked for, worst first. */
  sources: SourceFreshness[]
}

/** A test run in progress. */
export type QualityRun = { jobId: string; label: string; startedAt: number }

/** How a test run or freshness check ended: `ran` tests or sources have new results, or `error` says why there are none. */
export type QualityDone = { jobId: string; ok: boolean; ran: number; error?: string }

export type QualityReport = {
  /** Tests by latest status; `never` for those without a result. */
  counts: Record<TestStatus | 'never', number>
  lastRun: string | null
  /** By node id: the worst status of its tests that ran. */
  flags: Record<string, QualityFlag>
  /** The tests asked for, worst first; `more` past the limit. */
  tests: TestResult[]
  more: number
  /** Source freshness: the stale, warned and failed sources, every one with `all`, or the node's own with `nodeId`. */
  freshness: FreshnessReport
  /** The test run or freshness check in progress. */
  running: QualityRun | null
}

declare module 'orca' {
  interface PluginRequests {
    /** Finds the focused workspace's dbt project and reads its manifest. */
    'lineage.status': { output: ProjectStatus }
    /** Nodes whose name or id contains `query`, best match first. */
    'lineage.search': { input: { query: string; limit?: number }; output: NodeSummary[] }
    /** A node with its direct parents and children; null when the manifest no longer has it. */
    'lineage.node': { input: { id: string }; output: NodeFocus | null }
    /** A node's direct parents (`up`) or children (`down`). */
    'lineage.neighbors': { input: { id: string; direction: Direction }; output: NodeSummary[] }
    /**
     * The graph around `id`: `up` levels of ancestors, `down` levels of descendants, plus the
     * direct neighbors of each `expand` entry. Null when the manifest no longer has the node.
     */
    'lineage.graph': {
      input: { id: string; up: number; down: number; expand?: { id: string; direction: Direction }[] }
      output: LineageGraph | null
    }
    /** Opens the node's file in an editor tab. */
    'lineage.open': { input: { id: string }; output: { opened: boolean; message?: string } }
    /** One level of the catalog explorer; `path` '' is the top, else a group key it returned. */
    'catalog.level': { input: { by: GroupBy; path: string }; output: CatalogLevel }
    /** Evaluates a dbt selector (`+orders tag:finance --exclude …`, `selector:nightly`). */
    'catalog.select': { input: { selector: string; limit?: number }; output: Selection }
    /** The YAML selectors the project's selectors.yml defines. */
    'catalog.selectors': { output: { name: string; description: string }[] }
    /** The graph of the nodes a dbt selector chooses, plus `expand`; null with `error` if invalid. */
    'lineage.selectGraph': {
      input: { selector: string; expand?: { id: string; direction: Direction }[] }
      output: { graph: LineageGraph | null; count: number; error?: string }
    }
    /**
     * Runs `sql` (Jinja allowed: `{{ ref('x') }}`), or a preview of node `id`, through the
     * project's own dbt (`dbt show`), so it uses the profile's warehouse and credentials. Answers
     * at once with the job id; the result arrives as `query.done`.
     */
    'query.start': {
      input: { id?: string; sql?: string; testId?: string; limit: number }
      output: { jobId: string; sql: string }
    }
    /** Stops a running query or parse job. */
    'query.cancel': { input: { jobId: string }; output: { cancelled: boolean } }
    /** Runs `dbt parse` to write target/manifest.json; the result arrives as `parse.done`. */
    'project.parse': { output: { jobId: string } }
    /** Sets the dbt project folder (workspace-relative or absolute); '' finds it automatically. */
    'project.choose': { input: { folder: string }; output: ProjectStatus }
    /** Which dbt queries run with, and whether it is dbt-core (v1) or Fusion (v2). */
    'query.engine': { output: DbtEngine }
    /** The branch's changes against its base (committed, uncommitted and untracked). */
    'lineage.changes': { output: BranchChanges }
    /** The changed nodes and everything downstream of them, plus `expand`. */
    'lineage.changesGraph': {
      input: { expand?: { id: string; direction: Direction }[] }
      output: { graph: LineageGraph | null; error?: string }
    }
    /** The query environment. */
    'env.read': { output: EnvState }
    /** Sets a variable in the env file Save writes (creating the file if needed). */
    'env.set': { input: { key: string; value: string }; output: EnvState }
    /** Removes a variable from the env files it is read from. */
    'env.delete': { input: { key: string }; output: EnvState }
    /** Reads variables from `file` (workspace-relative or absolute), or every .env with ''. */
    'env.choose': { input: { file: string }; output: EnvState }
    /**
     * Test results: the problems (failing, erroring, warning), every test with `all`, or one
     * node's tests with `nodeId`, and source freshness the same way. Reads target/run_results.json
     * and target/sources.json first, so runs from a terminal count.
     */
    'quality.read': { input: { all?: boolean; nodeId?: string }; output: QualityReport }
    /**
     * Runs `dbt test`: on a node, a dbt selector, the tests `testIds`, or every test. Answers at
     * once; `quality.done` follows. One run at a time per project.
     */
    'quality.run': { input: { nodeId?: string; selector?: string; testIds?: string[] }; output: QualityRun }
    /**
     * Runs `dbt source freshness`: on source `nodeId`, or on every source with a freshness rule.
     * Answers at once; `quality.done` follows. It takes turns with test runs.
     */
    'quality.freshness': { input: { nodeId?: string }; output: QualityRun }
  }
  interface PluginPanelEvents {
    'query.done': QueryResult
    /** A file of the project was saved in an editor tab: focus the node it holds. */
    'lineage.reveal': { id: string }
    'parse.done': { jobId: string; ok: boolean; error?: string }
    /** A test run or a freshness check ended, started from a panel or by an agent over MCP. */
    'quality.done': QualityDone
  }
}
