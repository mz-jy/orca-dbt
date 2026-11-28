// Speaks MCP to a server on a free port the way an agent's client does: JSON-RPC over POST.
import { assert, test } from 'orca/testing'
import { startMcpServer, type McpInfo } from './mcp'

const info: McpInfo = {
  name: 'test',
  version: '1.2.3',
  instructions: 'Say hello.',
  tools: [
    {
      name: 'greet',
      description: 'Greets.',
      input: { properties: { name: { type: 'string' } }, required: ['name'] },
      readOnly: true,
      run: async ({ name }) => {
        if (typeof name !== 'string') throw new Error('name must be text.')
        return { greeting: `hello ${name}` }
      }
    }
  ]
}

async function withServer(run: (post: (body: unknown, headers?: Record<string, string>) => Promise<Response>, url: string) => Promise<void>) {
  const server = await startMcpServer(0, info)
  const url = `http://127.0.0.1:${server.port}/mcp`
  try {
    await run(
      (body, headers = {}) =>
        fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }),
      url
    )
  } finally {
    await server.close()
  }
}

test('initializes, lists its tools and calls one', async () => {
  await withServer(async (post) => {
    const hello = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } })
    assert.deepEqual(await hello.json(), {
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'test', version: '1.2.3' },
        instructions: 'Say hello.'
      }
    })
    // A notification gets no answer.
    const ready = await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    assert.equal(ready.status, 202)

    const listed = (await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as { result: { tools: unknown[] } }
    assert.deepEqual(listed.result.tools, [
      {
        name: 'greet',
        description: 'Greets.',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        annotations: { readOnlyHint: true }
      }
    ])

    const call = (args: unknown) => post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'greet', arguments: args } })
    assert.deepEqual(await (await call({ name: 'dbt' })).json(), {
      jsonrpc: '2.0',
      id: 3,
      result: { content: [{ type: 'text', text: '{"greeting":"hello dbt"}' }] }
    })
    // A tool's own failure is a result the agent reads.
    assert.deepEqual(await (await call({})).json(), {
      jsonrpc: '2.0',
      id: 3,
      result: { content: [{ type: 'text', text: 'name must be text.' }], isError: true }
    })
    const unknown = (await (await post({ jsonrpc: '2.0', id: 4, method: 'resources/list' })).json()) as { error: { code: number } }
    assert.equal(unknown.error.code, -32601)
  })
})

test('refuses web pages and anything but a JSON post to /mcp', async () => {
  await withServer(async (post, url) => {
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' }
    assert.equal((await post(ping)).status, 200)
    assert.equal((await post(ping, { Origin: 'https://example.com' })).status, 403)
    assert.equal((await post(ping, { Origin: 'http://localhost:3000' })).status, 200)
    // What a page can post across origins without asking first.
    assert.equal((await post(ping, { 'Content-Type': 'text/plain' })).status, 415)
    assert.equal((await fetch(url)).status, 405)
    assert.equal((await fetch(url.replace('/mcp', '/'), { method: 'POST' })).status, 404)
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400)
  })
})

test('says when its port is taken', async () => {
  const first = await startMcpServer(0, info)
  try {
    await assert.rejects(startMcpServer(first.port, info), /EADDRINUSE/)
  } finally {
    await first.close()
  }
})
