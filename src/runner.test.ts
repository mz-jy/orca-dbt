// dbt's output as dbt-core 1.12 (v1) and dbt Fusion 2.0 (v2) print it.
import { readFileSync } from 'node:fs'
import { assert, test } from 'orca/testing'
import { parseDbtVersion, showRows } from './runner'

const showLog = (version: string) => ({
  code: 0,
  lines: readFileSync(new URL(`../fixtures/versions/show-${version}.jsonl`, import.meta.url), 'utf8').split('\n'),
  stderr: ''
})

test('reads dbt show rows from v1 and v2 JSON logs', () => {
  for (const version of ['v1', 'v2']) {
    assert.deepEqual(showRows(showLog(version)), {
      columns: ['order_id', 'customer_id', 'amount', 'name'],
      rows: [[1, 10, 5.5, 'Ada']],
      truncated: false
    })
  }
})

test('tells dbt-core from Fusion', () => {
  assert.deepEqual(parseDbtVersion('Core:\n  - installed: 1.12.6\n  - latest:    1.12.7'), {
    flavor: 'core',
    version: '1.12.6'
  })
  assert.deepEqual(parseDbtVersion('dbt-fusion 2.0.0-preview.120'), { flavor: 'fusion', version: '2.0.0-preview.120' })
})
