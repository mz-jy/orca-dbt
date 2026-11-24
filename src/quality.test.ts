// Test results as dbt-core (v1) and Fusion (v2) write them to target/run_results.json.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { buildGraph, type RawManifest } from './graph'
import { testArgs, TestResults } from './quality'

const manifest: RawManifest = {
  metadata: { project_name: 'shop' },
  nodes: {
    'model.shop.orders': { name: 'orders', resource_type: 'model', package_name: 'shop', original_file_path: 'models/orders.sql' },
    'model.shop.customers': { name: 'customers', resource_type: 'model', package_name: 'shop', original_file_path: 'models/customers.sql' },
    'test.shop.not_null_orders_id.1': {
      name: 'not_null_orders_id',
      resource_type: 'test',
      package_name: 'shop',
      original_file_path: 'models/schema.yml',
      path: 'not_null_orders_id.sql',
      attached_node: 'model.shop.orders',
      column_name: 'id',
      test_metadata: { name: 'not_null' }
    },
    'test.shop.unique_orders_id.2': {
      name: 'unique_orders_id',
      resource_type: 'test',
      package_name: 'shop',
      original_file_path: 'models/schema.yml',
      attached_node: 'model.shop.orders',
      column_name: 'id',
      test_metadata: { name: 'unique' }
    },
    // Fusion records where it writes a test's compiled SQL.
    'test.shop.assert_customers_named.3': {
      name: 'assert_customers_named',
      resource_type: 'test',
      package_name: 'shop',
      original_file_path: 'tests/assert_customers_named.sql',
      compiled_path: 'target/compiled/tests/assert_customers_named.sql',
      depends_on: { nodes: ['model.shop.customers'] }
    }
  },
  unit_tests: {
    'unit_test.shop.orders.totals': { name: 'totals', package_name: 'shop', depends_on: { nodes: ['model.shop.orders'] } }
  }
}

function runResults(at: string, results: object[]): string {
  return JSON.stringify({ metadata: { generated_at: at, invocation_id: at }, results })
}

test('keeps every test’s latest result across runs, from dbt-core and Fusion', () => {
  const project = mkdtempSync(join(tmpdir(), 'orca-dbt-quality-'))
  const target = join(project, 'target')
  try {
    mkdirSync(join(target, 'compiled', 'tests'), { recursive: true })
    const graph = buildGraph(manifest)

    // dbt-core runs everything: its results carry the compiled SQL.
    writeFileSync(
      join(target, 'run_results.json'),
      runResults('2026-01-05T10:00:00Z', [
        { unique_id: 'model.shop.orders', status: 'success' },
        { unique_id: 'test.shop.not_null_orders_id.1', status: 'fail', failures: 3, message: 'Got 3 results', execution_time: 0.25, compiled_code: 'select * from orders where id is null' },
        { unique_id: 'test.shop.unique_orders_id.2', status: 'pass', failures: 0 },
        { unique_id: 'test.shop.assert_customers_named.3', status: 'pass', failures: 0 },
        { unique_id: 'unit_test.shop.orders.totals', status: 'error', message: 'actual differs from expected' }
      ])
    )
    const results = new TestResults(project, target)
    results.sync(graph)
    assert.deepEqual(results.last, { at: '2026-01-05T10:00:00Z', tests: 4 })

    // A later Fusion run of one test: no compiled_code, a message of null, the SQL on disk.
    writeFileSync(join(target, 'compiled', 'tests', 'assert_customers_named.sql'), 'select * from customers where name is null')
    writeFileSync(
      join(target, 'run_results.json'),
      runResults('2026-01-06T10:00:00Z', [{ unique_id: 'test.shop.assert_customers_named.3', status: 'warn', failures: 1, message: null }])
    )
    results.sync(graph)

    // A new worker reads what the runs found.
    const reread = new TestResults(project, target)
    const report = reread.report(graph, {}, 100)
    assert.deepEqual(report.counts, { error: 1, fail: 1, warn: 1, skipped: 0, pass: 1, never: 0 })
    assert.equal(report.lastRun, '2026-01-06T10:00:00Z')
    assert.deepEqual(report.flags, {
      'model.shop.orders': { status: 'error', problems: 2, tests: 3 },
      'model.shop.customers': { status: 'warn', problems: 1, tests: 1 }
    })
    // Problems only, worst first.
    assert.deepEqual(
      report.tests.map((result) => [result.status, result.label, result.column, result.failures, result.rows]),
      [
        ['error', 'totals', null, null, false],
        ['fail', 'not_null', 'id', 3, true],
        ['warn', 'assert_customers_named', null, 1, true]
      ]
    )
    assert.equal(reread.failingRowsSql(graph, 'test.shop.not_null_orders_id.1'), 'select * from orders where id is null')
    assert.equal(reread.failingRowsSql(graph, 'test.shop.assert_customers_named.3'), 'select * from customers where name is null')
    assert.deepEqual(
      reread.report(graph, { nodeId: 'model.shop.orders' }, 100).tests.map((result) => `${result.status}:${result.label}`),
      ['error:totals', 'fail:not_null', 'pass:unique']
    )
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('runs tests on a node, named tests, a selector, or all', () => {
  const graph = buildGraph({
    ...manifest,
    sources: { 'source.shop.raw.payments': { name: 'payments', source_name: 'raw', resource_type: 'source', package_name: 'shop' } }
  })
  assert.deepEqual(testArgs(graph, {}), { args: ['test'], label: 'every test' })
  assert.deepEqual(testArgs(graph, { nodeId: 'source.shop.raw.payments' })?.args, ['test', '--select', 'source:raw.payments'])
  assert.deepEqual(testArgs(graph, { testIds: ['test.shop.not_null_orders_id.1', 'unit_test.shop.orders.totals'] })?.args, [
    'test',
    '--select',
    'not_null_orders_id',
    'totals'
  ])
  assert.deepEqual(testArgs(graph, { selector: '+orders tag:finance --exclude path:legacy' })?.args, [
    'test',
    '--select',
    '+orders',
    'tag:finance',
    '--exclude',
    'path:legacy'
  ])
  assert.deepEqual(testArgs(graph, { selector: 'selector:nightly' })?.args, ['test', '--selector', 'nightly'])
  assert.equal(testArgs(graph, { nodeId: 'model.shop.gone' }), null)
})
