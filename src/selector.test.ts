// The selector engine against real manifests of one project, written by dbt-core 1.12 (v1)
// and dbt Fusion 2.0 (v2). They store YAML selectors differently; both must select the same.
import { readFileSync } from 'node:fs'
import { assert, test } from 'orca/testing'
import { buildGraph, type Graph } from './graph'
import { select, SelectorError, yamlSelectors } from './selector'

const versions: [string, Graph][] = ['v1', 'v2'].map((version) => [
  version,
  buildGraph(JSON.parse(readFileSync(new URL(`../fixtures/versions/manifest-${version}.json`, import.meta.url), 'utf8')))
])

const names = (graph: Graph, expression: string) =>
  [...select(graph, expression)].map((id) => graph.nodes.get(id)!.name).sort()

for (const [version, graph] of versions) {
  test(`${version}: command-line selectors`, () => {
    assert.deepEqual(names(graph, 'orders'), ['orders'])
    assert.deepEqual(names(graph, '+orders'), ['orders', 'stg_customers', 'stg_orders'])
    assert.deepEqual(names(graph, 'stg_orders+'), ['orders', 'stg_orders'])
    assert.deepEqual(names(graph, '1+orders'), ['orders', 'stg_customers', 'stg_orders'])
    assert.deepEqual(names(graph, 'tag:mart'), ['orders'])
    assert.deepEqual(names(graph, 'config.materialized:table'), ['orders'])
    assert.deepEqual(names(graph, 'models/staging'), ['stg_customers', 'stg_orders'])
    assert.deepEqual(names(graph, 'path:models/marts/orders.sql'), ['orders'])
    assert.deepEqual(names(graph, 'stg_*'), ['stg_customers', 'stg_orders'])
    assert.deepEqual(names(graph, 'shop.staging.*'), ['stg_customers', 'stg_orders'])
    // Union with a space, intersection with a comma, and --exclude.
    assert.deepEqual(names(graph, 'tag:mart stg_orders'), ['orders', 'stg_orders'])
    assert.deepEqual(names(graph, '+orders,resource_type:model,stg_*'), ['stg_customers', 'stg_orders'])
    assert.deepEqual(names(graph, '+orders --exclude stg_customers'), ['orders', 'stg_orders'])
    // @: descendants plus all their ancestors.
    assert.deepEqual(names(graph, '@stg_orders'), ['orders', 'stg_customers', 'stg_orders'])
  })

  test(`${version}: YAML selectors from the manifest`, () => {
    assert.deepEqual(
      yamlSelectors(graph).map((selector) => selector.name),
      ['marts_only', 'orders_lineage']
    )
    assert.deepEqual(names(graph, 'selector:marts_only'), ['orders'])
    assert.deepEqual(names(graph, '--selector orders_lineage'), ['orders', 'stg_orders'])
  })

  test(`${version}: a YAML selector with a list of values`, () => {
    // As in a real selectors.yml: `method: package, value: [dbt_project_evaluator, elementary]`.
    const withList = { ...graph, selectors: { packages: { name: 'packages', definition: { method: 'package', value: ['shop', 'elementary'] } } } }
    assert.deepEqual(names(withList, 'selector:packages'), ['orders', 'stg_customers', 'stg_orders'])
  })

  test(`${version}: selectors dbt would reject`, () => {
    for (const expression of ['state:modified', 'nope:x', 'selector:missing', '+selector:marts_only']) {
      assert.throws(() => select(graph, expression), (error: unknown) => error instanceof SelectorError)
    }
  })
}
