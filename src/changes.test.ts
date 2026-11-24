// Mapping a branch's changed files onto the manifests dbt-core 1.12 (v1) and dbt Fusion 2.0 (v2)
// wrote for one project. They record a model's YAML differently (`shop://models/…` in v1).
import { readFileSync } from 'node:fs'
import { assert, test } from 'orca/testing'
import { buildCommand, mapChanges } from './changes'
import { buildGraph } from './graph'

for (const version of ['v1', 'v2']) {
  const load = () =>
    buildGraph(JSON.parse(readFileSync(new URL(`../fixtures/versions/manifest-${version}.json`, import.meta.url), 'utf8')))

  test(`${version}: edited SQL, edited YAML, new and deleted files`, () => {
    const graph = load()
    const mapped = mapChanges(graph, [
      { path: 'models/staging/stg_orders.sql', status: 'M' },
      { path: 'models/marts/schema.yml', status: 'M' },
      { path: 'models/staging/stg_legacy.sql', status: 'D' },
      { path: 'dbt_project.yml', status: 'M' }
    ])
    assert.deepEqual(
      mapped.changed.map((node) => [node.name, node.change, node.files]),
      [
        ['stg_orders', 'modified', ['models/staging/stg_orders.sql']],
        ['orders', 'yaml', ['models/marts/schema.yml']]
      ]
    )
    // orders is changed itself, so it is not counted as downstream of stg_orders.
    assert.deepEqual(mapped.impacted, [])
    assert.deepEqual(mapped.removed, ['models/staging/stg_legacy.sql'])
    assert.deepEqual(mapped.unmapped, ['dbt_project.yml'])
    // orders is downstream of stg_orders, so `stg_orders+` already builds it.
    assert.equal(buildCommand(graph, mapped.changed), 'dbt build --select stg_orders+')
  })

  test(`${version}: a new model, and a macro reached through another macro`, () => {
    const graph = load()
    graph.macros.set('macro.shop.cents', { file: 'macros/cents.sql', packageName: 'shop', uses: [] })
    graph.macros.set('macro.shop.money', { file: 'macros/money.sql', packageName: 'shop', uses: ['macro.shop.cents'] })
    graph.nodes.get('model.shop.stg_customers')!.macros.push('macro.shop.money')
    const mapped = mapChanges(graph, [
      { path: 'models/staging/stg_orders.sql', status: 'U' },
      { path: 'macros/cents.sql', status: 'M' }
    ])
    assert.deepEqual(
      mapped.changed.map((node) => [node.name, node.change, node.files]),
      [
        ['stg_orders', 'added', ['models/staging/stg_orders.sql']],
        ['stg_customers', 'macro', ['macros/money.sql']]
      ]
    )
    assert.deepEqual(
      mapped.impacted.map((node) => node.name),
      ['orders']
    )
    assert.equal(buildCommand(graph, mapped.changed), 'dbt build --select stg_orders+ stg_customers+')
  })
}
