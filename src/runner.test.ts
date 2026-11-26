// dbt's output as dbt-core 1.12 (v1) and dbt Fusion 2.0 (v2) print it.
import { readFileSync } from 'node:fs'
import { assert, test } from 'orca/testing'
import { parseDbtVersion, showRows, v2ParserFailed } from './runner'

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

test("notices that dbt-core's v2 parser failed", () => {
  // As dbt-core 1.12.6 logs it when dbt-core-experimental-parser exits with an error.
  const failed =
    '{"data": {"error_class": "V2ParserError", "execution_time": 12.898031, "exit_code": 1, "project_name": "dbt_dpf", "status": "failure"}, "info": {"category": "", "code": "Q051", "extra": {}, "level": "error", "msg": "v2 parser failed after 12.90s (V2ParserError, exit_code=1)", "name": "V2ParserEnd"}}'
  assert.equal(v2ParserFailed({ code: 2, lines: [failed], stderr: '' }), true)
  assert.equal(v2ParserFailed(showLog('v1')), false)
})
