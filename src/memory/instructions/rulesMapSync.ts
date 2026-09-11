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
 *    annotations keyed by their full path. It carries {@link MAP_MARKER} to say
 *    so. We only restructure files we wrote.
 *
 * Both modes are subject to the same drift tolerance, and that is what makes
 * running this at every session start free: a count inside tolerance is carried
 * over verbatim, so an unchanged structure re-renders byte-identical and no
 * write happens. Regeneration without that carry-over rewrote the file on every
 * single added file, which is the opposite of the intended cost.
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
  TREE_ANNOTATION_RE,
} from 'src/memory/instructions/rulesClaims.js'

/** Marks a map as generated, and therefore safe to restructure. */
export const MAP_MARKER = '<!-- claudin:module-map -->'

/** Directories holding fewer source files than this are noise in a map. */
const MIN_DIR_FILES = 3
/** The depth a generated tree always reaches, budget or not. */
const MIN_DEPTH = 2
/** How deep it may reach when there are lines left to spend. */
const MAX_DEPTH = 4
/**
 * Entries a generated tree may hold before it stops descending.
 *
 * The file is `paths:`-scoped, so every line is re-read on every matching edit
 * for the life of the project. Drawing this repo's own tree three levels deep
 * costs 216 lines against 26 for two — past some width a map stops orienting
 * anyone and just bills them, and the depth that fits is the honest answer.
 */
const MAX_TREE_ENTRIES = 80
/** The column the `←` annotations line up on, unless a line needs more. */
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

/** `src/tools/` → `tools/`, the token as it appears in the tree line. */
function lastSegment(dirPath: string): string {
  const trimmed = dirPath.replace(/\/$/, '')
  return `${trimmed.slice(trimmed.lastIndexOf('/') + 1)}/`
}

/**
 * Rewrites a number inside a tree line while keeping the annotation column
 * where it was. A count that grows eats the padding after it; one that shrinks
 * gives padding back — so healing `(140)` to `(20)` does not shear the `←` off
 * every line below it in the diff.
 *
 * The search starts at the token the count belongs to and never crosses into
 * the annotation: `indexOf` alone rewrote the first `(5)` on
 * `├── a/ (5)  ← mirrors b/ (5)`, which both healed the wrong number and left
 * the real claim to be re-reported on every later run.
 */
function replaceCount(
  line: string,
  token: string,
  claimed: number,
  actual: number,
): string {
  const entry = line.split(TREE_ANNOTATION_RE)[0] ?? line
  const tokenAt = entry.indexOf(token)
  const from = `(${claimed})`
  const at = line.indexOf(from, tokenAt === -1 ? 0 : tokenAt + token.length)
  if (at === -1 || at >= entry.length) return line
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
    // A directory that now holds nothing has died or moved, and where its
    // replacement belongs in a curated tree is judgment. Healing it to `(0)`
    // would launder that into a number nobody reads twice, so it is left for
    // the verifier to report as a dead path.
    if (actual === 0) continue
    if (!dirCountDrifted(claim.claimed, actual)) continue
    countEdits.push({ lineNumber: claim.lineNumber, path: claim.path, actual })
    const index = claim.lineNumber - 1
    const line = lines[index]
    if (line !== undefined) {
      lines[index] = replaceCount(
        line,
        lastSegment(claim.path),
        claim.claimed,
        actual,
      )
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

/** The directories one level under `parent` that are worth a line, sorted. */
function childDirectories(
  counts: ReadonlyMap<string, number>,
  parent: string,
  depth: number,
): string[] {
  const segments = depth + 2
  return [...counts.keys()]
    .filter(dir => dir.startsWith(parent) && dir.split('/').length === segments)
    .filter(dir => (counts.get(dir) ?? 0) >= MIN_DIR_FILES)
    .sort()
}

/**
 * A directory to draw, with the "was last of its siblings" flag of every level
 * from the root down to it. That trail is the whole of what the box-drawing
 * needs: a level whose entry was last has no more siblings to connect to, so
 * its column is blank rather than a continuation bar.
 */
type TreeEntry = { path: string; trail: boolean[] }

/** Every directory a tree of `maxDepth` would name, in render order. */
function treeEntries(
  counts: ReadonlyMap<string, number>,
  maxDepth: number,
): TreeEntry[] {
  const entries: TreeEntry[] = []
  const walk = (parent: string, depth: number, trail: boolean[]): void => {
    const children = childDirectories(counts, parent, depth)
    children.forEach((child, index) => {
      const next = [...trail, index === children.length - 1]
      entries.push({ path: child, trail: next })
      if (depth + 1 < maxDepth) walk(child, depth + 1, next)
    })
  }
  walk('', 0, [])
  return entries
}

/**
 * How deep to draw: as deep as the budget allows, and never shallower than the
 * map already is.
 *
 * The floor is what keeps a regenerate from gutting a tree somebody annotated.
 * A repo that grows past the budget keeps the depth it had — dropping a level
 * would take every `←` on it along, and a stale map beats a map missing the
 * only part a human wrote.
 */
function chooseDepth(
  counts: ReadonlyMap<string, number>,
  floorDepth: number,
): number {
  const floor = Math.min(Math.max(floorDepth, MIN_DEPTH), MAX_DEPTH)
  let chosen = floor
  for (let depth = floor + 1; depth <= MAX_DEPTH; depth++) {
    if (treeEntries(counts, depth).length > MAX_TREE_ENTRIES) break
    chosen = depth
  }
  return chosen
}

/** How deep the tree in a file already goes, so a regenerate cannot shallow it. */
function existingTreeDepth(content: string): number {
  let deepest = MIN_DEPTH
  for (const claim of extractRuleClaims(content).dirCounts) {
    const depth = claim.path.split('/').filter(Boolean).length
    if (depth > deepest) deepest = depth
  }
  return deepest
}

/**
 * The `←` gloss already written for each path, so it survives a regenerate.
 *
 * Keyed by the FULL path the tree parser reconstructs, not by the bare
 * directory name printed on the line: `src/ui/` and `app/ui/` are both written
 * `ui/`, so a name-keyed map gave whichever came second the other's annotation.
 */
export function existingAnnotations(content: string): Map<string, string> {
  const annotations = new Map<string, string>()
  for (const claim of extractRuleClaims(content).dirCounts) {
    const gloss = claim.line.split(TREE_ANNOTATION_RE)[1]?.trim()
    if (gloss !== undefined && gloss.length > 0) {
      annotations.set(claim.path, gloss)
    }
  }
  return annotations
}

/** The entry side of a tree line: the connectors, the name and the count. */
function renderEntry(trail: readonly boolean[], label: string): string {
  const prefix = trail
    .slice(0, -1)
    .map(ancestorWasLast => (ancestorWasLast ? '    ' : '│   '))
    .join('')
  const isLast = trail[trail.length - 1] === true
  return `${prefix}${isLast ? '└──' : '├──'} ${label}`
}

/**
 * Renders the tree of a repo: every source directory down to the depth the
 * budget affords, skipping the ones too small to be worth naming.
 *
 * Alphabetical on purpose. Ranking by size reads better once and then churns
 * the diff every time two directories trade places, which is exactly the noise
 * that gets an auto-updating file reverted.
 *
 * The `←` column is widened past {@link ANNOTATION_COLUMN} only when a line
 * needs it, so deepening a tree cannot shear the annotations off a level that
 * already fitted.
 */
export function renderModuleTree(
  trackedFiles: readonly string[],
  annotations: ReadonlyMap<string, string> = new Map(),
  retained: ReadonlyMap<string, number> = new Map(),
  floorDepth: number = MIN_DEPTH,
): string[] {
  const extensions = dominantSourceExtensions(trackedFiles)
  const counts = directoryCounts(trackedFiles, extensions)
  const shown = (dir: string): number =>
    retained.get(dir) ?? counts.get(dir) ?? 0

  const entries = treeEntries(counts, chooseDepth(counts, floorDepth))
  const bodies = entries.map(({ path, trail }) =>
    renderEntry(trail, `${lastSegment(path)} (${shown(path)})`),
  )
  const column = bodies.reduce(
    (widest, body) => Math.max(widest, body.length + 2),
    ANNOTATION_COLUMN,
  )

  return entries.map(({ path }, index) => {
    const body = bodies[index] ?? ''
    const padding = ' '.repeat(Math.max(1, column - body.length))
    return `${body}${padding}← ${annotations.get(path) ?? TODO_ANNOTATION}`
  })
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
/**
 * Whether this repo's code groups into directories worth drawing.
 *
 * A flat repo — every source file at the root, or spread across directories
 * below `MIN_DIR_FILES` — renders an empty fence. The surrounding prose still
 * promises a tree and the generated `paths:` still pulls the file into context
 * on every matching edit, so writing one costs a tracked file in somebody's
 * repo and buys nothing. This gates only the two generating paths: a
 * hand-written map in a flat repo may well carry counts worth keeping true, and
 * healing it is still numbers-only.
 */
function hasRenderableTree(trackedFiles: readonly string[]): boolean {
  return renderModuleTree(trackedFiles).length > 0
}

export function syncRuleMap(input: RuleMapSyncInput): string | null {
  const { content, trackedFiles } = input
  if (trackedFiles.length === 0) return null

  if (content.trim().length === 0) {
    return hasRenderableTree(trackedFiles) ? generateRuleMap(trackedFiles) : null
  }

  if (content.includes(MAP_MARKER)) {
    // Gutting a map we wrote is worse than leaving it stale: the fence is where
    // the annotations live, and emptying it discards every one of them.
    if (!hasRenderableTree(trackedFiles)) return null
    const regenerated = regenerateGeneratedMap(content, trackedFiles)
    return regenerated === content ? null : regenerated
  }

  const healed = healRuleMap(input)
  return healed === content ? null : healed
}

/**
 * The fence holding the tree — not merely the first fence in the file.
 *
 * The file invites hand-editing, so a prose example above the tree is expected;
 * targeting the first fence overwrote whatever that example was with the tree.
 */
function findTreeFence(
  lines: readonly string[],
): { open: number; close: number } | null {
  let open = -1
  for (let index = 0; index < lines.length; index++) {
    if (!/^\s*```/.test(lines[index] ?? '')) continue
    if (open === -1) {
      open = index
      continue
    }
    if (lines.slice(open + 1, index).some(line => /├──|└──/.test(line))) {
      return { open, close: index }
    }
    open = -1
  }
  return null
}

/**
 * The counts to carry over verbatim: every one still inside the tolerance.
 *
 * Without this a regenerate emits exact numbers, so one added file rewrites the
 * map — and since this runs at session start, that is a write and a notice on
 * essentially every session in a repo under development.
 */
function countsToRetain(
  content: string,
  trackedFiles: readonly string[],
): Map<string, number> {
  const extensions = dominantSourceExtensions(trackedFiles)
  const retained = new Map<string, number>()
  for (const claim of extractRuleClaims(content).dirCounts) {
    const actual = countTrackedSources(trackedFiles, claim.path, extensions)
    if (!dirCountDrifted(claim.claimed, actual)) {
      retained.set(claim.path, claim.claimed)
    }
  }
  return retained
}

/** Rewrites the fenced tree of a map this module wrote, keeping its prose. */
function regenerateGeneratedMap(
  content: string,
  trackedFiles: readonly string[],
): string {
  const lines = content.split('\n')
  const fence = findTreeFence(lines)
  if (fence === null) return content

  const tree = renderModuleTree(
    trackedFiles,
    existingAnnotations(content),
    countsToRetain(content, trackedFiles),
    existingTreeDepth(content),
  )
  return [
    ...lines.slice(0, fence.open + 1),
    ...tree,
    ...lines.slice(fence.close),
  ].join('\n')
}
