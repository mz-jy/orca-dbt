// A Model Context Protocol server for coding agents, over HTTP on this computer only: the
// stateless form of MCP's Streamable HTTP transport (each POST carries one JSON-RPC message and
// is answered with JSON; no sessions, no event stream). Written against node:http because the
// plugin has no dependencies to install. What the tools do is the worker's business.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type McpTool = {
  name: string
  description: string
  /** JSON Schema of the arguments. */
  input: { properties: Record<string, unknown>; required?: string[] }
  /** Reads only: nothing runs on the warehouse and no file is written. */
  readOnly: boolean
  /** Answers with a JSON value (sent as text); a throw is the tool's error. `signal` aborts when the agent hangs up. */
  run(args: Record<string, unknown>, signal: AbortSignal): unknown
}

export type McpInfo = { name: string; version: string; instructions: string; tools: readonly McpTool[] }

export type McpServer = { port: number; close(): Promise<void> }

type Response = { jsonrpc: '2.0'; id: unknown; result?: unknown; error?: { code: number; message: string } }

/** Newest first: the server speaks the agent's version when it knows it, else its newest. */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const LOCAL_HOSTS: Record<string, true> = { '127.0.0.1': true, localhost: true, '[::1]': true }
const MAX_BODY_BYTES = 1024 * 1024

/** The answer to one JSON-RPC message; null for a notification or a response, which get none. */
export async function answer(message: unknown, info: McpInfo, signal: AbortSignal): Promise<Response | null> {
  const request = (typeof message === 'object' && message !== null ? message : {}) as Record<string, unknown>
  const id = request.id ?? null
  const fail = (code: number, text: string): Response => ({ jsonrpc: '2.0', id, error: { code, message: text } })
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return 'result' in request || 'error' in request ? null : fail(-32600, 'Not a JSON-RPC 2.0 request.')
  }
  if (request.id === undefined) return null
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>
  const ok = (result: unknown): Response => ({ jsonrpc: '2.0', id, result })

  switch (request.method) {
    case 'initialize': {
      const wanted = PROTOCOL_VERSIONS.find((version) => version === params.protocolVersion)
      return ok({
        protocolVersion: wanted ?? PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: info.name, version: info.version },
        instructions: info.instructions
      })
    }
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({
        tools: info.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: { type: 'object', ...tool.input },
          annotations: { readOnlyHint: tool.readOnly }
        }))
      })
    case 'tools/call': {
      const tool = info.tools.find((candidate) => candidate.name === params.name)
      if (!tool) return fail(-32602, `Unknown tool: ${String(params.name)}`)
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>
      try {
        const result = await tool.run(args, signal)
        return ok({ content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] })
      } catch (error) {
        // A tool's failure is a result the agent reads and acts on, not a protocol error.
        return ok({ content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true })
      }
    }
    default:
      return fail(-32601, `Unknown method: ${request.method}`)
  }
}

/**
 * Serves `info`'s tools at http://127.0.0.1:<port>/mcp (port 0: any free port). Rejects when
 * the port is taken. Only this computer reaches it, and no web page: a request must name a
 * local host (a page that rebinds its DNS name to 127.0.0.1 does not), must not come from a
 * page of another origin, and must be JSON, which a page cannot post across origins unasked.
 */
export function startMcpServer(port: number, info: McpInfo): Promise<McpServer> {
  const server = createServer((request, response) => {
    void serve(request, response, info).catch(() => {
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise((closed) => {
            server.close(() => closed())
            server.closeAllConnections()
          })
      })
    })
  })
}

async function serve(request: IncomingMessage, response: ServerResponse, info: McpInfo): Promise<void> {
  const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
    response.writeHead(status, body === undefined ? headers : { 'Content-Type': 'application/json', ...headers })
    response.end(body === undefined ? undefined : JSON.stringify(body))
  }
  const refuse = (status: number, text: string) => send(status, { jsonrpc: '2.0', id: null, error: { code: -32600, message: text } })

  if (!isLocal(request.headers.host)) return refuse(403, 'This server answers on 127.0.0.1 only.')
  const origin = request.headers.origin
  if (origin !== undefined && !isLocal(origin.replace(/^https?:\/\//, ''))) return refuse(403, 'Requests from web pages are refused.')
  if (new URL(request.url ?? '/', 'http://127.0.0.1').pathname !== '/mcp') return refuse(404, 'The MCP endpoint is /mcp.')
  // No event stream to GET and no session to DELETE.
  if (request.method !== 'POST') return send(405, undefined, { Allow: 'POST' })
  if (!/^application\/json\b/i.test(request.headers['content-type'] ?? '')) return refuse(415, 'Send application/json.')

  let message: unknown
  try {
    message = JSON.parse(await body(request))
  } catch (error) {
    return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: error instanceof Error ? error.message : 'Parse error' } })
  }
  // A dbt run stops when the agent stops waiting for it.
  const gone = new AbortController()
  response.on('close', () => response.writableFinished || gone.abort())
  // Protocol versions before 2025-06-18 may send several messages in one array.
  const answers = (await Promise.all((Array.isArray(message) ? message : [message]).map((one) => answer(one, info, gone.signal)))).filter(
    (one) => one !== null
  )
  if (answers.length === 0) return send(202)
  send(200, Array.isArray(message) ? answers : answers[0])
}

/** Whether a Host header (or an origin without its scheme) names this computer. */
function isLocal(host: string | undefined): boolean {
  return host !== undefined && LOCAL_HOSTS[host.replace(/:\d+$/, '').toLowerCase()] === true
}

function body(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('Request too large.'))
        request.destroy()
      } else chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}
