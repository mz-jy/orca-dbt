// Runs the project's own dbt the way its tooling does, so queries reach the warehouse with the
// profile's own connection and credentials (Snowflake SSO, ClickHouse, Postgres, DuckDB, ...):
// the dbt in the project's virtualenv, the .env files `just`/direnv load, the project folder as
// the working directory (where dbt looks for profiles.yml before ~/.dbt).
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import type { DbtEngine, QueryCell } from './protocol'

export type DbtResult = { code: number | null; lines: string[]; stderr: string }

/** Where dbt installers put `dbt`, for an Orca started without the login shell's PATH. */
const COMMON_BIN_DIRS = [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']

/** Rows past this many bytes of JSON are dropped: a panel post carries at most 256 KiB. */
const MAX_RESULT_BYTES = 200_000
const MAX_CELL_LENGTH = 500

/** The workspace root, the folders below it and the project folder itself, root first. */
function foldersDownTo(root: string, projectDir: string): string[] {
  const folders = [projectDir]
  for (let dir = projectDir; dir !== root && dir.startsWith(root) && dirname(dir) !== dir; ) {
    dir = dirname(dir)
    folders.unshift(dir)
  }
  return folders
}

/**
 * The command that runs dbt: `configured` when the person set one (split on spaces, such as
 * `uv run dbt` or `dbtf`), else the nearest `.venv/bin/dbt` from the project up to the workspace
 * root (dbt-core, v1), else `dbt` on PATH or in the usual install folders (often Fusion, v2).
 */
export function dbtCommand(root: string, projectDir: string, configured: string): string[] {
  if (configured) return configured.split(/\s+/).filter(Boolean)
  const venv = foldersDownTo(root, projectDir)
    .reverse()
    .map((dir) => join(dir, '.venv', 'bin', 'dbt'))
    .find((candidate) => existsSync(candidate))
  if (venv) return [venv]
  const onPath = [...(process.env.PATH ?? '').split(delimiter), ...COMMON_BIN_DIRS]
    .filter(Boolean)
    .map((dir) => join(dir, 'dbt'))
    .find((candidate) => existsSync(candidate))
  return [onPath ?? 'dbt']
}

/** v1 prints `Core: - installed: 1.x`; v2 prints `dbt-fusion 2.x`. */
export function parseDbtVersion(output: string): Pick<DbtEngine, 'version' | 'flavor'> {
  const fusion = /dbt-fusion\s+(\S+)/.exec(output)
  if (fusion) return { flavor: 'fusion', version: fusion[1] }
  const core = /installed(?: version)?:\s*(\d\S*)/.exec(output)
  if (core) return { flavor: 'core', version: core[1] }
  return { flavor: 'unknown', version: null }
}

/** KEY=value lines as dotenv reads them: comments, `export`, quotes, inline `#` comments. */
export function parseDotenv(text: string): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, '')
    const match = /^([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    let value = match[2]
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote))
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"')
    } else {
      value = value.replace(/\s+#.*$/, '').trim()
    }
    vars[match[1]] = value
  }
  return vars
}

/**
 * The environment dbt runs with: every `.env` from the workspace root down to the project (the
 * deeper file wins), under the worker's own environment, which wins as dotenv does.
 */
export function dbtEnvironment(root: string, projectDir: string): Record<string, string> {
  const fromFiles: Record<string, string> = {}
  for (const dir of foldersDownTo(root, projectDir)) {
    const file = join(dir, '.env')
    if (existsSync(file)) Object.assign(fromFiles, parseDotenv(readFileSync(file, 'utf8')))
  }
  const own = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
  return { ...fromFiles, ...own, DBT_SEND_ANONYMOUS_USAGE_STATS: own.DBT_SEND_ANONYMOUS_USAGE_STATS ?? 'false' }
}

export function runDbt(
  command: string[],
  args: string[],
  options: { cwd: string; env: Record<string, string>; signal: AbortSignal }
): Promise<DbtResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], [...command.slice(1), ...args], {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.name === 'AbortError') reject(error)
      else if (error.code === 'ENOENT') {
        reject(new Error(`Could not run "${command[0]}". Install dbt in the project's .venv, or set the dbt command in this plugin's settings.`))
      } else reject(error)
    })
    child.on('close', (code) => resolve({ code, lines: stdout.split('\n'), stderr }))
  })
}

type LogLine = {
  info?: { name?: string; level?: string; msg?: string }
  /** ShowNode: the rows as JSON text; v2 also names the columns, in order. */
  data?: { preview?: string; columns?: string[] }
}

function logLines(result: DbtResult): LogLine[] {
  return result.lines.flatMap((line) => {
    if (!line.startsWith('{')) return []
    try {
      return [JSON.parse(line) as LogLine]
    } catch {
      return []
    }
  })
}

/** What went wrong, from dbt's error log lines, else the end of its other output. */
export function dbtError(result: DbtResult): string {
  const errors = logLines(result)
    .filter((line) => line.info?.level === 'error' && line.info.msg)
    .map((line) => line.info!.msg!.trim())
  if (errors.length > 0) return errors.join('\n').slice(-4000)
  const plain = [...result.lines.filter((line) => line.trim() && !line.startsWith('{')), ...result.stderr.split('\n')]
    .filter((line) => line.trim())
    .slice(-20)
    .join('\n')
  return plain || `dbt exited with code ${result.code}.`
}

/** The rows of a `dbt show --output json --log-format json` run, from its ShowNode event. */
export function showRows(result: DbtResult): { columns: string[]; rows: QueryCell[][]; truncated: boolean } | null {
  const show = logLines(result).find((line) => line.info?.name === 'ShowNode' && typeof line.data?.preview === 'string')
  if (!show) return null
  const records = JSON.parse(show.data!.preview!) as Record<string, unknown>[]
  const columns = show.data?.columns ?? (records.length > 0 ? Object.keys(records[0]) : [])
  const rows: QueryCell[][] = []
  let bytes = 0
  for (const record of records) {
    const row = columns.map((column) => cell(record[column]))
    bytes += JSON.stringify(row).length
    if (bytes > MAX_RESULT_BYTES) return { columns, rows, truncated: true }
    rows.push(row)
  }
  return { columns, rows, truncated: false }
}

function cell(value: unknown): QueryCell {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' || typeof value === 'boolean') return value
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > MAX_CELL_LENGTH ? `${text.slice(0, MAX_CELL_LENGTH)}…` : text
}
