// The environment dbt runs with, and the .env files it comes from. By default every `.env` from
// the workspace root down to the dbt project (as `just` with dotenv-load or direnv would load
// them); the "Env file" setting picks one file instead. The panel edits that file in place.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { foldersDownTo } from './project'

/** The files variables are read from, in load order (later wins), and the one Save writes. */
export type EnvSources = { files: string[]; target: string }

/** .env-like names offered as a source: .env, .env.local, .env.dev, prod.env, … */
const ENV_FILE_NAME = /^(\.env(\.[\w.-]+)?|[\w.-]+\.env)$/
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Values that need no quotes in a .env file. */
const PLAIN_VALUE = /^[A-Za-z0-9_./:@+,%=-]*$/
/** `env_var('NAME')` or `env_var("NAME", 'default')` in Jinja. */
const ENV_VAR_CALL = /env_var\(\s*['"]([^'"]+)['"]\s*(,)?/g

export function isEnvKey(key: string): boolean {
  return ENV_KEY.test(key)
}

/**
 * Where the variables come from. With `configured` (relative to the workspace root, or
 * absolute): that file alone, which Save writes, even before it exists. Without: every `.env`
 * from the root down to the project; Save writes the deepest one, or a new one in the project.
 */
export function envSources(root: string, projectDir: string, configured: string): EnvSources {
  if (configured) {
    const file = isAbsolute(configured) ? configured : join(root, configured)
    return { files: existsSync(file) ? [file] : [], target: file }
  }
  const files = foldersDownTo(root, projectDir)
    .map((dir) => join(dir, '.env'))
    .filter((file) => existsSync(file))
  return { files, target: files[files.length - 1] ?? join(projectDir, '.env') }
}

/** .env-like files in the folders from the workspace root down to the project, to choose from. */
export function envCandidates(root: string, projectDir: string): string[] {
  return foldersDownTo(root, projectDir).flatMap((dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && ENV_FILE_NAME.test(entry.name))
        .map((entry) => join(dir, entry.name))
        .sort()
    } catch {
      return []
    }
  })
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

/** A value as parseDotenv reads it back: bare when safe, else single, else double quoted. */
function quote(value: string): string {
  if (PLAIN_VALUE.test(value)) return value
  if (!value.includes("'") && !value.includes('\n')) return `'${value}'`
  return `"${value.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

function keyLine(key: string): RegExp {
  return new RegExp(`^\\s*(export\\s+)?${key}\\s*=`)
}

/** `text` with `key` set to `value`: its last line replaced in place, else a line appended. */
export function setDotenvVar(text: string, key: string, value: string): string {
  const lines = text === '' ? [] : text.split('\n')
  const pattern = keyLine(key)
  let at = -1
  for (let index = lines.length - 1; index >= 0 && at < 0; index--) if (pattern.test(lines[index])) at = index
  const line = `${at >= 0 && /^\s*export\s+/.test(lines[at]) ? 'export ' : ''}${key}=${quote(value)}`
  if (at >= 0) lines[at] = line
  else {
    if (lines[lines.length - 1] === '') lines.pop()
    lines.push(line, '')
  }
  return lines.join('\n')
}

/** `text` without any line that sets `key`. */
export function deleteDotenvVar(text: string, key: string): string {
  const pattern = keyLine(key)
  return text
    .split('\n')
    .filter((line) => !pattern.test(line))
    .join('\n')
}

/** The variables `files` set, in load order: a later file overrides an earlier one. */
export function readEnvFiles(files: readonly string[]): { key: string; value: string; file: string }[] {
  const vars = new Map<string, { key: string; value: string; file: string }>()
  for (const file of files) {
    for (const [key, value] of Object.entries(parseDotenv(readFileSync(file, 'utf8')))) vars.set(key, { key, value, file })
  }
  return [...vars.values()]
}

/** The worker's own environment (Orca's, without its secrets). */
function ownEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

/** The environment dbt runs with: the env files' variables under the worker's own, as dotenv does. */
export function dbtEnvironment(root: string, projectDir: string, configured: string): Record<string, string> {
  const fromFiles = Object.fromEntries(readEnvFiles(envSources(root, projectDir, configured).files).map(({ key, value }) => [key, value]))
  const own = ownEnvironment()
  return { ...fromFiles, ...own, DBT_SEND_ANONYMOUS_USAGE_STATS: own.DBT_SEND_ANONYMOUS_USAGE_STATS ?? 'false' }
}

/**
 * The variables the project's profile and dbt_project.yml read with `env_var()`, and whether
 * each has a default. The profile is found as dbt finds it: DBT_PROFILES_DIR, else the project
 * folder, else ~/.dbt; only the project's own profile block is read.
 */
export function requiredEnvVars(
  projectDir: string,
  env: Record<string, string>
): { profile: string; profilesFile: string | null; vars: { key: string; hasDefault: boolean }[] } {
  const projectFile = join(projectDir, 'dbt_project.yml')
  const projectText = existsSync(projectFile) ? readFileSync(projectFile, 'utf8') : ''
  const profile = /^profile:\s*['"]?([\w-]+)/m.exec(projectText)?.[1] ?? ''
  const dirs = [env.DBT_PROFILES_DIR, projectDir, join(homedir(), '.dbt')].filter((dir): dir is string => Boolean(dir))
  const profilesFile = dirs.map((dir) => join(dir, 'profiles.yml')).find((file) => existsSync(file)) ?? null
  const profileText = profilesFile && profile ? profileBlock(readFileSync(profilesFile, 'utf8'), profile) : ''

  const vars = new Map<string, boolean>()
  for (const text of [profileText, projectText]) {
    for (const match of text.matchAll(ENV_VAR_CALL)) vars.set(match[1], (vars.get(match[1]) ?? false) || match[2] === ',')
  }
  return {
    profile,
    profilesFile,
    vars: [...vars].map(([key, hasDefault]) => ({ key, hasDefault })).sort((a, b) => a.key.localeCompare(b.key))
  }
}

/** The lines of profiles.yml under the top-level `profile:` key, up to the next top-level key. */
function profileBlock(text: string, profile: string): string {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => new RegExp(`^['"]?${profile}['"]?\\s*:`).test(line))
  if (start < 0) return ''
  const end = lines.findIndex((line, index) => index > start && /^[^\s#]/.test(line))
  return lines.slice(start, end < 0 ? undefined : end).join('\n')
}

/** A path relative to the workspace root, else under ~ when in the home folder, else absolute. */
export function displayPath(root: string, file: string): string {
  const inside = relative(root, file)
  if (inside && !inside.startsWith('..') && !isAbsolute(inside)) return inside
  const home = homedir()
  return file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file
}
