import { readFileSync } from 'fs'
import { basename, dirname, extname, join, relative, resolve } from 'path'
import {
  MEMORY_TYPES,
  type MemoryType,
  parseMemoryType,
  type TeamCategory,
  teamCategoryForPath,
  TYPE_SCOPES,
} from 'src/memory/memdir/memoryTypes.js'
import {
  findMemoryDir,
  getMemoryDirs,
  type MemoryDir,
} from 'src/memory/memdir/memoryDirs.js'
import {
  ENTRYPOINT_NAME,
  MEMORY_SCOPE_SPECS,
  type MemoryScope,
} from 'src/memory/memdir/memoryScopes.js'
import { isENOENT } from 'src/shared/errors.js'
import { FRONTMATTER_REGEX, parseFrontmatter } from 'src/shared/frontmatterParser.js'
import type { ToolAdvice } from 'src/tools/Tool.js'
import { PATCH_FILE_HEADER_RE, PATCH_MOVE_RE } from 'src/tools/shared/writtenPaths.js'

/*
 * Since 2026-09-29 (team memory `claude-code-2.1.284-wire-diff`) the v2
 * memory section keeps what every request needs and the frontmatter template;
 * the rules only a write needs — links, what each team subdirectory requires,
 * the index line — (teamMemPrompts.ts `buildMemoryWriteRules`) come back from
 * here:
 *
 *  - checkMemoryFileFormat refuses a memory file whose frontmatter misses what
 *    its place requires, and the refusal carries those rules. It sits beside
 *    checkTeamMemSecrets on the four write paths (FileWriteTool, FileEditTool,
 *    applyPatch, stagedWrite), and every one of them hands it the whole file
 *    as it will be — so one file gets one verdict, whichever tool writes it.
 *    Where a type may live is judged only for a file that is new or changes
 *    its type: a memory saved before a rule existed is updated in place.
 *  - memoryIndexAdvice notes, after a Write, a Patch or an Edit that creates
 *    the file, a memory file its directory's `MEMORY.md` does not list yet —
 *    counting what the rest of the same response writes to that index
 *    (indexTextFromResponse).
 *
 * Both apply to every family: another family's prompt states the same rules
 * in full, and the guard asks for nothing it does not.
 *
 * The pure halves (`…In`) take the directories as arguments, so they are
 * tested without the path modules; the wrappers resolve them.
 */

/** The memory directories the guard judges by (memoryDirs.ts getMemoryDirs). */
export type MemoryDirs = readonly MemoryDir[]

function rootOf(dirs: MemoryDirs, scope: MemoryScope): string | null {
  return dirs.find(dir => dir.scope === scope)?.root ?? null
}

/** Extra frontmatter a category requires beyond its `type`, as its TEAM_CATEGORIES text states it. */
type CategoryField = { key: string; what: string; values?: readonly string[] }

/**
 * TEAM_CATEGORIES says these in prose (`lean`, `bodyStructure`);
 * memoryFormatGuard.test.ts holds this table to that text, so the two cannot
 * drift apart silently.
 */
export const CATEGORY_FIELDS: Readonly<Record<TeamCategory['dir'], readonly CategoryField[]>> = {
  decisions: [
    { key: 'scope', what: 'the feature or slice it changes' },
    { key: 'impact', what: 'the kind of decision', values: ['structural', 'functional', 'rejected'] },
  ],
  bugs: [],
  docs: [],
}

/** A file the guard applies to: which memory directory it belongs to, and its category when it is a team one. */
type MemoryFile = {
  abs: string
  scope: MemoryScope
  /** The directory whose `MEMORY.md` indexes it. */
  root: string
  category: TeamCategory | undefined
}

/**
 * The memory file at `filePath`, or null for anything else: a non-`.md`
 * file, an index, a path outside the directories. Its directory is the one
 * findMemoryDir picks. A category applies only to a file directly in its
 * subdirectory of the team dir.
 */
function memoryFileOf(filePath: string, dirs: MemoryDirs): MemoryFile | null {
  const abs = resolve(filePath)
  if (extname(abs) !== '.md' || basename(abs) === ENTRYPOINT_NAME) return null
  const dir = findMemoryDir(dirs, abs)
  if (dir === null) return null
  const category = dir.scope === 'team' ? teamCategoryForPath(abs) : undefined
  return {
    abs,
    scope: dir.scope,
    root: dir.root,
    category: category && dirname(abs) === join(dir.root, category.dir) ? category : undefined,
  }
}

function isFilled(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== ''
}

const TYPE_CHOICES = MEMORY_TYPES.join(' | ')

/** What a memory file already on disk says of itself; null for a file the write creates. */
type Before = { type: MemoryType | undefined; hasPaths: boolean } | null

function beforeOf(abs: string, text: string | null): Before {
  if (text === null) return null
  const { frontmatter } = parseFrontmatter(text, abs)
  return { type: parseMemoryType(frontmatter.type), hasPaths: isFilled(frontmatter.paths) }
}

/**
 * Why `type` may not live where `file` is, or null. Where a type may live is
 * TYPE_SCOPES, quoted in the refusal; a team category takes its own type.
 */
function placementProblem(file: MemoryFile, type: MemoryType, dirs: MemoryDirs): string | null {
  const globalDir = rootOf(dirs, 'global')
  const privateDir = rootOf(dirs, 'private')
  if (TYPE_SCOPES[type].global === 'only' && file.scope !== 'global' && globalDir) {
    return `\`type: ${type}\` is ${TYPE_SCOPES[type].withGlobal} — write it under \`${globalDir}\` instead; if this file was saved here before the global dir existed, move it there with \`mv\` and move its index line (\`/memory sort\` moves them all, if the user runs it)`
  }
  if (TYPE_SCOPES[type].global === 'only' && file.scope === 'team') {
    return `\`type: ${type}\` is ${TYPE_SCOPES[type].withoutGlobal} — write it under \`${privateDir}\` instead`
  }
  if (file.scope === 'global' && TYPE_SCOPES[type].global === 'never') {
    return `\`type: ${type}\` is ${TYPE_SCOPES[type].withGlobal} — write it under \`${privateDir}\` or \`${rootOf(dirs, 'team')}\` instead`
  }
  if (file.category && type !== file.category.type) {
    return `a team ${file.category.noun} memory is \`type: ${file.category.type}\`, not \`${type}\``
  }
  return null
}

/**
 * What the frontmatter of `file` misses, one phrase each; empty when it is
 * complete. Completeness is asked of every write. Placement — the type's
 * directory, and `paths:` where the directory takes none — only of a file
 * that is new or changes its type (`before`), and `paths:` also when the
 * write adds it: a memory saved before a rule existed stays updatable in
 * place, by every tool alike.
 */
function formatProblems(file: MemoryFile, content: string, dirs: MemoryDirs, before: Before): string[] {
  const { frontmatter } = parseFrontmatter(content, file.abs)
  if (Object.keys(frontmatter).length === 0) {
    return [
      FRONTMATTER_REGEX.exec(content)?.[1]?.trim()
        ? 'its frontmatter does not parse — quote a value that holds `: ` or starts with a special character'
        : 'it has no frontmatter — open the file with `---`, `name:`, `description:`, `type:`, `---`',
    ]
  }
  const problems: string[] = []
  for (const key of ['name', 'description']) {
    if (!isFilled(frontmatter[key])) problems.push(`it lacks \`${key}:\``)
  }
  const type = parseMemoryType(frontmatter.type)
  // New, or retyped: where it lives is decided now
  const placed = before === null || before.type !== type
  if (!type) {
    problems.push(
      isFilled(frontmatter.type)
        ? `\`type: ${String(frontmatter.type)}\` is not one of ${TYPE_CHOICES}`
        : `it lacks \`type:\` (${TYPE_CHOICES})`,
    )
  } else if (placed) {
    const misplaced = placementProblem(file, type, dirs)
    if (misplaced) problems.push(misplaced)
  }
  if (
    !MEMORY_SCOPE_SPECS[file.scope].takesPaths &&
    isFilled(frontmatter.paths) &&
    (placed || !before?.hasPaths)
  ) {
    problems.push(`a ${file.scope} memory takes no \`paths:\` — it is not tied to the files of one project`)
  }
  for (const field of file.category ? CATEGORY_FIELDS[file.category.dir] : []) {
    const value = frontmatter[field.key]
    if (!isFilled(value)) {
      problems.push(`it lacks \`${field.key}:\` (${field.values ? field.values.join(' | ') : field.what})`)
    } else if (field.values && !field.values.includes(String(value).trim())) {
      problems.push(`\`${field.key}: ${String(value)}\` is not one of ${field.values.join(' | ')}`)
    }
  }
  return problems
}

/**
 * The write-time rules, as teamMemPrompts.ts renders them. Required on the
 * refusal path only: teamMemPrompts.ts pulls in memdir.ts (and memdir.ts
 * imports it back), and the write tools import this module — the lazy
 * require keeps that graph out of theirs.
 */
function memoryWriteRules(dirs: MemoryDirs): string {
  // Typed via annotation rather than `as`, so knip sees the named require
  // (teamMemSecretGuard.ts has the same shape).
  /* eslint-disable @typescript-eslint/no-require-imports */
  const {
    buildMemoryWriteRules,
  }: typeof import('src/memory/memdir/teamMemPrompts.js') = require('src/memory/memdir/teamMemPrompts.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
  return buildMemoryWriteRules(rootOf(dirs, 'team') ?? '', rootOf(dirs, 'global'))
}

/**
 * The refusal for writing `content` to `filePath`, or null when the file is
 * not a memory file or its frontmatter is complete. The refusal names what is
 * missing and hands back the write-time rules the system prompt leaves out.
 * `existing` returns what the file holds now, or null when the write creates
 * it — asked only of a memory file; the default judges every write as new.
 */
export function checkMemoryFileFormatIn(
  dirs: MemoryDirs,
  filePath: string,
  content: string,
  existing: (abs: string) => string | null = () => null,
): string | null {
  const file = memoryFileOf(filePath, dirs)
  if (!file) return null
  const problems = formatProblems(file, content, dirs, beforeOf(file.abs, existing(file.abs)))
  if (problems.length === 0) return null
  const what = file.category ? `a team ${file.category.noun} memory` : `a ${file.scope} memory`
  const refusal = `Memory file not written: ${file.abs} is ${what}, and ${problems.join('; ')}. Fix the frontmatter and write it again.`
  return `${refusal}\n\nThe rules for memory files:\n\n${memoryWriteRules(dirs)}`
}

/** Markdown link targets: `](target)`, up to the first space or `)`. */
const LINK_TARGET_RE = /\]\(\s*<?([^)\s>]+)/g

/**
 * What the tool calls of one response write into a memory index, by the
 * index's absolute path: a Write's content, an Edit's new_string, the lines a
 * Patch adds. Read by input shape, not tool name, so an alias reads the same;
 * a relative path resolves against `cwd`, as the Patch tool resolves it. The
 * advice asks this of the whole response because the calls after the one it
 * advises have not run yet: a memory file and its index line written side by
 * side are both about to be on disk.
 */
export function indexTextFromResponse(
  toolUses: ReadonlyArray<{ input: unknown }> | undefined,
  cwd: string,
): Map<string, string> {
  const pending = new Map<string, string>()
  const add = (path: string, text: string): void => {
    const abs = resolve(cwd, path)
    if (basename(abs) !== ENTRYPOINT_NAME) return
    pending.set(abs, `${pending.get(abs) ?? ''}\n${text}`)
  }
  for (const { input } of toolUses ?? []) {
    if (!input || typeof input !== 'object') continue
    const fields = input as Record<string, unknown>
    if (typeof fields.patchText === 'string') {
      let current: string | null = null
      for (const line of fields.patchText.split('\n')) {
        const header = PATCH_FILE_HEADER_RE.exec(line)
        const move = PATCH_MOVE_RE.exec(line)
        if (header) current = header[1] === 'Delete' ? null : header[2]!.trim()
        else if (move) current = move[1]!.trim()
        else if (current && line.startsWith('+')) add(current, line.slice(1))
      }
    } else if (typeof fields.file_path === 'string') {
      const text =
        typeof fields.content === 'string'
          ? fields.content
          : typeof fields.new_string === 'string'
            ? fields.new_string
            : null
      if (text !== null) add(fields.file_path, text)
    }
  }
  return pending
}

/** Whether `index` links to `abs`, resolving each link target against the index's directory. */
function indexLinks(index: string, root: string, abs: string): boolean {
  for (const match of index.matchAll(LINK_TARGET_RE)) {
    const target = match[1]!.split('#')[0]!
    if (target && resolve(root, target) === abs) return true
  }
  return false
}

/**
 * The index-line note for a memory file its directory's `MEMORY.md` does not
 * link to yet, or null. `indexText` returns an index's text by path — what a
 * call is about to add to it included — and null for an index that does not
 * exist, which lists nothing.
 */
export function memoryIndexAdviceIn(
  dirs: MemoryDirs,
  filePath: string,
  indexText: (indexPath: string) => string | null,
): ToolAdvice | null {
  const file = memoryFileOf(filePath, dirs)
  if (!file) return null
  const indexPath = join(file.root, ENTRYPOINT_NAME)
  if (indexLinks(indexText(indexPath) ?? '', file.root, file.abs)) return null
  const link = relative(file.root, file.abs)
  const where = file.category
    ? `under the \`## ${file.category.section}\` section of \`${indexPath}\` (create the section if it is not there)`
    : `to \`${indexPath}\``
  return {
    message: `\`${link}\` is not in the ${file.scope} memory index yet: add \`- [Title](${link}) — one-line hook\` (under ~150 chars, no frontmatter, never the memory's content) ${where}. Only the indexes load every session, so a memory they do not list is found only by a search.`,
  }
}

/**
 * Checks a write of `content` — the whole file as it will be — to a memory
 * file. Returns the refusal, or null when the write may go ahead; null for
 * any other file, so callers can call it unconditionally. Call it before the
 * write lands: the file on disk is what says whether it is new or retyped.
 */
export function checkMemoryFileFormat(filePath: string, content: string): string | null {
  return checkMemoryFileFormatIn(getMemoryDirs(), filePath, content, readIfExists)
}

/** A file's text, or null when it does not exist. */
function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (e) {
    if (isENOENT(e)) return null
    throw e
  }
}

/**
 * The index-line note for a write to `filePath`, for a tool's `advise`.
 * `pending` is what the same call adds to an index, keyed by the index's
 * absolute path (a Patch that writes the memory and its index line
 * together).
 */
export function memoryIndexAdvice(
  filePath: string,
  pending?: ReadonlyMap<string, string>,
): ToolAdvice | null {
  return memoryIndexAdviceIn(getMemoryDirs(), filePath, indexPath => {
    const onDisk = readIfExists(indexPath)
    const added = pending?.get(indexPath)
    return added === undefined ? onDisk : `${onDisk ?? ''}\n${added}`
  })
}
