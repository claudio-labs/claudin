import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Returns true when `invokedPath` resolves into a working tree of our own
 * package (a `bun link` / `npm link` setup), false for installed copies.
 *
 * The disambiguator is `.git/` at the package root: dev checkouts have it,
 * `bun add -g` / `npm i -g` ship the package without a `.git` directory.
 * Without the `.git` requirement, every global install of @claudinlabs/claudin
 * is misread as "development" (its installed package.json has the matching
 * name), which suppresses auto-update.
 */
export async function isInvokedFromSourceTree(
  invokedPath: string,
  expectedPackageName: string,
): Promise<boolean> {
  if (!invokedPath) return false
  try {
    const resolved = await realpath(invokedPath)
    let dir = dirname(resolved)
    for (let i = 0; i < 4; i++) {
      const pkgPath = join(dir, 'package.json')
      try {
        const raw = await readFile(pkgPath, 'utf8')
        const pkg = JSON.parse(raw) as { name?: string }
        if (pkg.name === expectedPackageName) {
          try {
            await stat(join(dir, '.git'))
            return true
          } catch {
            return false
          }
        }
      } catch {
        // package.json missing or unreadable at this level — keep walking
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // realpath failed (broken symlink, permission denied, etc.) — not dev
  }
  return false
}
