// Source freshness from the manifest's rules and target/sources.json, as dbt-core and Fusion write them.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { freshnessArgs, readFreshness } from './freshness'
import { buildGraph } from './graph'

const rule = { warn_after: { count: 12, period: 'hour' }, error_after: { count: 2, period: 'day' } }
const unset = { warn_after: { count: null, period: null }, error_after: { count: null, period: null } }
const source = (name: string, extra: Record<string, unknown>) => ({ resource_type: 'source', source_name: 'raw', name, package_name: 'shop', ...extra })
const graph = buildGraph({
  metadata: { project_name: 'shop' },
  sources: {
    // dbt v1 before 1.10 and v2 keep the rule on the source; newer v1 under config. v2 writes unset windows as nulls.
    'source.shop.raw.orders': source('orders', { freshness: rule, loaded_at_field: 'ordered_at' }),
    'source.shop.raw.payments': source('payments', { config: { freshness: { warn_after: { count: 1, period: 'day' } }, loaded_at_field: 'paid_at' } }),
    'source.shop.raw.customers': source('customers', { freshness: { warn_after: { count: 6, period: 'hour' }, error_after: null } }),
    'source.shop.raw.stores': source('stores', { freshness: rule }),
    'source.shop.raw.countries': source('countries', { freshness: unset, loaded_at_field: '' })
  }
})

function withTarget(sources: unknown, run: (targetDir: string) => void): void {
  const targetDir = mkdtempSync(join(tmpdir(), 'orca-dbt-freshness-'))
  try {
    if (sources !== null) writeFileSync(join(targetDir, 'sources.json'), JSON.stringify(sources))
    run(targetDir)
  } finally {
    rmSync(targetDir, { recursive: true, force: true })
  }
}

test('lists the sources with a freshness rule, not checked until dbt source freshness ran', () => {
  withTarget(null, (targetDir) => {
    const report = readFreshness(graph, targetDir)
    assert.deepEqual(report.counts, { error: 0, fail: 0, warn: 0, pass: 0, never: 4 })
    assert.deepEqual([report.checkedAt, report.checked], [null, 0])
    assert.deepEqual(
      report.sources.map((entry) => [entry.node.name, entry.status, entry.warnAfter, entry.errorAfter, entry.loadedAtField]),
      [
        ['raw.customers', null, { count: 6, period: 'hour' }, null, null],
        ['raw.orders', null, { count: 12, period: 'hour' }, { count: 2, period: 'day' }, 'ordered_at'],
        ['raw.payments', null, { count: 1, period: 'day' }, null, 'paid_at'],
        ['raw.stores', null, { count: 12, period: 'hour' }, { count: 2, period: 'day' }, null]
      ]
    )
  })
})

test('reads each source’s latest check, worst first, from dbt-core and Fusion', () => {
  const results = [
    // dbt-core: lower case; a check that could not run carries its error and no times.
    { unique_id: 'source.shop.raw.payments', status: 'pass', max_loaded_at: '2026-11-28T09:00:00Z', snapshotted_at: '2026-11-28T10:00:00Z', criteria: { warn_after: { count: 1, period: 'day' }, error_after: { count: null, period: null } } },
    { unique_id: 'source.shop.raw.customers', status: 'warn', max_loaded_at: '2026-11-28T01:00:00Z', snapshotted_at: '2026-11-28T10:00:00Z' },
    { unique_id: 'source.shop.raw.stores', status: 'runtime error', error: 'Database Error: no column loaded_at' },
    // Fusion: capitalized.
    { unique_id: 'source.shop.raw.orders', status: 'Error', max_loaded_at: '2026-03-31T18:31:00Z', snapshotted_at: '2026-11-28T10:00:00.5Z', criteria: rule },
    { unique_id: 'source.shop.raw.gone', status: 'pass' }
  ]
  withTarget({ metadata: { generated_at: '2026-11-28T10:00:01Z' }, results }, (targetDir) => {
    const report = readFreshness(graph, targetDir)
    assert.deepEqual(report.counts, { error: 1, fail: 1, warn: 1, pass: 1, never: 0 })
    assert.deepEqual([report.checkedAt, report.checked], ['2026-11-28T10:00:01Z', 5])
    assert.deepEqual(
      report.sources.map((entry) => [entry.node.name, entry.status, entry.maxLoadedAt, entry.checkedAt, entry.message]),
      [
        ['raw.stores', 'error', null, '2026-11-28T10:00:01Z', 'Database Error: no column loaded_at'],
        ['raw.orders', 'fail', '2026-03-31T18:31:00Z', '2026-11-28T10:00:00.5Z', null],
        ['raw.customers', 'warn', '2026-11-28T01:00:00Z', '2026-11-28T10:00:00Z', null],
        ['raw.payments', 'pass', '2026-11-28T09:00:00Z', '2026-11-28T10:00:00Z', null]
      ]
    )
  })
})

test('checks one source or all of them', () => {
  assert.deepEqual(freshnessArgs(graph), { args: ['source', 'freshness'], label: 'source freshness' })
  assert.deepEqual(freshnessArgs(graph, 'source.shop.raw.orders'), {
    args: ['source', 'freshness', '--select', 'source:raw.orders'],
    label: 'freshness of raw.orders'
  })
  assert.equal(freshnessArgs(graph, 'model.shop.orders'), null)
})
