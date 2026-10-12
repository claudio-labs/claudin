/**
 * Health checks for skill files — the `/skill-doctor` counterpart of
 * src/memory/instructions/rulesLint.ts.
 *
 * The skill loader (loadSkillsDir.ts) degrades silently by design: broken
 * YAML becomes `{}`, an unknown key is ignored, `user-invocable: yes` reads as
 * false and hides the skill, a loose `skills/foo.md` is never loaded, and a
 * name that a bundled skill or another skill already took is simply never
 * matched. None of it reaches the user except as "the skill doesn't work".
 * This module re-reads the same files the loader reads and reports each of
 * those outcomes as a finding.
 *
 * Not built on validatePlugin.ts's validateComponentFile: that one parses
 * without the loader's auto-quoting retry, so it would call frontmatter
 * broken that the loader accepts, and it knows none of the skill-only keys.
 *
 * Consumed by the `/skill-doctor` skill (src/skills/bundled/skillDoctor.ts).
 */
import { dirname, join, relative } from 'path'
import { EFFORT_LEVELS, parseEffortValue } from 'src/providers/effort/effort.js'
import { HooksSchema } from 'src/platform/settings/types.js'
import {
  extractDescriptionFromMarkdown,
  getProjectDirsUpToHome,
} from 'src/memory/instructions/markdownConfigLoader.js'
import {
  findSkillMarkdownFiles,
  getRegularCommandName,
  getSkillCommandName,
  isSkillFile,
} from 'src/skills/loadSkillsDir.js'
import { parseYaml } from 'src/shared/data/yaml.js'
import { logForDebugging } from 'src/shared/debug.js'
import { getClaudinConfigHomeDir } from 'src/shared/envUtils.js'
import { getErrnoCode } from 'src/shared/errors.js'
import {
  coerceDescriptionToString,
  FRONTMATTER_REGEX,
  parseBooleanFrontmatter,
  parseFrontmatter,
} from 'src/shared/frontmatterParser.js'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'
import { MAX_LISTING_DESC_CHARS } from 'src/tools/SkillTool/prompt.js'

type SkillLintFindingKind =
  /** Frontmatter does not parse even after the loader's quoting retry. */
  | 'yaml_error'
  /** Parses only because the loader quotes problematic values on retry. */
  | 'yaml_autoquoted'
  /** An unquoted ` #` starts a YAML comment and cuts the value. */
  | 'truncated_value'
  | 'unsupported_key'
  /** A boolean key whose value the loader reads as false. */
  | 'bad_boolean'
  | 'bad_value'
  | 'missing_description'
  /** `description - when_to_use` is cut in the model's skill listing. */
  | 'listing_truncated'
  /** Neither the user nor the model can invoke it. */
  | 'unreachable'
  /** Frontmatter `name` differs from the directory-derived command name. */
  | 'name_mismatch'
  /** A markdown file under `skills/` the loader never reads. */
  | 'ignored_file'
  | 'legacy_command'
  | 'shadows_builtin'
  | 'shadowed_by_bundled'
  | 'duplicate_name'

export type SkillLintFinding = {
  /** Absolute path of the file the finding belongs to. */
  file: string
  kind: SkillLintFindingKind
  severity: 'error' | 'warning'
  message: string
  fix: string
  /** 1-based line in the file, when the finding points at one. */
  line?: number
}

type SkillScope = 'user' | 'project'

/** What the loader would make of one skill file. */
type SkillLintEntry = {
  /** The name it is invoked by: `/name`, and `skill` in the Skill tool. */
  name: string
  file: string
  scope: SkillScope
  /** Loaded from the deprecated `commands/` directory. */
  legacy: boolean
  /** As the listing shows it: frontmatter, or the first body line. */
  description: string
  hasDescription: boolean
  whenToUse: string | undefined
  modelInvocable: boolean
  userInvocable: boolean
  /** Has `paths:` — listed only once a matching file is touched. */
  conditional: boolean
  mtimeMs: number
}

export type SkillLintResult = {
  findings: SkillLintFinding[]
  /** In the loader's precedence order: the first of a name is the one that runs. */
  skills: SkillLintEntry[]
  filesChecked: number
}

export type LintSkillFilesOptions = {
  /** Project directory. Defaults to the fs implementation's cwd. */
  root?: string
  /** Where `skills/` and `commands/` of the user scope live. Defaults to ~/.claudin. */
  configHome?: string
  /** Built-in slash command names and aliases (commands.ts builtInCommandNames). */
  builtinNames?: ReadonlySet<string>
  /** Bundled skill names; they are matched before any skill on disk. */
  bundledNames?: ReadonlySet<string>
  /** Per-entry cap of the model's skill listing. Defaults to MAX_LISTING_DESC_CHARS. */
  listingCap?: number
}

/** Every key parseSkillFrontmatterFields and parseSkillPaths read. */
const SUPPORTED_KEYS = new Set([
  'name',
  'description',
  'when_to_use',
  'allowed-tools',
  'argument-hint',
  'arguments',
  'disable-model-invocation',
  'user-invocable',
  'model',
  'effort',
  'context',
  'agent',
  'paths',
  'hooks',
  'version',
  'shell',
])

/**
 * Keys from the open Agent Skills format. Ignored by the loader, but a skill
 * imported from that ecosystem carries them on purpose — flagging them is noise.
 */
const FOREIGN_STANDARD_KEYS = new Set(['license', 'metadata', 'compatibility'])

/** The spellings people actually write, from other tools and from camelCase habit. */
const KEY_SUGGESTIONS: Record<string, string> = {
  whenToUse: 'when_to_use',
  'when-to-use': 'when_to_use',
  allowedTools: 'allowed-tools',
  allowed_tools: 'allowed-tools',
  tools: 'allowed-tools',
  argumentHint: 'argument-hint',
  argument_hint: 'argument-hint',
  disableModelInvocation: 'disable-model-invocation',
  disable_model_invocation: 'disable-model-invocation',
  userInvocable: 'user-invocable',
  user_invocable: 'user-invocable',
  globs: 'paths',
}

/** Plain-scalar keys whose value a ` #` would silently cut. */
const TRUNCATABLE_KEYS = new Set(['description', 'when_to_use', 'argument-hint'])

const TOP_LEVEL_KEY_LINE_RE = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/
const YAML_COMMENT_RE = /\s#/
const QUOTED_OR_BLOCK_RE = /^["'|>]/
const MD_EXTENSION_RE = /\.md$/

const FRONTMATTER_SHELLS = ['bash', 'powershell']

/** Recursively collects `.md` files under a directory. Missing dir → []. */
async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const fs = getFsImplementation()
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(dir)
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') {
      return []
    }
    throw e
  }

  const files: string[] = []
  for (const entry of entries) {
    const entryPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(entryPath)))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(entryPath)
    }
  }
  return files.sort()
}

type Candidate = {
  file: string
  name: string
  scope: SkillScope
  legacy: boolean
}

type Discovery = {
  candidates: Candidate[]
  /** Markdown under a `skills/` directory (`dir`) that the loader never reads. */
  ignored: { file: string; dir: string }[]
}

/**
 * The files the loader reads, in its precedence order (user skills, project
 * skills nearest-first, then legacy commands), plus the markdown under
 * `skills/` it never reads.
 */
async function discoverSkillFiles(
  root: string,
  configHome: string,
): Promise<Discovery> {
  const candidates: Candidate[] = []
  const ignored: Discovery['ignored'] = []

  const skillDirs: { dir: string; scope: SkillScope }[] = [
    { dir: join(configHome, 'skills'), scope: 'user' },
    ...getProjectDirsUpToHome('skills', root).map(dir => ({
      dir,
      scope: 'project' as const,
    })),
  ]
  for (const { dir, scope } of skillDirs) {
    const skillFiles = await findSkillMarkdownFiles(dir)
    for (const file of skillFiles) {
      candidates.push({ file, name: getSkillCommandName(file, dir), scope, legacy: false })
    }
    // A sibling of a SKILL.md, or anything under its directory, is reference
    // material the skill reads on demand. Anything else was meant as a skill.
    const skillDirsSet = new Set(skillFiles.map(f => dirname(f)))
    for (const file of await collectMarkdownFiles(dir)) {
      if (isSkillFile(file)) continue
      let current = dirname(file)
      let ownedBySkill = false
      while (current.length > dir.length) {
        if (skillDirsSet.has(current)) {
          ownedBySkill = true
          break
        }
        current = dirname(current)
      }
      if (!ownedBySkill) ignored.push({ file, dir })
    }
  }

  const commandDirs: { dir: string; scope: SkillScope }[] = [
    { dir: join(configHome, 'commands'), scope: 'user' },
    ...getProjectDirsUpToHome('commands', root).map(dir => ({
      dir,
      scope: 'project' as const,
    })),
  ]
  for (const { dir, scope } of commandDirs) {
    const files = await collectMarkdownFiles(dir)
    // transformSkillFiles: a directory with a SKILL.md contributes only that.
    const dirsWithSkill = new Set(files.filter(isSkillFile).map(f => dirname(f)))
    for (const file of files) {
      const skill = isSkillFile(file)
      if (!skill && dirsWithSkill.has(dirname(file))) continue
      candidates.push({
        file,
        name: skill ? getSkillCommandName(file, dir) : getRegularCommandName(file, dir),
        scope,
        legacy: true,
      })
    }
  }

  return { candidates, ignored }
}

function show(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function isStringOrStringList(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    (Array.isArray(value) && value.every(item => typeof item === 'string'))
  )
}

/**
 * Parses frontmatter the way the loader does and reports what it loses on
 * the way. Returns the frontmatter the loader ends up with.
 */
function checkYaml(
  file: string,
  raw: string,
  findings: SkillLintFinding[],
): Record<string, unknown> {
  const match = raw.match(FRONTMATTER_REGEX)
  if (!match) return {}
  const text = match[1] ?? ''

  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch (e: unknown) {
    const recovered = parseFrontmatter(raw).frontmatter
    if (Object.keys(recovered).length === 0) {
      findings.push({
        file,
        kind: 'yaml_error',
        severity: 'error',
        line: 1,
        message: `frontmatter is not valid YAML (${e instanceof Error ? e.message.split('\n')[0] : String(e)}), so the loader drops every key — description, user-invocable and the rest`,
        fix: 'Fix the YAML. Quoting a value that contains `: ` or ` #` is the usual cure.',
      })
      return {}
    }
    findings.push({
      file,
      kind: 'yaml_autoquoted',
      severity: 'warning',
      line: 1,
      message: 'frontmatter is not valid YAML as written; it loads only because the loader retries with problem values quoted',
      fix: 'Quote the values that contain `: ` (or other YAML syntax) so the file parses on its own.',
    })
    return recovered as Record<string, unknown>
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    if (parsed !== null && parsed !== undefined) {
      findings.push({
        file,
        kind: 'yaml_error',
        severity: 'error',
        line: 1,
        message: 'frontmatter is not a YAML mapping (`key: value` lines), so the loader ignores all of it',
        fix: 'Write the frontmatter as `key: value` lines.',
      })
    }
    return {}
  }
  const frontmatter = parsed as Record<string, unknown>

  // `#` after whitespace starts a YAML comment, so `description: fix #242`
  // parses — as "fix". Only the raw line shows what was meant.
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const keyLine = TOP_LEVEL_KEY_LINE_RE.exec(lines[i]!)
    if (!keyLine) continue
    const [, key, value] = keyLine as unknown as [string, string, string]
    if (!TRUNCATABLE_KEYS.has(key)) continue
    if (QUOTED_OR_BLOCK_RE.test(value) || !YAML_COMMENT_RE.test(value)) continue
    findings.push({
      file,
      kind: 'truncated_value',
      severity: 'warning',
      line: i + 2,
      message: `\`${key}\` stops at " #": YAML reads the rest as a comment, so the loader sees ${JSON.stringify(show(frontmatter[key] ?? ''))}`,
      fix: 'Quote the whole value, or drop the `#` ("PR 242" instead of "#242").',
    })
  }

  return frontmatter
}

function checkFrontmatter(
  candidate: Candidate,
  raw: string,
  mtimeMs: number,
  listingCap: number,
  findings: SkillLintFinding[],
): SkillLintEntry {
  const { file, name } = candidate
  const frontmatter = checkYaml(file, raw, findings)
  const body = parseFrontmatter(raw).content

  for (const key of Object.keys(frontmatter)) {
    if (SUPPORTED_KEYS.has(key) || FOREIGN_STANDARD_KEYS.has(key)) continue
    const suggestion = KEY_SUGGESTIONS[key]
    findings.push({
      file,
      kind: 'unsupported_key',
      severity: 'warning',
      message: `\`${key}\` is not a skill frontmatter key, so it is ignored`,
      fix: suggestion
        ? `Rename it to \`${suggestion}\`.`
        : 'Remove it, or move what it says into the body if the model should see it.',
    })
  }

  for (const key of ['user-invocable', 'disable-model-invocation']) {
    const value = frontmatter[key]
    if (value === undefined || value === true || value === false) continue
    if (value === 'true' || value === 'false') continue
    findings.push({
      file,
      kind: 'bad_boolean',
      severity: 'error',
      message:
        key === 'user-invocable'
          ? `\`user-invocable: ${show(value)}\` is read as false — the skill is hidden from the / menu`
          : `\`disable-model-invocation: ${show(value)}\` is read as false — the model can still invoke it`,
      fix: 'Write `true` or `false`; nothing else is read as true.',
    })
  }

  if (
    frontmatter.description !== undefined &&
    frontmatter.description !== null &&
    typeof frontmatter.description === 'object'
  ) {
    findings.push({
      file,
      kind: 'bad_value',
      severity: 'error',
      message: '`description` is a list or a map, so the loader drops it and falls back to the first body line',
      fix: 'Write `description` as a single string.',
    })
  }
  if (frontmatter.context !== undefined && frontmatter.context !== 'fork') {
    findings.push({
      file,
      kind: 'bad_value',
      severity: 'warning',
      message: `\`context: ${show(frontmatter.context)}\` changes nothing — only \`fork\` is read, so the skill runs inline`,
      fix: 'Use `context: fork` or remove the key.',
    })
  }
  if (frontmatter.agent !== undefined && frontmatter.context !== 'fork') {
    findings.push({
      file,
      kind: 'bad_value',
      severity: 'warning',
      message: '`agent` is only used with `context: fork`; as written the skill runs inline in the current agent',
      fix: 'Add `context: fork`, or remove `agent`.',
    })
  }
  if (frontmatter.effort !== undefined && parseEffortValue(frontmatter.effort) === undefined) {
    findings.push({
      file,
      kind: 'bad_value',
      severity: 'warning',
      message: `\`effort: ${show(frontmatter.effort)}\` is not an effort level, so the session default applies`,
      fix: `Use one of ${EFFORT_LEVELS.join(', ')}, or an integer.`,
    })
  }
  if (frontmatter.arguments !== undefined && !isStringOrStringList(frontmatter.arguments)) {
    findings.push({
      file,
      kind: 'bad_value',
      severity: 'warning',
      message: '`arguments` must be a space-separated string or a list of plain strings — other entries are dropped and their `$name` never substitutes',
      fix: 'Write `arguments: name repo` or a YAML list of names, not objects.',
    })
  }
  for (const key of ['allowed-tools', 'paths']) {
    const value = frontmatter[key]
    if (value === undefined || value === null || isStringOrStringList(value)) continue
    findings.push({
      file,
      kind: 'bad_value',
      severity: 'warning',
      message:
        key === 'paths'
          ? '`paths` is not a string or a list of strings, so it is ignored and the skill loads unconditionally'
          : '`allowed-tools` is not a string or a list of strings, so no tool is pre-approved',
      fix: `Write \`${key}\` as a comma-separated string or a YAML list of strings.`,
    })
  }
  if (
    frontmatter.shell !== undefined &&
    frontmatter.shell !== null &&
    String(frontmatter.shell).trim() !== '' &&
    !FRONTMATTER_SHELLS.includes(String(frontmatter.shell).trim().toLowerCase())
  ) {
    findings.push({
      file,
      kind: 'bad_value',
      severity: 'warning',
      message: `\`shell: ${show(frontmatter.shell)}\` is not a known shell, so \`!\` blocks run in bash`,
      fix: 'Use `bash` or `powershell`.',
    })
  }
  if (frontmatter.hooks) {
    const result = HooksSchema().safeParse(frontmatter.hooks)
    if (!result.success) {
      const issue = result.error.issues[0]
      findings.push({
        file,
        kind: 'bad_value',
        severity: 'error',
        message: `\`hooks\` does not match the hooks schema, so none of them register${issue ? ` (${issue.path.join('.') || 'hooks'}: ${issue.message})` : ''}`,
        fix: 'Fix the shape — `/create hook` has the contract.',
      })
    }
  }

  const ownDescription = coerceDescriptionToString(frontmatter.description, name)
  const description = ownDescription ?? extractDescriptionFromMarkdown(body, 'Skill')
  if (ownDescription === null) {
    findings.push({
      file,
      kind: 'missing_description',
      severity: 'warning',
      message: `no \`description\`: the listing shows the first body line, ${JSON.stringify(description)}, and the model decides from that`,
      fix: 'Add a `description` that says what the skill does and when to use it.',
    })
  }

  const userInvocable =
    frontmatter['user-invocable'] === undefined
      ? true
      : parseBooleanFrontmatter(frontmatter['user-invocable'])
  const modelInvocable = !parseBooleanFrontmatter(frontmatter['disable-model-invocation'])
  const whenToUse =
    typeof frontmatter.when_to_use === 'string' ? frontmatter.when_to_use : undefined

  // SkillTool/prompt.ts getCommandDescription: `${description} - ${whenToUse}`,
  // cut at the cap. Bundled skills are exempt; files on disk never are.
  const listing = whenToUse ? `${description} - ${whenToUse}` : description
  if (modelInvocable && ownDescription !== null && listing.length > listingCap) {
    const whenToUseLost = whenToUse !== undefined && description.length + 3 >= listingCap
    findings.push({
      file,
      kind: 'listing_truncated',
      severity: 'warning',
      message: whenToUseLost
        ? `\`when_to_use\` never reaches the model: the listing cuts "description - when_to_use" at ${listingCap} chars and the description alone is ${description.length}`
        : `the model's skill listing cuts this entry at ${listingCap} chars (it is ${listing.length})`,
      fix: `Lead with the trigger and keep description + when_to_use under ${listingCap} chars; detail belongs in the body, which loads on invoke.`,
    })
  }

  if (!userInvocable && !modelInvocable) {
    findings.push({
      file,
      kind: 'unreachable',
      severity: 'error',
      message: 'neither the user (`user-invocable: false`) nor the model (`disable-model-invocation: true`) can invoke it',
      fix: 'Drop one of the two.',
    })
  }

  if (frontmatter.name !== undefined && frontmatter.name !== null) {
    const declared = String(frontmatter.name)
    const leaf = name.split(':').at(-1)
    if (declared !== name && declared !== leaf) {
      findings.push({
        file,
        kind: 'name_mismatch',
        severity: 'warning',
        message: `\`name: ${declared}\` is only a display name — the skill is invoked as \`/${name}\`, from its ${candidate.legacy ? 'file' : 'directory'} name`,
        fix: candidate.legacy
          ? `Rename the file, or set \`name:\` to \`${name}\`.`
          : `Rename the directory to \`${declared}\`, or set \`name:\` to \`${leaf}\`.`,
      })
    }
  }

  if (candidate.legacy) {
    findings.push({
      file,
      kind: 'legacy_command',
      severity: 'warning',
      message: 'loaded from the deprecated `commands/` directory',
      fix: `Move it to \`skills/${name.split(':').join('/')}/SKILL.md\`.`,
    })
  }

  return {
    name,
    file,
    scope: candidate.scope,
    legacy: candidate.legacy,
    description,
    hasDescription: ownDescription !== null,
    whenToUse,
    modelInvocable,
    userInvocable,
    conditional:
      frontmatter.paths !== undefined && frontmatter.paths !== null && frontmatter.paths !== '',
    mtimeMs,
  }
}

/**
 * Lookup is first-match over bundled skills, then skills on disk in loader
 * order, then the built-in commands (commands.ts loadAllCommands + findCommand),
 * so a name decides which of several definitions ever runs.
 */
function checkNames(
  skills: SkillLintEntry[],
  builtinNames: ReadonlySet<string>,
  bundledNames: ReadonlySet<string>,
  findings: SkillLintFinding[],
): void {
  const firstByName = new Map<string, SkillLintEntry>()
  for (const skill of skills) {
    if (bundledNames.has(skill.name)) {
      findings.push({
        file: skill.file,
        kind: 'shadowed_by_bundled',
        severity: 'error',
        message: `a bundled skill is also called \`/${skill.name}\` and is matched first — this one never runs`,
        fix: 'Rename the skill.',
      })
    } else if (builtinNames.has(skill.name)) {
      findings.push({
        file: skill.file,
        kind: 'shadows_builtin',
        severity: 'warning',
        message: `replaces the built-in \`/${skill.name}\` — typing \`/${skill.name}\` and the Skill tool both run this skill instead`,
        fix: 'Rename it, unless overriding the built-in is the point.',
      })
    }

    const first = firstByName.get(skill.name)
    if (!first) {
      firstByName.set(skill.name, skill)
      continue
    }
    findings.push({
      file: skill.file,
      kind: 'duplicate_name',
      severity: 'error',
      message: `\`/${skill.name}\` is also defined by ${first.file}, which is matched first — this one never runs`,
      fix: 'Rename one of them, or delete the copy.',
    })
  }
}

/**
 * Runs every skill-file health check for a project and the user scope.
 *
 * Never throws for a malformed or unreadable skill: a check that blocks the
 * user is worse than the rot it reports.
 */
export async function lintSkillFiles(
  options: LintSkillFilesOptions = {},
): Promise<SkillLintResult> {
  const fs = getFsImplementation()
  const root = options.root ?? fs.cwd()
  const configHome = options.configHome ?? getClaudinConfigHomeDir()
  const listingCap = options.listingCap ?? MAX_LISTING_DESC_CHARS

  const { candidates, ignored } = await discoverSkillFiles(root, configHome)
  const findings: SkillLintFinding[] = []
  const skills: SkillLintEntry[] = []

  for (const candidate of candidates) {
    let raw: string
    let mtimeMs: number
    try {
      raw = await fs.readFile(candidate.file, { encoding: 'utf8' })
      mtimeMs = (await fs.stat(candidate.file)).mtimeMs
    } catch (e: unknown) {
      logForDebugging(`[skillsLint] unreadable skill file ${candidate.file}: ${String(e)}`)
      continue
    }
    skills.push(checkFrontmatter(candidate, raw, mtimeMs, listingCap, findings))
  }

  for (const { file, dir } of ignored) {
    const stem = relative(dir, file).replace(MD_EXTENSION_RE, '')
    findings.push({
      file,
      kind: 'ignored_file',
      severity: 'warning',
      message: 'never loaded — the loader only reads a `SKILL.md` inside its own directory',
      fix: `Move it to \`skills/${stem}/SKILL.md\`, or next to the SKILL.md that reads it.`,
    })
  }

  checkNames(
    skills,
    options.builtinNames ?? new Set(),
    options.bundledNames ?? new Set(),
    findings,
  )

  return { findings, skills, filesChecked: candidates.length }
}
