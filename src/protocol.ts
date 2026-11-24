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
  /** Tests on the node itself rather than one column. */
  tests: string[]
  /** From target/catalog.json, when `dbt docs generate` has written one. */
  rowCount: number | null
}

/** How the catalog explorer groups nodes. */
export type GroupBy = 'folder' | 'tag' | 'schema' | 'type' | 'package' | 'owner'

/** One level of the explorer: sub-groups first, then the nodes that sit directly in it. */
export type CatalogLevel = {
  groups: { key: string; label: string; count: number }[]
  nodes: NodeSummary[]
  /** Nodes left out past the per-level cap. */
  more: number
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
    'query.start': { input: { id?: string; sql?: string; limit: number }; output: { jobId: string; sql: string } }
    /** Stops a running query or parse job. */
    'query.cancel': { input: { jobId: string }; output: { cancelled: boolean } }
    /** Runs `dbt parse` to write target/manifest.json; the result arrives as `parse.done`. */
    'project.parse': { output: { jobId: string } }
    /** Which dbt queries run with, and whether it is dbt-core (v1) or Fusion (v2). */
    'query.engine': { output: DbtEngine }
    /** The branch's changes against its base (committed, uncommitted and untracked). */
    'lineage.changes': { output: BranchChanges }
    /** The changed nodes and everything downstream of them, plus `expand`. */
    'lineage.changesGraph': {
      input: { expand?: { id: string; direction: Direction }[] }
      output: { graph: LineageGraph | null; error?: string }
    }
  }
  interface PluginPanelEvents {
    'query.done': QueryResult
    'parse.done': { jobId: string; ok: boolean; error?: string }
  }
}
