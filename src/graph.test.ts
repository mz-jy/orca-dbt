// Catalog details from manifests dbt-core 1.12 (v1) and dbt Fusion 2.0 (v2) wrote for one project.
import { readFileSync } from 'node:fs'
import { assert, test } from 'orca/testing'
import { buildGraph, catalogLevel, focus, NO_GROUP } from './graph'

for (const version of ['v1', 'v2']) {
  const graph = buildGraph(
    JSON.parse(readFileSync(new URL(`../fixtures/versions/manifest-${version}.json`, import.meta.url), 'utf8')),
    // catalog.json: the warehouse's column types (upper-case, as Snowflake reports them).
    { nodes: { 'model.shop.orders': { columns: { ORDER_ID: { name: 'ORDER_ID', type: 'NUMBER', index: 1 }, NAME: { name: 'NAME', type: 'TEXT', index: 4 } }, stats: { row_count: { value: 42 } } } } }
  )

  test(`${version}: a model's docs, owner, columns and tests`, () => {
    const { node } = focus(graph, 'model.shop.orders')!
    assert.equal(node.description, 'Orders with **customers**.')
    assert.deepEqual(node.tags, ['mart'])
    // v1 reads top-level meta; v2 only config.meta. Either way the owner is found.
    assert.equal(node.owner, 'data-team')
    assert.equal(node.rowCount, 42)
    const columns = node.columns.map((column) => ({ ...column, tests: [...column.tests].sort() }))
    if (version === 'v1') {
      // v1's manifest has only the documented column; catalog.json adds types and the rest.
      assert.deepEqual(columns, [
        { name: 'order_id', type: 'NUMBER', description: 'Primary key', tests: ['not_null', 'unique'] },
        { name: 'NAME', type: 'TEXT', description: '', tests: [] }
      ])
    } else {
      // v2 reads the warehouse schema itself and writes every column's type to the manifest,
      // which catalog.json does not override.
      assert.deepEqual(columns, [
        { name: 'order_id', type: 'integer', description: 'Primary key', tests: ['not_null', 'unique'] },
        { name: 'customer_id', type: 'integer', description: '', tests: [] },
        { name: 'amount', type: 'decimal(2, 1)', description: '', tests: [] },
        { name: 'name', type: 'character varying(256)', description: '', tests: [] }
      ])
    }
  })

  test(`${version}: catalog levels by folder and tag`, () => {
    assert.deepEqual(catalogLevel(graph, 'folder', '', 100).groups, [{ key: 'models', label: 'models', count: 3 }])
    const models = catalogLevel(graph, 'folder', 'models', 100)
    assert.deepEqual(
      models.groups.map((group) => [group.label, group.count]),
      [
        ['marts', 1],
        ['staging', 2]
      ]
    )
    assert.deepEqual(
      catalogLevel(graph, 'tag', '', 100).groups.map((group) => [group.key, group.count]),
      [
        ['mart', 1],
        [NO_GROUP, 2]
      ]
    )
    assert.deepEqual(
      catalogLevel(graph, 'folder', 'models/staging', 1),
      { groups: [], nodes: [catalogLevel(graph, 'folder', 'models/staging', 1).nodes[0]], more: 1 }
    )
  })
}
