// What a branch changed in a dbt project, from git: everything since it left its base, committed
// or not, plus untracked files. Paths are relative to the dbt project folder.
import { execFile } from 'node:child_process'
import type { FileChange } from './changes'

export class GitError extends Error {}

export type BranchDiff = { head: string; base: string; mergeBase: string; files: FileChange[] }

/** Bases to try, in order, when the person set none and origin/HEAD is not known. */
const BASE_CANDIDATES = ['origin/main', 'origin/master', 'main', 'master']
const STATUS: Record<string, FileChange['status']> = { A: 'A', M: 'M', D: 'D', R: 'R', C: 'A', T: 'M' }

// The executor form: Promise.withResolvers is newer than the ES2022 the worker is typed for.
function git(projectDir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', projectDir, ...args], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new GitError((stderr || error.message).trim()))
      else resolve(stdout)
    })
  })
}

async function resolves(projectDir: string, ref: string): Promise<boolean> {
  return git(projectDir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).then(
    () => true,
    () => false
  )
}

/** The base to compare with: `configured`, else origin's default branch, else main or master. */
async function baseRef(projectDir: string, configured: string): Promise<string> {
  if (configured) {
    if (await resolves(projectDir, configured)) return configured
    throw new GitError(`Git does not know the base "${configured}". Fix the base branch in this plugin's settings.`)
  }
  const originHead = await git(projectDir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')
  for (const candidate of [originHead.trim(), ...BASE_CANDIDATES]) {
    if (candidate && (await resolves(projectDir, candidate))) return candidate
  }
  throw new GitError('Found no base branch (origin/main, main, master). Set the base branch in this plugin\'s settings.')
}

export async function branchDiff(projectDir: string, configuredBase: string): Promise<BranchDiff> {
  const inside = await git(projectDir, ['rev-parse', '--is-inside-work-tree']).catch(() => 'false')
  if (inside.trim() !== 'true') throw new GitError('This dbt project is not in a git repository.')
  const head = (await git(projectDir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  const base = await baseRef(projectDir, configuredBase)
  const mergeBase = (await git(projectDir, ['merge-base', 'HEAD', base])).trim()

  // The merge base against the working tree: commits on the branch, staged and unstaged edits.
  // --relative limits it to the project folder and makes paths relative to it.
  const diff = await git(projectDir, ['diff', '--name-status', '--no-renames', '--relative', mergeBase])
  const untracked = await git(projectDir, ['ls-files', '--others', '--exclude-standard'])
  const files: FileChange[] = []
  for (const line of diff.split('\n')) {
    const [code, path] = line.split('\t')
    const status = code ? STATUS[code[0]] : undefined
    if (status && path) files.push({ path, status })
  }
  for (const path of untracked.split('\n')) if (path) files.push({ path, status: 'U' })
  return { head, base, mergeBase: mergeBase.slice(0, 8), files }
}
