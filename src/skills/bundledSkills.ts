/**
 * The registry of the skills that ship inside the CLI. Each module under
 * src/skills/bundled/ registers a definition at startup, and the command
 * registry lists the resulting prompt commands next to the skills on disk.
 *
 * A skill may carry reference files. They are written on its first
 * invocation, under a root whose reads the permission layer allows without a
 * prompt, so every file there has to be one this process created.
 */
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { constants as fsConstants } from 'fs'
import { mkdir, open } from 'fs/promises'
import { dirname, join, sep, win32 } from 'path'

import type { HooksSettings } from 'src/platform/settings/types.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'
import type { CommandBase, PromptCommand } from 'src/shared/types/command.js'
import { getBundledSkillsRoot } from 'src/skills/bundledSkillsRoot.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

export type BundledSkillDefinition = {
  name: string
  description: string
  aliases?: string[]
  whenToUse?: string
  argumentHint?: string
  allowedTools?: string[]
  model?: string
  disableModelInvocation?: boolean
  userInvocable?: boolean
  isEnabled?: () => boolean
  hooks?: HooksSettings
  context?: 'inline' | 'fork'
  agent?: string
  /** Contents keyed by a path relative to the skill's extraction directory. */
  files?: Record<string, string>
  getPromptForCommand: (
    args: string,
    context: ToolUseContext,
  ) => Promise<ContentBlockParam[]>
}

/**
 * A bundled skill is always a prompt command. Typing the registry that way
 * still satisfies every `Command[]` consumer, and spares callers a narrowing
 * step before they reach `getPromptForCommand` or `skillRoot`.
 */
type BundledSkillCommand = CommandBase & PromptCommand

/** The part of the command that depends on whether it has reference files. */
type SkillInvocation = Pick<PromptCommand, 'skillRoot' | 'getPromptForCommand'>

// -- The registry

const registry: BundledSkillCommand[] = []

export function registerBundledSkill(definition: BundledSkillDefinition): void {
  registry.push(toCommand(definition, invocationOf(definition)))
}

export function getBundledSkills(): BundledSkillCommand[] {
  return [...registry]
}

export function clearBundledSkills(): void {
  registry.length = 0
}

export function getBundledSkillExtractDir(skillName: string): string {
  return join(getBundledSkillsRoot(), skillName)
}

// -- The command a definition becomes

function toCommand(
  definition: BundledSkillDefinition,
  invocation: SkillInvocation,
): BundledSkillCommand {
  const userInvocable = definition.userInvocable ?? true
  return {
    type: 'prompt',
    name: definition.name,
    description: definition.description,
    hasUserSpecifiedDescription: true,
    aliases: definition.aliases,
    whenToUse: definition.whenToUse,
    argumentHint: definition.argumentHint,
    allowedTools: definition.allowedTools ?? [],
    model: definition.model,
    disableModelInvocation: definition.disableModelInvocation ?? false,
    userInvocable,
    isHidden: !userInvocable,
    isEnabled: definition.isEnabled,
    hooks: definition.hooks,
    context: definition.context,
    agent: definition.agent,
    contentLength: 0,
    source: 'bundled',
    loadedFrom: 'bundled',
    progressMessage: 'running',
    skillRoot: invocation.skillRoot,
    getPromptForCommand: invocation.getPromptForCommand,
  }
}

// -- Invoking a skill

function invocationOf(definition: BundledSkillDefinition): SkillInvocation {
  const files = definition.files ?? {}
  if (Object.keys(files).length === 0) {
    return {
      skillRoot: undefined,
      getPromptForCommand: definition.getPromptForCommand,
    }
  }
  const skillRoot = getBundledSkillExtractDir(definition.name)
  const extract = extractOnce(skillRoot, files)
  return {
    skillRoot,
    async getPromptForCommand(args, context) {
      const extracted = await extract()
      const blocks = await definition.getPromptForCommand(args, context)
      // After a failed write the directory may hold files someone else
      // planted, so the model is only pointed at one this process filled.
      return extracted ? announceBaseDirectory(skillRoot, blocks) : blocks
    },
  }
}

/** Merged into the prompt's first text block, or put ahead of it as one. */
function announceBaseDirectory(
  skillRoot: string,
  blocks: ContentBlockParam[],
): ContentBlockParam[] {
  const announcement = `Base directory for this skill: ${skillRoot}\n\n`
  const [first, ...rest] = blocks
  if (first?.type === 'text') {
    return [{ ...first, text: announcement + first.text }, ...rest]
  }
  return [{ type: 'text', text: announcement }, ...blocks]
}

// -- Extracting reference files

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600

// Exclusive create refuses whatever already sits at the path, a symlink
// included, so a planted file is never overwritten and a planted link never
// followed; O_NOFOLLOW guards the last component a second time. Windows gets
// the string form, because the numeric flags can fail there with EINVAL.
const CREATE_EXCLUSIVE =
  process.platform === 'win32'
    ? 'wx'
    : fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW

// Both separators count on every platform: a backslash that is an ordinary
// file-name character here is a separator on Windows.
const PATH_SEPARATOR_RE = /[\\/]/

/**
 * Extracts on the first call. Concurrent and later calls share that outcome,
 * so the files are written at most once per process and a failed write is not
 * retried.
 */
function extractOnce(
  skillRoot: string,
  files: Record<string, string>,
): () => Promise<boolean> {
  let outcome: Promise<boolean> | undefined
  return () => (outcome ??= extractReferenceFiles(skillRoot, files))
}

/**
 * Writes the files under the skill's directory and says whether that worked.
 * A failure is logged rather than thrown: the skill still runs, only without
 * its files.
 */
async function extractReferenceFiles(
  skillRoot: string,
  files: Record<string, string>,
): Promise<boolean> {
  const escaping = Object.keys(files).filter(key => !isInside(skillRoot, key))
  if (escaping.length > 0) {
    logForDebugging(
      `[skills] not extracting to ${skillRoot}: ${escaping.join(', ')} would land outside it`,
    )
    return false
  }
  try {
    for (const [key, content] of Object.entries(files)) {
      await writeOwnerOnlyFile(join(skillRoot, key), content)
    }
    return true
  } catch (error) {
    logForDebugging(
      `[skills] could not extract reference files to ${skillRoot}: ${errorMessage(error)}`,
    )
    return false
  }
}

/**
 * Whether a key names a file strictly inside the skill directory. Absolute
 * keys and `..` segments are refused as written rather than normalized first,
 * so no spelling of an escape has to be foreseen; win32 rules see a root in
 * `/x`, `\x` and `C:\x` alike.
 */
function isInside(skillRoot: string, key: string): boolean {
  if (win32.isAbsolute(key) || key.split(PATH_SEPARATOR_RE).includes('..')) {
    return false
  }
  return join(skillRoot, key).startsWith(skillRoot + sep)
}

async function writeOwnerOnlyFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: DIRECTORY_MODE })
  const handle = await open(path, CREATE_EXCLUSIVE, FILE_MODE)
  try {
    await handle.writeFile(content, 'utf8')
  } finally {
    await handle.close()
  }
}
