// Runs src/worker.ts's activate(orca) over a mock host, against the fixture dbt project.
import { fileURLToPath } from 'node:url'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

const root = fileURLToPath(new URL('../fixtures/workspace', import.meta.url))
const workspaceId = `repo-1::${root}`
const context = { workspaceId, branch: 'main', displayName: 'main', terminals: [] }
const listed = {
  workspaces: [
    { id: workspaceId, kind: 'worktree', name: 'main', project: 'shop', path: root, branch: 'main', hostId: 'local' }
  ],
  truncated: false
}

const fakeDbt = `sh ${fileURLToPath(new URL('../fixtures/fake-dbt.sh', import.meta.url))}`

/**
 * Waits for the worker to post `event`: a real dbt subprocess answers, so fake timers cannot
 * drive it, and the test kit records posts without an event to await. Polls, returning at once.
 */
async function posted(worker: { posts: readonly { event: string; payload?: unknown }[] }, event: string) {
  for (let waited = 0; waited < 5000; waited += 10) {
    const post = worker.posts.find((candidate) => candidate.event === event)
    if (post) return post.payload as Record<string, unknown>
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`no ${event} post`)
}

function fixtureHost(
  options: { settings?: { projectDir: string; dbtCommand?: string }; context?: typeof context | null } = {}
) {
  return mockHost({
    settings: options.settings ?? { projectDir: '' },
    results: {
      'workspace.readContext': options.context === undefined ? context : options.context,
      'workspace.list': listed,
      'editor.open': { opened: true }
    }
  })
}

test('finds the nested project and answers lineage without tests', async () => {
  const host = fixtureHost()
  const worker = await mountWorker(main, { host })

  assert.deepEqual(await worker.request('lineage.status'), {
    ok: true,
    projectName: 'shop',
    workspaceName: 'shop · main',
    projectDir: 'analytics',
    generatedAt: '2026-11-20T10:00:00.000000Z',
    dbtVersion: '1.10.0',
    nodeCount: 8
  })

  const orders = await worker.request('lineage.node', { id: 'model.shop.orders' })
  assert.equal(orders?.node.relation, 'ANALYTICS.marts.orders')
  assert.deepEqual(
    orders?.parents.map((n) => n.id),
    ['model.shop.stg_orders']
  )
  // The not_null test reads orders too, but tests are not lineage.
  assert.deepEqual(
    orders?.children.map((n) => n.id),
    ['model.shop.customers', 'exposure.shop.weekly_dashboard']
  )

  const upstream = await worker.request('lineage.neighbors', { id: 'model.shop.stg_customers', direction: 'up' })
  assert.deepEqual(
    upstream.map((n) => n.name),
    ['raw.customers', 'country_codes']
  )

  const found = await worker.request('lineage.search', { query: 'orders' })
  assert.deepEqual(
    found.map((n) => n.id),
    ['model.shop.orders', 'model.shop.stg_orders', 'source.shop.raw.orders']
  )

  assert.deepEqual(await worker.request('lineage.open', { id: 'model.shop.orders' }), { opened: true })
  assert.deepEqual(host.callsOf('editor.open'), [{ workspaceId, path: 'analytics/models/marts/orders.sql' }])
  // customers.sql is in the manifest but not on disk.
  assert.deepEqual(await worker.request('lineage.open', { id: 'model.shop.customers' }), {
    opened: false,
    message: 'models/marts/customers.sql is not in this workspace.'
  })
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('queries through the project dbt, with its .env, in the project folder', async () => {
  const worker = await mountWorker(main, { host: fixtureHost({ settings: { projectDir: '', dbtCommand: fakeDbt } }) })
  assert.deepEqual(await worker.request('query.engine'), {
    command: fakeDbt,
    flavor: 'fusion',
    version: '2.0.0-test'
  })

  const started = await worker.request('query.start', { id: 'model.shop.orders', limit: 5 })
  assert.equal(started.sql, "select * from {{ ref('shop', 'orders') }}")
  const { ms: _ms, ...done } = await posted(worker, 'query.done')
  assert.deepEqual(done, {
    jobId: started.jobId,
    ok: true,
    columns: ['greeting', 'folder'],
    rows: [['hello from .env', 'analytics']],
    truncated: false
  })

  // dbt v2 can fail a parse; its error log line is what the panel shows.
  const parse = await worker.request('project.parse')
  assert.deepEqual(await posted(worker, 'parse.done'), {
    jobId: parse.jobId,
    ok: false,
    error: 'error: dbt1060: Ignored unexpected key'
  })
  await worker.deactivate()
})

test('draws the neighborhood a graph request asks for', async () => {
  const worker = await mountWorker(main, { host: fixtureHost() })
  const graph = await worker.request('lineage.graph', { id: 'model.shop.orders', up: 1, down: 1 })
  assert.deepEqual(graph?.nodes.map((n) => n.id).sort(), [
    'exposure.shop.weekly_dashboard',
    'model.shop.customers',
    'model.shop.orders',
    'model.shop.stg_orders'
  ])
  // customers -> weekly_dashboard links two drawn nodes, so it is drawn too.
  assert.deepEqual(graph?.edges.sort(), [
    ['model.shop.customers', 'exposure.shop.weekly_dashboard'],
    ['model.shop.orders', 'exposure.shop.weekly_dashboard'],
    ['model.shop.orders', 'model.shop.customers'],
    ['model.shop.stg_orders', 'model.shop.orders']
  ])
  const customers = graph?.nodes.find((n) => n.id === 'model.shop.customers')
  assert.equal(customers?.hiddenParents, 1) // stg_customers

  const expanded = await worker.request('lineage.graph', {
    id: 'model.shop.orders',
    up: 1,
    down: 1,
    expand: [{ id: 'model.shop.customers', direction: 'up' }]
  })
  assert.ok(expanded?.nodes.some((n) => n.id === 'model.shop.stg_customers'))
  assert.equal(await worker.request('lineage.graph', { id: 'model.shop.gone', up: 1, down: 1 }), null)
  await worker.deactivate()
})

test('says why there is no lineage', async () => {
  const unfocused = await mountWorker(main, { host: fixtureHost({ context: null }) })
  assert.equal((await unfocused.request('lineage.status')).ok, false)
  await unfocused.deactivate()

  const misconfigured = await mountWorker(main, { host: fixtureHost({ settings: { projectDir: 'analytics/models' } }) })
  const status = await misconfigured.request('lineage.status')
  assert.equal(status.ok ? null : status.reason, 'no_project')
  await misconfigured.deactivate()
})
