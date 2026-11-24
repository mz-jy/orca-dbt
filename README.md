# dbt for Orca

A data catalog and lineage viewer for the dbt project in your Orca workspace. It works with dbt
v1 (dbt-core) and v2 (dbt Fusion), and with any warehouse your dbt profile connects to:
Snowflake, ClickHouse, Postgres, DuckDB and the rest.

One page, **dbt**, with three parts that move together:

- **Lineage graph**: the focused node's upstream and downstream, horizontal or vertical. Set the
  depth, or draw exactly what a dbt selector selects. Click a node to see it below, double-click
  to centre the lineage on it, use `+n` to reveal hidden neighbours, drag to pan, scroll to zoom.
- **Catalog**: every model, source, seed, snapshot and exposure by folder, tag, schema, resource
  type, package or owner. Search names, column names and descriptions, or type a dbt selector
  (`+orders+ tag:finance,config.materialized:table --exclude path:models/legacy`) or pick one from
  your `selectors.yml`. Picking a node draws its lineage.
- **Model**: description (Markdown), tags, owner, meta, columns with their types and tests,
  neighbours, and **Data**: preview rows or run SQL (`{{ ref() }}` works) on the warehouse.

In a narrow sidebar the graph sits above a Catalog/Model sheet you can resize by dragging the
bar between them; widen the panel past 900 px and the three sit side by side. The page follows
the workspace you are in.

## Install

You need Orca 1.4.248 or newer. Nothing else: the plugin has no build step and no dependencies
to install.

In Orca's plugin directory: [dbt for Orca](https://orca.dev/plugins/mz-jy.dbt?catalog=community).
Or from a terminal (it installs as `mz-jy.dbt`):

```sh
orca plugin install mz-jy/orca-dbt

# or from a local clone
git clone https://github.com/mz-jy/orca-dbt.git
orca plugin install ./orca-dbt
```

Orca lists the access the plugin asks for and prints the same command with `--approve <code>`;
run that to install it. In Orca, open the **dbt** panel from the right sidebar.

What it asks for, and why:

| Access            | Used for                                                                 |
| ----------------- | ------------------------------------------------------------------------ |
| Runs a worker     | reading `target/manifest.json`, running your project's dbt for queries   |
| `workspace:read`  | finding the focused workspace and its folder                             |
| `workspace:write` | opening a model's file in an editor tab                                  |
| `settings:own`    | the two settings below                                                   |

## How it finds your project

- **Project**: the shallowest `dbt_project.yml` within three folders of the workspace root, or
  the folder in the **dbt project folder** setting.
- **Manifest**: `<target-path>/manifest.json` (and `catalog.json`, for warehouse column types,
  when `dbt docs generate` has written it). No manifest yet? The panel offers **Run dbt parse**.
- **Queries** run `dbt show` with your project's own dbt, so they use your profile, adapter and
  credentials. The plugin
  - uses the nearest `.venv/bin/dbt` (project folder up to the workspace root), else `dbt` on
    `PATH`, `~/.local/bin`, `/opt/homebrew/bin` or `/usr/local/bin`; set **dbt command** (such as
    `uv run dbt` or `dbtf`) to choose;
  - loads every `.env` from the workspace root down to the project, as `just` with
    `dotenv-load` does, so `env_var()` in `profiles.yml` resolves;
  - runs in the project folder, where dbt looks for `profiles.yml` before `~/.dbt`.

  Snowflake with `authenticator: externalbrowser` opens your browser to sign in the first time.

## dbt v1 and v2

Both are tested against manifests and `dbt show` output from dbt-core 1.12 and dbt Fusion 2.0
(`fixtures/versions`). What differs, and how the plugin handles it:

- YAML selectors: v1 stores the raw YAML under `definition`; v2 stores it flattened and
  normalized. Both are read.
- v2 writes every `dbt show --inline` query into the manifest as a model named `inline`; the
  catalog leaves those out.
- v2 writes warehouse column types into the manifest itself; v1 needs `catalog.json`.
- v2 can exit with an error from `dbt parse` and still write the manifest; the panel reloads
  either way and shows the error.

Not supported: workspaces on SSH or other Orca hosts (the plugin reads files on this
computer), and selector methods that need run artifacts (`state:`, `result:`,
`source_status:`) or select tests (`test_name:`, `test_type:`).

## Develop

```sh
npm install                # TypeScript and Node typings, for type-checking only
npm run typecheck
orca plugin test .         # src/*.test.ts
orca plugin dev watch .    # loads this folder into Orca, streams logs, reloads on save
```

| File                         | What it is                                                         |
| ---------------------------- | ------------------------------------------------------------------ |
| `src/worker.ts`              | the worker: finds the project, caches the graph, runs dbt jobs     |
| `src/graph.ts`               | manifest and catalog.json into a graph and catalog (pure)          |
| `src/selector.ts`            | dbt's selector syntax and YAML selectors (pure)                    |
| `src/runner.ts`              | finding and running the project's dbt, reading its JSON logs       |
| `src/protocol.ts`            | the requests and events between the page and the worker            |
| `ui/index.html`, `ui/app.ts` | the page: layout, state, and what each click does                  |
| `ui/graph-view.ts`           | the lineage graph: dagre's layout drawn as SVG, pan, zoom          |
| `ui/catalog-view.ts`         | the catalog tree and result lists                                  |
| `ui/model-view.ts`           | a node's docs, columns, neighbours and data                         |
| `vendor/`                    | `@dagrejs/dagre` 3.1.3 and `marked` 18.3 (MIT), vendored: plugin frames have no network |
