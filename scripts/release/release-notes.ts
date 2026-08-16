#!/usr/bin/env bun
/**
 * Renders the commit list of a release as markdown grouped by conventional-commit
 * type ("✨ Features", "🐛 Bug Fixes", …) instead of one flat bullet list.
 *
 * Used by .github/workflows/release-binaries.yml for both the GitHub release body
 * and the CHANGELOG.md section, so the two always agree.
 *
 * Usage: bun run scripts/release/release-notes.ts [--range v1.1.6..HEAD]
 */
import { execFileSync } from 'node:child_process'

export type Commit = { subject: string; hash: string }

/**
 * Zero-width space inserted after every '@' so literal mentions in a subject
 * ("@opentelemetry") don't trigger GitHub's own auto "Contributors" strip on the
 * release page. Invisible in rendered notes and in CHANGELOG.md.
 */
const ZWSP = '\u200b'

const SECTIONS = [
  { key: 'breaking', title: '💥 Breaking Changes' },
  { key: 'feat', title: '✨ Features' },
  { key: 'fix', title: '🐛 Bug Fixes' },
  { key: 'perf', title: '⚡ Performance' },
  { key: 'refactor', title: '♻️ Refactoring' },
  { key: 'deps', title: '📦 Dependencies' },
  { key: 'ci', title: '👷 CI/CD' },
  { key: 'docs', title: '📚 Documentation' },
  { key: 'test', title: '🧪 Tests' },
  { key: 'misc', title: '🔧 Miscellaneous' },
] as const

export type SectionKey = (typeof SECTIONS)[number]['key']

const TYPE_TO_SECTION: Record<string, SectionKey> = {
  feat: 'feat',
  feature: 'feat',
  fix: 'fix',
  bugfix: 'fix',
  perf: 'perf',
  refactor: 'refactor',
  ci: 'ci',
  build: 'ci',
  docs: 'docs',
  doc: 'docs',
  test: 'test',
  tests: 'test',
  chore: 'misc',
  style: 'misc',
  revert: 'misc',
}

/** `chore(release):`/`chore(changelog):` commits are the bot's own bookkeeping. */
const BOOKKEEPING_SCOPES = new Set(['release', 'changelog'])

const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?:\s/i

/**
 * Picks the section a commit subject belongs to, or `null` when the commit is
 * release bookkeeping that shouldn't appear in the notes at all.
 */
export function classify(subject: string): SectionKey | null {
  const m = HEADER.exec(subject)
  if (!m?.groups) return 'misc'
  const type = m.groups.type.toLowerCase()
  const scopes = (m.groups.scope ?? '')
    .toLowerCase()
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  if (type === 'chore' && scopes.some(s => BOOKKEEPING_SCOPES.has(s))) return null
  if (m.groups.breaking) return 'breaking'
  // Dependabot writes chore(deps)/build(deps-dev)/…; group them all as deps.
  if (scopes.some(s => s === 'dependencies' || s === 'deps' || s.startsWith('deps-')))
    return 'deps'
  return TYPE_TO_SECTION[type] ?? 'misc'
}

export function groupCommits(commits: Commit[]): Map<SectionKey, Commit[]> {
  const groups = new Map<SectionKey, Commit[]>()
  for (const commit of commits) {
    const key = classify(commit.subject)
    if (!key) continue
    const bucket = groups.get(key)
    if (bucket) bucket.push(commit)
    else groups.set(key, [commit])
  }
  return groups
}

export function renderNotes(commits: Commit[]): string {
  const groups = groupCommits(commits)
  const out: string[] = []
  for (const section of SECTIONS) {
    const bucket = groups.get(section.key)
    if (!bucket?.length) continue
    out.push(`### ${section.title}`, '')
    for (const { subject, hash } of bucket) {
      out.push(`- ${subject.replaceAll('@', `@${ZWSP}`)} (${hash})`)
    }
    out.push('')
  }
  if (!out.length) return '_No user-facing commits since previous tag._'
  return out.join('\n').trimEnd()
}

export function readCommits(range: string): Commit[] {
  const args = ['log', '--no-merges', '--pretty=%h%x00%s']
  if (range) args.splice(1, 0, range)
  const raw = execFileSync('git', args, { encoding: 'utf-8' })
  return raw
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [hash, ...rest] = line.split('\0')
      return { hash, subject: rest.join('\0') }
    })
}

if (import.meta.main) {
  const idx = process.argv.indexOf('--range')
  const range = idx === -1 ? '' : (process.argv[idx + 1] ?? '')
  console.log(renderNotes(readCommits(range)))
}
