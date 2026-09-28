/**
 * Builds fingerprints.bin, the hashes the provenance gate compares this tree
 * against. It only has to run again when fingerprint.ts changes its PARAMS.
 *
 *   bun run provenance:fingerprints
 *
 * Both origins are read out of a local openclaude clone, found at
 * PROVENANCE_REF_REPO (default: ../openclaude, a sibling of this checkout):
 *
 *  - Claude Code: openclaude's root commit, the Claude Code source it was
 *    built from.
 *  - openclaude: the commit Claudin was cut from, plus the two changes it
 *    cherry-picked on the way (#882, #908). Whatever this set shares with the
 *    first one is dropped from it, so a line is attributed to its earliest
 *    origin.
 *
 * Nothing is read from a working tree: `git cat-file` serves every blob, so
 * the clone's own checkout and local edits never leak into the result.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { REPO_ROOT } from '../../repoRoot.js'
import { CODE_EXTENSION, fileFingerprints, PARAMS, type ReferenceSets, TEXT_EXTENSION } from './fingerprint.js'
import { REFERENCE_PATH, writeReference } from './reference.js'

const CLAUDE_CODE = 'd2542c9a628b1ec65d2d96b015aa1f3541fdc095'
const OPENCLAUDE = '9e23c2bec43697187762601db5b1585c9b0fb1a3'
const OPENCLAUDE_CHERRY_PICKS = [
  '6ea3eb64830ccfec1436bcebe2406158e14a7e81',
  'a3e728a114f6379b80daefc8abcac17a752c5f96',
]

const refRepo = resolve(process.env.PROVENANCE_REF_REPO ?? resolve(REPO_ROOT, '..', 'openclaude'))

function git(args: string[], input?: string): Buffer {
  const result = spawnSync('git', ['-C', refRepo, ...args], {
    input,
    maxBuffer: 2 * 1024 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${refRepo}:\n${result.stderr.toString()}`)
  }
  return result.stdout
}

function resolveCommit(sha: string): string {
  return git(['rev-parse', '--verify', `${sha}^{commit}`]).toString().trim()
}

const fingerprintable = (path: string) => CODE_EXTENSION.test(path) || TEXT_EXTENSION.test(path)

/** Every fingerprintable path in a commit's tree, or only those it changed. */
function pathsAt(commit: string, changedOnly: boolean): string[] {
  const listing = changedOnly
    ? git(['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=AM', '-r', commit])
    : git(['ls-tree', '-r', '--name-only', commit])
  return listing.toString().split('\n').filter(p => p !== '' && fingerprintable(p))
}

/** Blob contents for `commit:path` specs, through one `git cat-file --batch`. */
function readBlobs(commit: string, paths: string[]): Map<string, string> {
  const out = new Map<string, string>()
  if (paths.length === 0) return out
  const stdout = git(['cat-file', '--batch'], paths.map(p => `${commit}:${p}`).join('\n') + '\n')
  let at = 0
  for (const path of paths) {
    const headerEnd = stdout.indexOf(0x0a, at)
    const header = stdout.subarray(at, headerEnd).toString()
    at = headerEnd + 1
    if (header.endsWith(' missing')) continue
    const size = Number(header.split(' ')[2])
    out.set(path, stdout.subarray(at, at + size).toString('utf8'))
    at += size + 1
  }
  return out
}

function addFiles(into: ReferenceSets, files: Map<string, string>): void {
  for (const [path, source] of files) {
    const { lines, grams } = fileFingerprints(source, CODE_EXTENSION.test(path))
    for (const hash of lines) into.lines.add(hash)
    for (const hash of grams) into.grams.add(hash)
  }
}

if (!existsSync(refRepo)) {
  console.error(
    `ERROR: no openclaude clone at ${refRepo}.\n` +
      'Clone https://github.com/Gitlawb/openclaude there, or point PROVENANCE_REF_REPO at one.',
  )
  process.exit(1)
}

const claudeCodeCommit = resolveCommit(CLAUDE_CODE)
const openclaudeCommit = resolveCommit(OPENCLAUDE)
const cherryPicks = OPENCLAUDE_CHERRY_PICKS.map(resolveCommit)

const claudeCode: ReferenceSets = { lines: new Set(), grams: new Set() }
addFiles(claudeCode, readBlobs(claudeCodeCommit, pathsAt(claudeCodeCommit, false)))

const openclaude: ReferenceSets = { lines: new Set(), grams: new Set() }
addFiles(openclaude, readBlobs(openclaudeCommit, pathsAt(openclaudeCommit, false)))
for (const commit of cherryPicks) addFiles(openclaude, readBlobs(commit, pathsAt(commit, true)))
for (const hash of claudeCode.lines) openclaude.lines.delete(hash)
for (const hash of claudeCode.grams) openclaude.grams.delete(hash)

const bytes = writeReference({
  header: {
    params: PARAMS,
    sources: {
      claudeCode: claudeCodeCommit,
      openclaude: openclaudeCommit,
      openclaudeCherryPicks: cherryPicks.join(' '),
    },
    builtAt: new Date().toISOString().slice(0, 10),
  },
  claudeCode,
  openclaude,
})

console.log(
  `Wrote ${REFERENCE_PATH.slice(REPO_ROOT.length + 1)} (${(bytes / 1024).toFixed(0)} KB)\n` +
    `  Claude Code: ${claudeCode.lines.size} lines, ${claudeCode.grams.size} grams\n` +
    `  openclaude:  ${openclaude.lines.size} lines, ${openclaude.grams.size} grams`,
)
