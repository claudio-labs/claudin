/**
 * Keeps a project's navigation map true, and writes one when there is none.
 *
 * The same grammar `rulesClaims.ts` reads for the verifier is run backwards
 * here: instead of reporting a claim the tree contradicts, rewrite it. That is
 * the whole reason the two live side by side — a healer with its own idea of
 * what the map says would fix things the checker never flagged, and miss things
 * it did.
 *
 * Two modes, and the distinction is deliberate:
 *
 *  - **A hand-written map is healed, never restructured.** Only the numbers move.
 *    Where a new directory belongs in a curated tree, and which siblings share a
 *    line, is judgment — the measured lesson is that a rule which misdirects is
 *    worse than no rule, so a missing or dead directory is left for the verifier
 *    to report and a human to place.
 *  - **A map this module generated is regenerated whole**, preserving the
 *    annotations keyed by path. It carries {@link MAP_MARKER} to say so. We only
 *    restructure files we wrote.
 *
 * Pure: string in, string out. All I/O and every gate live at the call site.
 */
import {
  countTrackedSources,
  dirCountDrifted,
  dominantSourceExtensions,
  extractRuleClaims,
  lineCountDrifted,
  resolveUniqueBasename,
} from 'src/memory/instructions/rulesClaims.js'

/** Marks a map as generated, and therefore safe to restructure. */
export const MAP_MARKER = '<!-- claudin:module-map -->'

/** Directories holding fewer source files than this are noise in a map. */
const MIN_DIR_FILES = 3
/** How deep the generated tree goes below the repo root. */
const MAX_DEPTH = 2
/** The column the `←` annotations line up on. */
const ANNOTATION_COLUMN = 34
/** What a generated entry says until someone explains the directory. */
const TODO_ANNOTATION = 'TODO'

export type RuleMapSyncInput = {
  /** Current rule file content. Empty string means "there is no map yet". */
  content: string
  /** Tracked files, repo-relative — `git ls-files` output. */
  trackedFiles: readonly string[]
  /** Lines each tracked file holds, for size claims. Absent → sizes untouched. */
  fileLines?: ReadonlyMap<string, number>
}

/** A `dir/ (N)` occurrence located precisely enough to rewrite in place. */
type CountEdit = { lineNumber: number; path: string; actual: number }

/**
 * Rewrites a number inside a tree line while keeping the annotation column
 * where it was. A count that grows eats the padding after it; one that shrinks
 * gives padding back — so healing `(140)` to `(20)` does not shear the `←` off
 * every line below it in the diff.
 */
function replaceCount(line: string, claimed: number, actual: number): string {
  const from = `(${claimed})`
  const at = line.indexOf(from)
  if (at === -1) return line
  const to = `(${actual})`
  const delta = to.length - from.length
  const head = line.slice(0, at) + to
  let tail = line.slice(at + from.length)

  if (delta > 0) {
    const trimmable = /^ {2,}/.exec(tail)?.[0].length ?? 0
    tail = tail.slice(Math.min(delta, Math.max(0, trimmable - 1)))
  } else if (delta < 0 && /^ /.test(tail)) {
    tail = ' '.repeat(-delta) + tail
  }
  return head + tail
}

/** Rewrites a `~N lines` claim, matching the form it was written in. */
function replaceLineCount(
  line: string,
  claimed: number,
  actual: number,
): string {
  const pattern = new RegExp(
    `~?(?:${claimed.toLocaleString('en-US')}|${claimed}|${claimed / 1000}k)([-\\s])(lines?)\\b`,
  )
  return line.replace(
    pattern,
    (_match, sep: string, word: string) =>
      `${actual.toLocaleString('en-US')}${sep}${word}`,
  )
}

/**
 * Heals the numbers a map states, leaving every other byte alone.
 *
 * Returns the content unchanged when nothing drifted past the tolerance, which
 * is what makes running this on every session start free: a repo that gained
 * two files produces no write at all.
 */
export function healRuleMap(input: RuleMapSyncInput): string {
  const { content, trackedFiles, fileLines } = input
  const extensions = dominantSourceExtensions(trackedFiles)
  const claims = extractRuleClaims(content)
  const lines = content.split('\n')

  const countEdits: CountEdit[] = []
  for (const claim of claims.dirCounts) {
    const actual = countTrackedSources(trackedFiles, claim.path, extensions)
    if (!dirCountDrifted(claim.claimed, actual)) continue
    countEdits.push({ lineNumber: claim.lineNumber, path: claim.path, actual })
    const index = claim.lineNumber - 1
    const line = lines[index]
    if (line !== undefined) {
      lines[index] = replaceCount(line, claim.claimed, actual)
    }
  }

  if (fileLines) {
    for (const claim of claims.lineCounts) {
      const resolved = resolveUniqueBasename(trackedFiles, claim.file)
      if (resolved === null) continue
      const actual = fileLines.get(resolved)
      if (actual === undefined || !lineCountDrifted(claim.claimed, actual)) {
        continue
      }
      const index = claim.lineNumber - 1
      const line = lines[index]
      if (line !== undefined) {
        lines[index] = replaceLineCount(line, claim.claimed, actual)
      }
    }
  }

  return countEdits.length === 0 && lines.join('\n') === content
    ? content
    : lines.join('\n')
}

/** Directory → source-file count, for every directory down to MAX_DEPTH. */
function directoryCounts(
  trackedFiles: readonly string[],
  extensions: readonly string[],
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const file of trackedFiles) {
    if (!extensions.some(extension => file.endsWith(extension))) continue
    const segments = file.split('/')
    for (let depth = 1; depth <= Math.min(MAX_DEPTH, segments.length - 1); depth++) {
      const dir = `${segments.slice(0, depth).join('/')}/`
      counts.set(dir, (counts.get(dir) ?? 0) + 1)
    }
  }
  return counts
}

/** The `←` gloss already written for each path, so it survives a regenerate. */
export function existingAnnotations(content: string): Map<string, string> {
  const annotations = new Map<string, string>()
  for (const line of content.split('\n')) {
    const marker = /\s(?:←|<-)\s*(.*)$/.exec(line)
    if (!marker?.[1]) continue
    const entry = /(?:├──|└──)\s*([\w.@-]+\/)/.exec(line)
    const name = entry?.[1]
    if (name === undefined) continue
    annotations.set(name, marker[1].trim())
  }
  return annotations
}

function renderEntry(
  isLast: boolean,
  depth: number,
  label: string,
  annotation: string,
): string {
  const indent = depth === 1 ? '' : '│   '.repeat(depth - 1)
  const body = `${indent}${isLast ? '└──' : '├──'} ${label}`
  const padding = ' '.repeat(Math.max(1, ANNOTATION_COLUMN - body.length))
  return `${body}${padding}← ${annotation}`
}

/**
 * Renders the tree of a repo: its top-level source directories, and the
 * immediate children of each that hold enough files to be worth naming.
 *
 * Alphabetical on purpose. Ranking by size reads better once and then churns
 * the diff every time two directories trade places, which is exactly the noise
 * that gets an auto-updating file reverted.
 */
export function renderModuleTree(
  trackedFiles: readonly string[],
  annotations: ReadonlyMap<string, string> = new Map(),
): string[] {
  const extensions = dominantSourceExtensions(trackedFiles)
  const counts = directoryCounts(trackedFiles, extensions)

  const tops = [...counts.keys()]
    .filter(dir => dir.split('/').length === 2)
    .filter(dir => (counts.get(dir) ?? 0) >= MIN_DIR_FILES)
    .sort()

  const lines: string[] = []
  tops.forEach((top, topIndex) => {
    const isLastTop = topIndex === tops.length - 1
    const name = top
    lines.push(
      renderEntry(
        isLastTop,
        1,
        `${name}(${counts.get(top) ?? 0})`.replace('/(', '/ ('),
        annotations.get(name) ?? TODO_ANNOTATION,
      ),
    )

    const children = [...counts.keys()]
      .filter(dir => dir.startsWith(top) && dir.split('/').length === 3)
      .filter(dir => (counts.get(dir) ?? 0) >= MIN_DIR_FILES)
      .sort()

    children.forEach((child, childIndex) => {
      const childName = `${child.split('/')[1]}/`
      const label = `${childName}(${counts.get(child) ?? 0})`.replace(
        '/(',
        '/ (',
      )
      const prefix = isLastTop ? '    ' : '│   '
      const connector =
        childIndex === children.length - 1 ? '└──' : '├──'
      const body = `${prefix}${connector} ${label}`
      const padding = ' '.repeat(Math.max(1, ANNOTATION_COLUMN - body.length))
      lines.push(
        `${body}${padding}← ${annotations.get(childName) ?? TODO_ANNOTATION}`,
      )
    })
  })
  return lines
}

/** The `paths:` frontmatter that scopes a map to the code it describes. */
export function scopePatterns(trackedFiles: readonly string[]): string[] {
  const extensions = dominantSourceExtensions(trackedFiles)
  if (extensions.length === 0) return ['**/*']
  return extensions.map(extension => `**/*${extension}`)
}

/**
 * Writes a map for a project that has none.
 *
 * Every statement in the output is one the verifier re-derives from
 * `git ls-files`, and the annotations are left as `TODO` rather than guessed.
 * That is what separates this from the two generators this project measured and
 * rejected: it asserts no purpose, so it cannot assert a wrong one.
 */
export function generateRuleMap(trackedFiles: readonly string[]): string {
  const patterns = scopePatterns(trackedFiles)
  const tree = renderModuleTree(trackedFiles)
  return [
    '---',
    'paths:',
    ...patterns.map(pattern => `  - "${pattern}"`),
    '---',
    `${MAP_MARKER}`,
    '# Module Map',
    '',
    'Generated from the tracked file list, and meant to be edited by hand. The',
    'structure and the `(N)` counts are kept current automatically; the `←`',
    'annotations are not — replace each `TODO` with what the directory is for,',
    'and that text will survive every later refresh.',
    '',
    '```',
    ...tree,
    '```',
    '',
  ].join('\n')
}

/**
 * The content a project's map should have, or null when it already has it.
 *
 * Null is the common case and the reason this is cheap enough to run at every
 * session start.
 */
export function syncRuleMap(input: RuleMapSyncInput): string | null {
  const { content, trackedFiles } = input
  if (trackedFiles.length === 0) return null

  if (content.trim().length === 0) {
    return generateRuleMap(trackedFiles)
  }

  if (content.includes(MAP_MARKER)) {
    const regenerated = regenerateGeneratedMap(content, trackedFiles)
    return regenerated === content ? null : regenerated
  }

  const healed = healRuleMap(input)
  return healed === content ? null : healed
}

/** Rewrites the fenced tree of a map this module wrote, keeping its prose. */
function regenerateGeneratedMap(
  content: string,
  trackedFiles: readonly string[],
): string {
  const lines = content.split('\n')
  const open = lines.findIndex(line => line.trim() === '```')
  if (open === -1) return content
  const close = lines.findIndex(
    (line, index) => index > open && line.trim() === '```',
  )
  if (close === -1) return content

  const tree = renderModuleTree(trackedFiles, existingAnnotations(content))
  return [
    ...lines.slice(0, open + 1),
    ...tree,
    ...lines.slice(close),
  ].join('\n')
}
