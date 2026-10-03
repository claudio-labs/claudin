import { relative, sep } from 'path'

type PathAnchors = {
  cwd: string
  home: string
}

/**
 * `dir` itself or something below it. The separator matters: `/home/u` does
 * not contain `/home/user2/x`, though one string starts with the other.
 */
export function isPathWithin(dir: string, path: string): boolean {
  if (path === dir) return true
  return path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`)
}

/**
 * A memory path as the user reads it: `./…` under the working directory,
 * `~/…` under the home directory, the shorter of the two when both apply
 * (`~` on a tie), and the path itself otherwise.
 */
export function shortenMemoryPath(path: string, { cwd, home }: PathAnchors): string {
  const homeForm = isPathWithin(home, path) ? tildeForm(home, path) : null
  const cwdForm = isPathWithin(cwd, path) ? `./${relative(cwd, path)}` : null
  if (homeForm !== null && cwdForm !== null) {
    return cwdForm.length < homeForm.length ? cwdForm : homeForm
  }
  return cwdForm ?? homeForm ?? path
}

function tildeForm(home: string, path: string): string {
  const rest = relative(home, path)
  return rest === '' ? '~' : `~${sep}${rest}`
}
