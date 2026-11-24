// Runs the project's own dbt the way its tooling does, so queries reach the warehouse with the
// profile's own connection and credentials (Snowflake SSO, ClickHouse, Postgres, DuckDB, ...):
// the dbt in the project's virtualenv, with the environment src/env.ts builds, in the project
// folder (where dbt looks for profiles.yml before ~/.dbt).
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { foldersDownTo } from './project'
import type { DbtEngine, QueryCell } from './protocol'

export type DbtResult = { code: number | null; lines: string[]; stderr: string }

/** Where dbt installers put `dbt`, for an Orca started without the login shell's PATH. */
const COMMON_BIN_DIRS = [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']

/** Rows past this many bytes of JSON are dropped: a panel post carries at most 256 KiB. */
const MAX_RESULT_BYTES = 200_000
const MAX_CELL_LENGTH = 500

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
