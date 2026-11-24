// Finds the dbt project inside a workspace and where its manifest lives.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

/** Never dbt projects of their own: vendored packages, build output, environments. */
const SKIPPED_DIRS: Record<string, true> = {
  node_modules: true,
  dbt_packages: true,
  dbt_modules: true,
  target: true,
  logs: true,
  venv: true,
  __pycache__: true
}
const MAX_DEPTH = 3
const MAX_DIRS = 2000

/** The workspace root, the folders below it and the project folder itself, root first. */
export function foldersDownTo(root: string, projectDir: string): string[] {
  const folders = [projectDir]
  for (let dir = projectDir; dir !== root && dir.startsWith(root) && dirname(dir) !== dir; ) {
    dir = dirname(dir)
    folders.unshift(dir)
  }
  return folders
}

/**
 * The folder holding dbt_project.yml: `configured` (relative to the workspace root, or absolute)
 * when set, else the shallowest one within three levels of the root, alphabetical on ties.
 */
export function findProjectDir(root: string, configured: string): string | null {
  if (configured) {
    const dir = isAbsolute(configured) ? configured : join(root, configured)
    return existsSync(join(dir, 'dbt_project.yml')) ? dir : null
  }
  let level = [root]
  let visited = 0
  for (let depth = 0; depth <= MAX_DEPTH && level.length > 0; depth++) {
    const next: string[] = []
    for (const dir of level) {
      if (existsSync(join(dir, 'dbt_project.yml'))) return dir
      if (depth === MAX_DEPTH || visited >= MAX_DIRS) continue
      for (const name of subdirectories(dir)) {
        next.push(join(dir, name))
        visited++
      }
    }
    level = next
  }
  return null
}

function subdirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED_DIRS[entry.name])
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** `<target-path>/manifest.json`, honoring a `target-path` set in dbt_project.yml. */
export function manifestPathFor(projectDir: string): string {
  let targetPath = 'target'
  try {
    const config = readFileSync(join(projectDir, 'dbt_project.yml'), 'utf8')
    const match = /^target-path:\s*["']?([^"'#\s]+)/m.exec(config)
    if (match) targetPath = match[1]
  } catch {
    // Unreadable config: dbt's default target path.
  }
  return isAbsolute(targetPath)
    ? join(targetPath, 'manifest.json')
    : join(projectDir, targetPath, 'manifest.json')
}
