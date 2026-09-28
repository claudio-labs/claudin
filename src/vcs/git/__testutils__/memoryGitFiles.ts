/**
 * An in-memory stand-in for the disk behind src/vcs/git/gitFilesystem, for
 * unit tests that need no real repository. Paths are plain POSIX strings; a
 * directory exists when some file lies below it. Every read is recorded, so a
 * test can tell how much a lookup read.
 */

import type { GitFiles } from 'src/vcs/git/gitFilesystem/gitFiles.js'

export class MemoryGitFiles implements GitFiles {
  readonly reads: string[] = []
  private readonly contents = new Map<string, string>()

  constructor(initial: Record<string, string> = {}) {
    for (const [path, text] of Object.entries(initial)) this.contents.set(path, text)
  }

  write(path: string, text: string): void {
    this.contents.set(path, text)
  }

  remove(path: string): void {
    this.contents.delete(path)
  }

  async readText(path: string): Promise<string | null> {
    this.reads.push(path)
    return this.contents.get(path) ?? null
  }

  async isDirectory(path: string): Promise<boolean> {
    return [...this.contents.keys()].some(file => file.startsWith(`${path}/`))
  }

  async listDirectories(path: string): Promise<string[] | null> {
    const below = [...this.contents.keys()].filter(file => file.startsWith(`${path}/`))
    if (below.length === 0) return null
    const names = below
      .map(file => file.slice(path.length + 1).split('/'))
      .filter(parts => parts.length > 1)
      .map(parts => parts[0]!)
    return [...new Set(names)]
  }
}
